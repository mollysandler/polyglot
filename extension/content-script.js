/**
 * Content script: canvas frame-delay overlay with seek-back fallback.
 *
 * Primary mode (canvas overlay):
 *   1. Find <video>, hide it (opacity:0), overlay a <canvas>
 *   2. requestVideoFrameCallback captures frames into a ring buffer
 *   3. Draw frames delayed by pipeline latency — user sees delayed video
 *   4. Translated audio plays in sync with the delayed frames
 *
 * Fallback mode (seek-back):
 *   Used when DRM is detected (canvas draws black) or requestVideoFrameCallback
 *   is unavailable. Falls back to the simpler seek-back + rate adjustment approach.
 */
(function () {
  // Kill any previous instance (stale scripts survive extension reloads).
  // The previous instance's teardown function cleans up its canvas, observers,
  // and requestVideoFrameCallback loop so it stops interfering.
  if (window.__liveTranslatorV2Teardown) {
    try { window.__liveTranslatorV2Teardown(); } catch (e) {}
  }

  // Debug flag — flip to true to enable [content] traces. Off by default to
  // keep the console quiet on real video pages where logs would be noisy.
  const CONTENT_DEBUG = false;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let video = null;
  let observer = null;
  let pendingOverlayText = null;

  // Overlay / buffering UI
  let overlayEl = null;
  let overlayTextEl = null;
  let overlayProgressEl = null;

  // Canvas overlay mode
  let syncMode = null; // "canvas" or "seekback" — determined by DRM detection
  let canvasEl = null;
  let canvasCtx = null;
  let frameBuffer = []; // [{bitmap: ImageBitmap, time: number}]
  let delayFrames = 0; // how many frames to buffer before drawing
  let rvfcId = null; // requestVideoFrameCallback handle
  let resizeObs = null;
  let canvasActive = false;  // capturing frames into buffer
  let drawingActive = false; // drawing delayed frames (starts when audio playback begins)
  let drmVerified = false;
  let drmBlackFrames = 0; // consecutive all-black frames seen during DRM check
  let targetDelaySec = 3;

  // Re-buffer state (late speaker detection)
  let isRebuffering = false;

  // Seek-back fallback mode
  let extensionPaused = false;
  let userPaused = false;

  // Guards to distinguish extension-triggered pause/play from user-triggered
  let extensionTriggeredPause = false;
  let extensionTriggeredPlay = false;

  // Listener refs so teardown can detach them. Without these, re-injection
  // stacks onMessage handlers and leaves stale pause/play listeners on the
  // video element that send spurious USER_PAUSED_VIDEO messages with
  // stale closure state.
  let messageListener = null;
  let pauseHandler = null;
  let playHandler = null;
  let waitingHandler = null;
  let playingHandler = null;
  let rateChangeHandler = null;

  // Tracks whether offscreen has been told the video is stalled, so we only
  // send one STALL_START/STALL_END pair per stall rather than one per event.
  let stallReported = false;

  const MAX_BUFFER_FRAMES = 300; // hard cap (~10s at 30fps — must accommodate full pipeline delay)
  const CANVAS_SCALE = 480; // capture height (lower = less memory, 300 frames at 480p ≈ 500MB)

  // Canvas pool: reuse capture canvases instead of creating/GC-ing 30/sec
  let canvasPool = [];

  // -------------------------------------------------------------------------
  // Video discovery
  // -------------------------------------------------------------------------

  // Tunable: minimum video display width. Filters out hover-preview thumbnails
  // on social/feed sites (Twitter, Instagram, etc.) which can autoplay briefly
  // and otherwise win the "largest non-playing" race.
  const MIN_VIDEO_WIDTH = 320;

  function findVideo() {
    const all = Array.from(document.querySelectorAll("video"));
    if (all.length === 0) return null;
    // Prefer a currently-playing video at any size — playback is the strongest
    // signal that this is the user's content (not an idle thumbnail).
    const playing = all.find((v) => !v.paused && !v.ended && v.videoWidth >= 240);
    if (playing) return playing;
    // Otherwise apply the size floor to skip preview thumbnails.
    const candidates = all.filter((v) => v.videoWidth >= MIN_VIDEO_WIDTH);
    if (candidates.length === 0) return null;
    return candidates.sort(
      (a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight
    )[0];
  }

  // After this many ms with no video found, give up — observing all DOM
  // mutations on document.body is expensive and pointless on no-video pages.
  // The user can re-trigger discovery by navigating; popstate/hashchange
  // re-runs init() for SPAs.
  const VIDEO_DISCOVERY_TIMEOUT_MS = 10000;
  let observerTimeout = null;
  let popstateHandler = null;
  let hashchangeHandler = null;

  function init() {
    video = findVideo();
    if (video) {
      onVideoFound();
    } else {
      observer = new MutationObserver(() => {
        const found = findVideo();
        if (found) {
          if (observer) { observer.disconnect(); observer = null; }
          if (observerTimeout) { clearTimeout(observerTimeout); observerTimeout = null; }
          video = found;
          onVideoFound();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      observerTimeout = setTimeout(() => {
        if (observer) { observer.disconnect(); observer = null; }
        observerTimeout = null;
        if (!video) sendMsg({ type: "VIDEO_NOT_FOUND" });
      }, VIDEO_DISCOVERY_TIMEOUT_MS);
      sendMsg({ type: "VIDEO_NOT_FOUND" });
    }

    // SPA navigation can swap the <video> node (e.g. Twitch clip-from-chat).
    // popstate/hashchange let us re-run discovery without a full page load.
    // Guarded so test sandboxes that pass a bare `window: {}` don't blow up.
    if (!popstateHandler && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      popstateHandler = () => onSpaNavigate();
      hashchangeHandler = () => onSpaNavigate();
      window.addEventListener("popstate", popstateHandler);
      window.addEventListener("hashchange", hashchangeHandler);
    }
  }

  function onSpaNavigate() {
    // Re-check whether the current `video` is still attached. If not, or if
    // the URL changed and a new <video> appeared, re-bind to the new one.
    const found = findVideo();
    if (!found) return;
    if (found === video) return;
    // Detach from the old video first (its event listeners would otherwise
    // stay attached to a now-detached node and never fire).
    detachVideoListeners();
    video = found;
    onVideoFound();
  }

  function detachVideoListeners() {
    if (!video) return;
    if (pauseHandler) video.removeEventListener("pause", pauseHandler);
    if (playHandler) video.removeEventListener("play", playHandler);
    if (waitingHandler) video.removeEventListener("waiting", waitingHandler);
    if (playingHandler) video.removeEventListener("playing", playingHandler);
    if (rateChangeHandler) video.removeEventListener("ratechange", rateChangeHandler);
    pauseHandler = null;
    playHandler = null;
    waitingHandler = null;
    playingHandler = null;
    rateChangeHandler = null;
  }

  function onVideoFound() {
    bindPauseDetection(video);
    if (pendingOverlayText) createOverlay(pendingOverlayText);
    sendMsg({ type: "VIDEO_FOUND", currentTime: video.currentTime });
  }

  function bindPauseDetection(v) {
    pauseHandler = () => {
      if (extensionTriggeredPause) {
        extensionTriggeredPause = false;
        return;
      }
      if (!extensionPaused) {
        userPaused = true;
        sendMsg({ type: "USER_PAUSED_VIDEO" });
      }
    };
    playHandler = () => {
      if (extensionTriggeredPlay) {
        extensionTriggeredPlay = false;
        userPaused = false;
        return;
      }
      // User manually resumed (either overriding extension pause or their own pause)
      if (userPaused || extensionPaused) {
        userPaused = false;
        extensionPaused = false;
        sendMsg({ type: "USER_RESUMED_VIDEO" });
      }
      userPaused = false;
    };
    v.addEventListener("pause", pauseHandler);
    v.addEventListener("play", playHandler);

    // Network stall: video fires "waiting" when it can't keep up, "playing"
    // when it recovers. Without these, translated audio continues over a
    // frozen video and the two drift apart permanently.
    waitingHandler = () => {
      if (!stallReported && !userPaused && !extensionPaused) {
        stallReported = true;
        sendMsg({ type: "VIDEO_STALLED" });
      }
    };
    playingHandler = () => {
      if (stallReported) {
        stallReported = false;
        sendMsg({ type: "VIDEO_RESUMED_PLAYING" });
      }
    };
    v.addEventListener("waiting", waitingHandler);
    v.addEventListener("playing", playingHandler);

    // In canvas mode the frame buffer drains at the video's playback rate
    // while translated audio plays at 1x — any user-initiated rate change
    // (YouTube's > / < keys, etc.) would cause permanent drift. Clamp to 1.0.
    // In seekback mode we legitimately change rate for drift correction, so
    // gate on syncMode.
    rateChangeHandler = () => {
      if (syncMode === "canvas" && v.playbackRate !== 1.0) {
        v.playbackRate = 1.0;
      }
    };
    v.addEventListener("ratechange", rateChangeHandler);
  }

  function sendMsg(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // DRM detection
  // -------------------------------------------------------------------------

  // Heuristic DRM check. `video.mediaKeys` is unreliable — it's frequently
  // null at the moment we look (EME negotiation hasn't finished yet). To
  // reduce time-to-fallback on Netflix-style players we also probe whether
  // the host has used `requestMediaKeySystemAccess` recently. The frame-
  // content verification in onVideoFrame is still the source of truth; this
  // just biases the fast path toward seekback when DRM is likely.
  function detectDRM() {
    if (!video) return true;
    if (!video.requestVideoFrameCallback) return true;
    if (video.mediaKeys) return true;
    try {
      // Some sites set `MediaSource` on a hidden encrypted track; missing
      // `canPlayType` for HLS/DASH is a reasonable EME indicator but noisy,
      // so we only flag if the page has explicitly registered MediaKeys.
      if (window.__lt_drmHinted) return true;
    } catch (_) {}
    return false;
  }

  // Lightweight EME observation: hook requestMediaKeySystemAccess once so
  // future detectDRM() calls have a definitive answer. Idempotent.
  if (typeof navigator !== "undefined" && navigator.requestMediaKeySystemAccess) {
    try {
      const orig = navigator.requestMediaKeySystemAccess.bind(navigator);
      if (!navigator.__lt_emePatched) {
        navigator.requestMediaKeySystemAccess = function (...args) {
          window.__lt_drmHinted = true;
          return orig(...args);
        };
        navigator.__lt_emePatched = true;
      }
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Canvas overlay mode
  // -------------------------------------------------------------------------

  let hideStyleEl = null;

  function startCanvasMode() {
    syncMode = "canvas";
    sendMsg({ type: "SYNC_MODE", mode: "canvas" });

    const parent = video.parentElement || document.body;

    // Create canvas, sized to match video display area
    canvasEl = document.createElement("canvas");
    canvasEl.id = "__live-translator-canvas";
    canvasCtx = canvasEl.getContext("2d");

    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }

    // Size canvas drawing buffer AND CSS display to match the video's layout.
    // CRITICAL: Do NOT use CSS `width: 100%; height: 100%` — on YouTube,
    // the parent's content box can differ from the video's display area,
    // causing the drawing buffer and CSS size to mismatch. This makes
    // drawn content appear at wrong positions or be invisible.
    const videoRect = video.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const cssW = Math.round(Math.min(videoRect.width, 1920));
    const cssH = Math.round(Math.min(videoRect.height, 1080));
    canvasEl.width = cssW;
    canvasEl.height = cssH;
    canvasEl.style.cssText = `
      position: absolute;
      top: ${Math.round(videoRect.top - parentRect.top)}px;
      left: ${Math.round(videoRect.left - parentRect.left)}px;
      width: ${cssW}px;
      height: ${cssH}px;
      z-index: 999998;
      pointer-events: none;
    `;

    parent.appendChild(canvasEl);
    resizeObs = new ResizeObserver(resizeCanvas);
    resizeObs.observe(video);
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    // Hide original video via CSS rule with !important — YouTube's player JS
    // periodically resets inline styles on the video element, so a plain
    // video.style.opacity = "0" gets overridden within milliseconds.
    video.classList.add("__lt-hidden");
    if (!hideStyleEl) {
      hideStyleEl = document.createElement("style");
      hideStyleEl.id = "__live-translator-hide-style";
      hideStyleEl.textContent = "video.__lt-hidden { opacity: 0 !important; }";
      (document.head || document.documentElement).appendChild(hideStyleEl);
    }

    // Compute frame delay from target latency
    updateDelayFrames();

    // Start capturing frames
    canvasActive = true;
    requestFrame();
  }

  function handleFullscreenChange() {
    // In fullscreen, the browser promotes a specific element (e.g. YouTube's
    // #movie_player) — the canvas needs to be INSIDE that subtree or it won't
    // render. Re-parent into the fullscreen element on entry, and back to
    // the video's parent on exit.
    if (!canvasEl) return;
    const fs = document.fullscreenElement;
    if (fs && !fs.contains(canvasEl)) {
      if (getComputedStyle(fs).position === "static") {
        fs.style.position = "relative";
      }
      fs.appendChild(canvasEl);
    } else if (!fs && video && video.parentElement && !video.parentElement.contains(canvasEl)) {
      video.parentElement.appendChild(canvasEl);
    }
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvasEl || !video) return;
    const videoRect = video.getBoundingClientRect();
    const w = Math.round(Math.min(videoRect.width, 1920));
    const h = Math.round(Math.min(videoRect.height, 1080));
    // Don't resize to zero — but if the canvas is CURRENTLY zero (started
    // before the video was laid out), allow the ResizeObserver to recover
    // it once the video gets real dimensions.
    if (w === 0 || h === 0) return;
    if (canvasEl.width === w && canvasEl.height === h) return;
    canvasEl.width = w;
    canvasEl.height = h;
    // Also update CSS dimensions to match (keeps drawing buffer and display in sync)
    canvasEl.style.width = w + "px";
    canvasEl.style.height = h + "px";
    const parent = canvasEl.parentElement;
    if (parent) {
      const parentRect = parent.getBoundingClientRect();
      canvasEl.style.top = Math.round(videoRect.top - parentRect.top) + "px";
      canvasEl.style.left = Math.round(videoRect.left - parentRect.left) + "px";
    }
  }

  function updateDelayFrames() {
    // Estimate FPS from video (default 30)
    const fps = 30;
    delayFrames = Math.max(1, Math.ceil(targetDelaySec * fps));
    // Don't exceed hard cap
    if (delayFrames > MAX_BUFFER_FRAMES) delayFrames = MAX_BUFFER_FRAMES;
  }

  function drawBufferingOverlay() {
    if (!canvasCtx || !canvasEl) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    canvasCtx.fillStyle = "rgba(0, 0, 0, 0.5)";
    canvasCtx.fillRect(0, 0, w, h);
    const fontSize = Math.max(16, Math.round(h / 25));
    canvasCtx.fillStyle = "white";
    canvasCtx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    canvasCtx.textAlign = "center";
    canvasCtx.textBaseline = "middle";
    canvasCtx.fillText("Buffering translation\u2026", w / 2, h / 2);
  }

  function drawRebufferOverlay() {
    if (!canvasCtx || !canvasEl) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    canvasCtx.fillStyle = "rgba(0, 0, 0, 0.4)";
    canvasCtx.fillRect(0, 0, w, h);
    const fontSize = Math.max(14, Math.round(h / 30));
    canvasCtx.fillStyle = "white";
    canvasCtx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    canvasCtx.textAlign = "center";
    canvasCtx.textBaseline = "middle";
    canvasCtx.fillText("New speaker detected \u2014 analyzing voice\u2026", w / 2, h / 2);
  }

  function requestFrame() {
    if (!canvasActive || !video) return;
    rvfcId = video.requestVideoFrameCallback(onVideoFrame);
  }

  // Frame counter for periodic logging
  let frameCount = 0;

  function onVideoFrame(now, metadata) {
    if (!canvasActive || !video) { requestFrame(); return; }
    if (video.videoWidth === 0 || video.videoHeight === 0) { requestFrame(); return; }
    if (!canvasCtx || !canvasEl) { requestFrame(); return; }
    if (canvasEl.width === 0 || canvasEl.height === 0) {
      // Canvas started at 0x0 (video wasn't laid out yet). Try to recover
      // now that we're getting frame callbacks (video is playing).
      resizeCanvas();
      if (canvasEl.width === 0 || canvasEl.height === 0) { requestFrame(); return; }
    }

    frameCount++;

    // ---- Step 1: Draw video DIRECTLY to display canvas ----
    // This is the primary render path. Drawing directly from the video element
    // to the display canvas avoids intermediate-canvas issues (GPU texture sync,
    // canvas clearing, pool recycling). The user always sees the video.
    canvasCtx.drawImage(video, 0, 0, canvasEl.width, canvasEl.height);

    // ---- Step 2: Buffer frames for delay mechanism ----
    // Capture a snapshot for the frame buffer using createImageBitmap (GPU-safe)
    // or a pooled canvas as fallback. The buffer enables showing delayed frames.
    const aspect = video.videoWidth / video.videoHeight;
    const captureH = Math.min(video.videoHeight, CANVAS_SCALE);
    const captureW = Math.round(aspect * captureH);

    const frameCanvas = canvasPool.length > 0 ? canvasPool.pop() : document.createElement("canvas");
    if (frameCanvas.width !== captureW || frameCanvas.height !== captureH) {
      frameCanvas.width = captureW;
      frameCanvas.height = captureH;
    }
    const frameCtx = frameCanvas._cachedCtx || (frameCanvas._cachedCtx = frameCanvas.getContext("2d"));
    frameCtx.drawImage(video, 0, 0, captureW, captureH);
    frameBuffer.push({ canvas: frameCanvas, time: metadata.mediaTime });

    // ---- Step 3: If drawing delayed frames, overwrite the direct draw ----
    // BUG-012: gate the drain on delayFrames so the buffer can grow/shrink to
    // match a changing target (e.g. SET_DELAY mid-playback). Always keep at
    // least 1 frame so we never read from an empty buffer.
    const minBufferToDrain = Math.max(1, delayFrames);
    if (drawingActive && frameBuffer.length > minBufferToDrain) {
      const old = frameBuffer.shift();
      // Draw the delayed frame on top of the direct draw.
      // If the buffer frame has real content, it covers the live frame.
      // If it's blank (GPU issue), the live video from Step 1 shows through.
      canvasCtx.drawImage(old.canvas, 0, 0, canvasEl.width, canvasEl.height);
      canvasPool.push(old.canvas);
    } else if (!drawingActive) {
      drawBufferingOverlay();
    }

    // ---- Step 3b: Draw rebuffer overlay on top of delayed frames ----
    if (isRebuffering && drawingActive) {
      drawRebufferOverlay();
    }

    // ---- Step 4: Hard cap ----
    while (frameBuffer.length > MAX_BUFFER_FRAMES) {
      const discarded = frameBuffer.shift();
      canvasPool.push(discarded.canvas);
    }

    // ---- Step 5: Verify canvas is actually rendering (frame 15) ----
    // Check the DISPLAY canvas for real pixels. If blank after 15 frames,
    // drawImage(video) is broken (GPU decode issue) — fall back to seekback.
    if (frameCount === 15 && !drmVerified) {
      try {
        const cx = Math.floor(canvasEl.width / 2);
        const cy = Math.floor(canvasEl.height / 2);
        const px = canvasCtx.getImageData(cx - 4, cy - 4, 8, 8).data;
        let hasContent = false;
        let allBlack = true;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] > 0) hasContent = true; // not transparent
          if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16) allBlack = false;
          if (hasContent && !allBlack) break;
        }
        if (!hasContent) {
          // Canvas is transparent — drawImage(video) is broken
          if (CONTENT_DEBUG) console.log("[content] Canvas is transparent after 15 frames — drawImage not working, trying seekback");
          drmVerified = true;
          stopCanvasMode();
          startSeekbackMode();
          return;
        }
        if (hasContent && !allBlack) {
          drmVerified = true;
          if (CONTENT_DEBUG) console.log("[content] Canvas rendering verified — video frames OK");
        }
        // If allBlack, continue checking on subsequent frames (might be dark scene)
      } catch (e) {
        // getImageData threw — canvas is tainted (cross-origin). Pixels ARE there.
        drmVerified = true;
        if (CONTENT_DEBUG) console.log("[content] Canvas tainted (cross-origin) — rendering OK");
      }
    }

    // ---- Step 6: DRM check (frames 15-30, only if not yet verified) ----
    if (frameCount > 15 && frameCount <= 30 && !drmVerified) {
      try {
        const cx = Math.floor(canvasEl.width / 2);
        const cy = Math.floor(canvasEl.height / 2);
        const px = canvasCtx.getImageData(cx - 4, cy - 4, 8, 8).data;
        let allBlack = true;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16) { allBlack = false; break; }
        }
        if (allBlack) {
          drmBlackFrames++;
          if (drmBlackFrames >= 5) {
            drmVerified = true;
            if (CONTENT_DEBUG) console.log("[content] DRM detected (5 consecutive black frames) — falling back to seekback");
            stopCanvasMode();
            startSeekbackMode();
            return;
          }
        } else {
          drmVerified = true;
          drmBlackFrames = 0;
          if (CONTENT_DEBUG) console.log("[content] Canvas rendering verified — not DRM");
        }
      } catch (e) {
        drmVerified = true;
      }
    }

    // After frame 30, stop checking regardless
    if (frameCount > 30 && !drmVerified) {
      drmVerified = true;
    }

    requestFrame();
  }

  function stopCanvasMode() {
    canvasActive = false;
    drawingActive = false;
    drmVerified = false;
    drmBlackFrames = 0;
    frameCount = 0;
    if (rvfcId !== null && video && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(rvfcId);
      rvfcId = null;
    }
    frameBuffer = [];
    canvasPool = [];
    if (canvasEl) { canvasEl.remove(); canvasEl = null; canvasCtx = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    document.removeEventListener("fullscreenchange", handleFullscreenChange);
    if (video) {
      video.classList.remove("__lt-hidden");
      video.style.opacity = "";
    }
    if (hideStyleEl) { hideStyleEl.remove(); hideStyleEl = null; }
  }

  // -------------------------------------------------------------------------
  // Seek-back fallback mode
  // -------------------------------------------------------------------------

  function startSeekbackMode() {
    syncMode = "seekback";
    sendMsg({ type: "SYNC_MODE", mode: "seekback" });
  }

  function handleSeekback(seekBackSec) {
    if (!video) return;
    extensionPaused = true;
    userPaused = false;
    video.currentTime = Math.max(0, video.currentTime - seekBackSec);
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      userPaused = false;
      video.play().catch(() => {});
    };
    video.addEventListener("seeked", onSeeked);
    let attempts = 0;
    const guard = setInterval(() => {
      attempts++;
      if (!video) { clearInterval(guard); return; }
      userPaused = false;
      if (video.paused) video.play().catch(() => {});
      if (!video.paused || attempts >= 10) {
        clearInterval(guard);
        extensionPaused = false;
      }
    }, 500);
  }

  // -------------------------------------------------------------------------
  // Overlay management (used during buffer phase in both modes)
  // -------------------------------------------------------------------------

  function createOverlay(text) {
    removeOverlay();
    if (!video) { pendingOverlayText = text; return; }
    pendingOverlayText = null;

    const parent = video.parentElement || document.body;
    overlayEl = document.createElement("div");
    overlayEl.id = "__live-translator-overlay";
    overlayEl.style.cssText = `
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.6);
      z-index: 999999;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    overlayTextEl = document.createElement("div");
    overlayTextEl.style.cssText = `
      color: white; font-size: 18px; font-weight: 600;
      text-shadow: 0 2px 4px rgba(0,0,0,0.5);
      margin-bottom: 12px;
    `;
    overlayTextEl.textContent = text || "Buffering translation...";
    overlayProgressEl = document.createElement("div");
    overlayProgressEl.style.cssText = `
      width: 200px; height: 4px;
      background: rgba(255,255,255,0.2);
      border-radius: 2px; overflow: hidden;
    `;
    const bar = document.createElement("div");
    bar.id = "__live-translator-progress-bar";
    bar.style.cssText = `
      width: 0%; height: 100%;
      background: #3b82f6; border-radius: 2px;
      transition: width 0.3s ease;
    `;
    overlayProgressEl.appendChild(bar);
    overlayEl.appendChild(overlayTextEl);
    overlayEl.appendChild(overlayProgressEl);

    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(overlayEl);
  }

  function updateOverlay(text, progress) {
    if (overlayTextEl) overlayTextEl.textContent = text;
    const bar = document.getElementById("__live-translator-progress-bar");
    if (bar) bar.style.width = `${progress}%`;
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; overlayTextEl = null; overlayProgressEl = null; }
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  messageListener = (msg, _sender, sendResponse) => {
    if (!video && msg.type !== "VIDEO_CLEANUP") {
      video = findVideo();
    }

    switch (msg.type) {
      // --- Sync mode initialization ---
      case "START_SYNC":
        // Offscreen tells us to begin. Detect DRM and choose mode.
        if (video) {
          const isDRM = detectDRM();
          if (isDRM) {
            startSeekbackMode();
          } else {
            startCanvasMode();
          }
        }
        sendResponse({ ok: !!video, mode: syncMode });
        break;

      case "SET_DELAY":
        // Offscreen measured pipeline latency — update canvas delay
        targetDelaySec = msg.delaySec || 3;
        updateDelayFrames();
        sendResponse({ ok: true });
        break;

      // --- Pause / Resume from side panel ---
      case "PAUSE_ALL":
        extensionPaused = true;
        if (video && !video.paused) {
          extensionTriggeredPause = true;
          video.pause();
        }
        sendResponse({ ok: true });
        break;

      case "RESUME_ALL":
        extensionPaused = false;
        userPaused = false;
        if (video && video.paused) {
          extensionTriggeredPlay = true;
          video.play().catch(() => {});
        }
        sendResponse({ ok: true });
        break;

      // --- Seek-back fallback commands ---
      case "VIDEO_SEEK_BACK":
        handleSeekback(msg.seekBackSec);
        sendResponse({ ok: !!video });
        break;

      case "VIDEO_ADJUST_RATE":
        if (video && syncMode === "seekback") {
          extensionPaused = true;
          video.playbackRate = msg.rate;
          let count = 0;
          const guard = setInterval(() => {
            count++;
            if (video && video.playbackRate !== msg.rate) video.playbackRate = msg.rate;
            if (count >= 10) { clearInterval(guard); extensionPaused = false; }
          }, 200);
          setTimeout(() => {
            if (video && video.paused) { userPaused = false; video.play().catch(() => {}); }
          }, 300);
        }
        sendResponse({ ok: !!video });
        break;

      case "VIDEO_REPORT_TIME":
        sendResponse({
          ok: !!video,
          currentTime: video ? video.currentTime : null,
          playbackRate: video ? video.playbackRate : null,
          paused: video ? video.paused : true,
        });
        break;

      // --- Overlay commands (both modes) ---
      case "SHOW_OVERLAY":
        createOverlay(msg.text);
        sendResponse({ ok: true });
        break;

      case "UPDATE_OVERLAY":
        updateOverlay(msg.text, msg.progress);
        sendResponse({ ok: true });
        break;

      case "HIDE_OVERLAY":
        removeOverlay();
        sendResponse({ ok: true });
        break;

      case "PLAYBACK_STARTED":
        // Audio playback has begun — start drawing delayed frames.
        // BUG-013: drop frames older than the first utterance's video time
        // so a long leading-silence prefix doesn't create permanent desync.
        // The first audio payload corresponds to t = audioStartSec, so any
        // buffered frame whose mediaTime is earlier than that is content the
        // user already heard nothing for and should not see drawn.
        if (syncMode === "canvas") {
          if (typeof msg.audioStartSec === "number" && msg.audioStartSec > 0 && frameBuffer.length > 0) {
            const cutoff = msg.audioStartSec;
            // Find first frame at or after cutoff; recycle everything before.
            let drop = 0;
            while (drop < frameBuffer.length && frameBuffer[drop].time < cutoff) drop++;
            if (drop > 0) {
              const dropped = frameBuffer.splice(0, drop);
              for (const f of dropped) canvasPool.push(f.canvas);
            }
          }
          drawingActive = true;
          if (CONTENT_DEBUG) console.log(
            `[content] Canvas drawing activated.`,
            `Buffer: ${frameBuffer.length} frames`,
            `(~${(frameBuffer.length / 30).toFixed(1)}s delay)`
          );
        }
        sendResponse({ ok: true });
        break;

      // --- Re-buffer for late speakers ---
      case "REBUFFER_START":
        isRebuffering = true;
        if (syncMode === "seekback" && video && !video.paused) {
          extensionTriggeredPause = true;
          extensionPaused = true;
          video.pause();
        }
        // Canvas mode: drawRebufferOverlay() is called in onVideoFrame loop
        // Seekback mode: show DOM overlay
        if (syncMode === "seekback") {
          createOverlay("New speaker detected \u2014 analyzing voice...");
        }
        sendResponse({ ok: true });
        break;

      case "REBUFFER_END":
        isRebuffering = false;
        if (syncMode === "seekback") {
          removeOverlay();
          if (video && video.paused && extensionPaused) {
            extensionTriggeredPlay = true;
            extensionPaused = false;
            video.play().catch(() => {});
          }
        }
        sendResponse({ ok: true });
        break;

      // --- Cleanup ---
      case "VIDEO_CLEANUP":
        if (window.__liveTranslatorV2Teardown) {
          window.__liveTranslatorV2Teardown();
        }
        userPaused = false;
        extensionPaused = false;
        isRebuffering = false;
        sendResponse({ ok: true });
        break;
    }
  };
  chrome.runtime.onMessage.addListener(messageListener);

  // Register teardown so the NEXT injection can kill this instance cleanly.
  // This handles: extension reloads (old VMs survive), re-injection on SPA nav,
  // and multiple Start clicks without Stop in between.
  window.__liveTranslatorV2Teardown = function () {
    stopCanvasMode();
    removeOverlay();
    if (observer) { observer.disconnect(); observer = null; }
    if (observerTimeout) { clearTimeout(observerTimeout); observerTimeout = null; }
    if (popstateHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("popstate", popstateHandler);
    }
    popstateHandler = null;
    if (hashchangeHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("hashchange", hashchangeHandler);
    }
    hashchangeHandler = null;
    if (messageListener) {
      chrome.runtime.onMessage.removeListener(messageListener);
      messageListener = null;
    }
    if (video) {
      if (pauseHandler) video.removeEventListener("pause", pauseHandler);
      if (playHandler) video.removeEventListener("play", playHandler);
      if (waitingHandler) video.removeEventListener("waiting", waitingHandler);
      if (playingHandler) video.removeEventListener("playing", playingHandler);
      if (rateChangeHandler) video.removeEventListener("ratechange", rateChangeHandler);
      video.playbackRate = 1.0;
      video.classList.remove("__lt-hidden");
      video.style.opacity = "";
    }
    pauseHandler = null;
    playHandler = null;
    waitingHandler = null;
    playingHandler = null;
    rateChangeHandler = null;
    stallReported = false;
    video = null;
    syncMode = null;
    canvasActive = false;
    drawingActive = false;
    isRebuffering = false;
    extensionTriggeredPause = false;
    extensionTriggeredPlay = false;
  };

  init();
})();
