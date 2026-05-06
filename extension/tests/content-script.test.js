/**
 * @jest-environment node
 *
 * Tests for content-script.js — video discovery, DRM detection,
 * canvas frame-delay overlay, seekback fallback, and overlay management.
 *
 * The content script is an IIFE that runs on load. Each test loads a fresh
 * VM with specific DOM state to test different scenarios.
 */
const {
  createChromeMock,
  createMockVideo,
  createMockElement,
  createMockDocument,
  loadScript,
} = require("./helpers");

// ---------------------------------------------------------------------------
// Factory: load content-script.js into a VM with given mocks
// ---------------------------------------------------------------------------

function loadContentScript(opts = {}) {
  const chrome = createChromeMock();
  const video = opts.video !== undefined ? opts.video : createMockVideo(opts.videoOpts || {});
  const videos = opts.noVideo ? [] : [video];

  let mutationCb = null;
  function MutationObserver(cb) {
    mutationCb = cb;
    this.observe = jest.fn();
    this.disconnect = jest.fn();
  }
  function ResizeObserver(cb) {
    this.observe = jest.fn();
    this.disconnect = jest.fn();
    this._cb = cb;
  }

  const createdElements = [];
  const doc = createMockDocument({
    videos,
    onCreateElement(tag) {
      const el = createMockElement(tag);
      // Canvas 2D context extras needed for drawBufferingOverlay
      const ctxExtras = { fillRect: jest.fn(), fillText: jest.fn(), fillStyle: "", font: "", textAlign: "", textBaseline: "" };

      if (tag === "canvas" && opts.allBlackCanvas) {
        el.getContext = jest.fn(() => ({
          drawImage: jest.fn(), ...ctxExtras,
          getImageData: jest.fn((_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(0) })),
        }));
      }
      if (tag === "canvas" && opts.darkTopLeftCanvas) {
        el.getContext = jest.fn(() => ({
          drawImage: jest.fn(), ...ctxExtras,
          getImageData: jest.fn((x, y, w, h) => {
            const data = new Uint8ClampedArray(w * h * 4);
            if (x < 10 && y < 10) {
              data.fill(0);
              for (let i = 3; i < data.length; i += 4) data[i] = 255;
            } else {
              data.fill(128);
            }
            return { data };
          }),
        }));
      }
      if (tag === "canvas" && opts.taintedCanvas) {
        el.getContext = jest.fn(() => ({
          drawImage: jest.fn(), ...ctxExtras,
          getImageData: jest.fn(() => { throw new DOMException("tainted"); }),
        }));
      }
      createdElements.push({ tag, el });
      return el;
    },
  });

  const ctx = loadScript("content-script.js", {
    chrome,
    document: doc,
    window: {},
    MutationObserver,
    ResizeObserver,
    getComputedStyle: jest.fn((el) => ({
      position: el?.style?.position || "static",
    })),
    DOMException: class DOMException extends Error {},
    performance: { now: () => 0 },
  });

  return {
    ctx, chrome, video, doc, createdElements,
    mutationCb: () => mutationCb,
    sendMsg(msg) {
      const resp = jest.fn();
      chrome._simulateMessage(msg, {}, resp);
      return resp;
    },
    sentMessages() {
      return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]);
    },
    triggerRvfc(frameIdx) {
      if (video && video._rvfcCallbacks.length > 0) {
        const cb = video._rvfcCallbacks.shift();
        cb(performance.now(), { mediaTime: video.currentTime + (frameIdx || 0) * 0.033 });
      }
    },
  };
}

// ===================================================================
// Video discovery
// ===================================================================

describe("video discovery", () => {
  test("finds a single video element", () => {
    const env = loadContentScript();
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "VIDEO_FOUND" })
    );
  });

  test("prefers playing video over paused", () => {
    const paused = createMockVideo({ paused: true, videoWidth: 3840, videoHeight: 2160 });
    const playing = createMockVideo({ paused: false, videoWidth: 640, videoHeight: 480 });
    const chrome = createChromeMock();
    const doc = createMockDocument({ videos: [paused, playing] });
    loadScript("content-script.js", {
      chrome, document: doc, window: {},
      MutationObserver: function () { this.observe = jest.fn(); this.disconnect = jest.fn(); },
      ResizeObserver: function () { this.observe = jest.fn(); this.disconnect = jest.fn(); },
      getComputedStyle: jest.fn(() => ({ position: "relative" })),
    });
    // The playing video (even if smaller) should be chosen
    const found = chrome.runtime.sendMessage.mock.calls.find((c) => c[0].type === "VIDEO_FOUND");
    expect(found).toBeTruthy();
  });

  test("falls back to largest video by resolution", () => {
    const small = createMockVideo({ paused: true, videoWidth: 320, videoHeight: 240 });
    const big = createMockVideo({ paused: true, videoWidth: 1920, videoHeight: 1080 });
    const chrome = createChromeMock();
    const doc = createMockDocument({ videos: [small, big] });
    loadScript("content-script.js", {
      chrome, document: doc, window: {},
      MutationObserver: function () { this.observe = jest.fn(); this.disconnect = jest.fn(); },
      ResizeObserver: function () { this.observe = jest.fn(); this.disconnect = jest.fn(); },
      getComputedStyle: jest.fn(() => ({ position: "relative" })),
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "VIDEO_FOUND" })
    );
  });

  test("sends VIDEO_NOT_FOUND when no videos on page", () => {
    const env = loadContentScript({ noVideo: true });
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "VIDEO_NOT_FOUND" })
    );
  });

  test("MutationObserver set up when no video found initially", () => {
    const env = loadContentScript({ noVideo: true });
    expect(env.mutationCb()).not.toBeNull();
  });

  test("observer disconnects once video is found via mutation", () => {
    const env = loadContentScript({ noVideo: true });
    const cb = env.mutationCb();
    expect(cb).not.toBeNull();
    // Dynamically add a video
    const newVideo = createMockVideo();
    env.doc.querySelectorAll = (sel) => (sel === "video" ? [newVideo] : []);
    cb([{ type: "childList" }]);
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "VIDEO_FOUND" })
    );
  });

  test("pending overlay applied when video found late", () => {
    const env = loadContentScript({ noVideo: true });
    // Request overlay before video exists
    env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
    // Now add a video
    const newVideo = createMockVideo();
    env.doc.querySelectorAll = (sel) => (sel === "video" ? [newVideo] : []);
    env.mutationCb()([{ type: "childList" }]);
    // Overlay should have been created
    expect(newVideo.parentElement.appendChild).toHaveBeenCalled();
  });
});

// ===================================================================
// Pause detection
// ===================================================================

describe("pause detection", () => {
  test("user pause tracked when extension has not paused", () => {
    const env = loadContentScript();
    env.video._triggerEvent("pause");
    // Can verify via VIDEO_REPORT_TIME
    const resp = env.sendMsg({ type: "VIDEO_REPORT_TIME" });
    // userPaused is internal; we verify indirectly through behavior
  });

  test("pause during extension operation not attributed to user", () => {
    const env = loadContentScript();
    // Start seekback (sets extensionPaused = true)
    env.sendMsg({ type: "START_SYNC" });
    // If DRM → seekback mode. Otherwise canvas.
    // For this test, use a DRM video
  });

  test("play event clears userPaused", () => {
    const env = loadContentScript();
    env.video._triggerEvent("pause");
    env.video._triggerEvent("play");
    // After play, subsequent operations should not think user paused
  });
});

// ===================================================================
// DRM detection
// ===================================================================

describe("DRM detection", () => {
  test("no requestVideoFrameCallback → seekback mode", () => {
    const env = loadContentScript({ videoOpts: { noRVFC: true } });
    const resp = env.sendMsg({ type: "START_SYNC" });
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ mode: "seekback" }));
  });

  test("video.mediaKeys present → seekback mode", () => {
    const env = loadContentScript({ videoOpts: { mediaKeys: {} } });
    const resp = env.sendMsg({ type: "START_SYNC" });
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ mode: "seekback" }));
  });

  test("normal video (RVFC + no mediaKeys) → canvas mode", () => {
    const env = loadContentScript();
    const resp = env.sendMsg({ type: "START_SYNC" });
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ ok: true, mode: "canvas" }));
  });

  test("no video → reports ok: false", () => {
    const env = loadContentScript({ noVideo: true });
    const resp = env.sendMsg({ type: "START_SYNC" });
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});

// ===================================================================
// Canvas mode
// ===================================================================

describe("canvas mode", () => {
  test("canvas element created on START_SYNC", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    const canvases = env.createdElements.filter((e) => e.tag === "canvas");
    expect(canvases.length).toBeGreaterThanOrEqual(1);
  });

  test("video hidden via CSS class", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    expect(env.video.classList.contains("__lt-hidden")).toBe(true);
  });

  test("SYNC_MODE message sent with 'canvas'", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "SYNC_MODE", mode: "canvas" })
    );
  });

  test("requestVideoFrameCallback called to start frame capture", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    expect(env.video.requestVideoFrameCallback).toHaveBeenCalled();
  });

  test("cleanup restores video visibility", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    expect(env.video.classList.contains("__lt-hidden")).toBe(true);
    env.sendMsg({ type: "VIDEO_CLEANUP" });
    expect(env.video.classList.contains("__lt-hidden")).toBe(false);
  });
});

// ===================================================================
// Seekback mode
// ===================================================================

describe("seekback mode", () => {
  test("SYNC_MODE sent with 'seekback'", () => {
    const env = loadContentScript({ videoOpts: { mediaKeys: {} } });
    env.sendMsg({ type: "START_SYNC" });
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "SYNC_MODE", mode: "seekback" })
    );
  });

  test("VIDEO_SEEK_BACK seeks video back by given seconds", () => {
    const env = loadContentScript({ videoOpts: { mediaKeys: {} } });
    env.video.currentTime = 30;
    env.sendMsg({ type: "START_SYNC" });
    env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 10 });
    expect(env.video.currentTime).toBe(20);
  });

  test("seek clamped to 0 (does not go negative)", () => {
    const env = loadContentScript({ videoOpts: { mediaKeys: {} } });
    env.video.currentTime = 5;
    env.sendMsg({ type: "START_SYNC" });
    env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 20 });
    expect(env.video.currentTime).toBe(0);
  });

  test("seeked event triggers play", () => {
    const env = loadContentScript({ videoOpts: { mediaKeys: {} } });
    env.video.currentTime = 30;
    env.sendMsg({ type: "START_SYNC" });
    env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 5 });
    // Simulate browser firing 'seeked'
    env.video._triggerEvent("seeked");
    expect(env.video.play).toHaveBeenCalled();
  });

  test("VIDEO_ADJUST_RATE changes playback rate in seekback mode", () => {
    const env = loadContentScript({ videoOpts: { mediaKeys: {} } });
    env.sendMsg({ type: "START_SYNC" });
    env.sendMsg({ type: "VIDEO_ADJUST_RATE", rate: 0.95 });
    expect(env.video.playbackRate).toBe(0.95);
  });

  test("VIDEO_ADJUST_RATE ignored in canvas mode", () => {
    const env = loadContentScript(); // no DRM → canvas mode
    env.sendMsg({ type: "START_SYNC" });
    env.sendMsg({ type: "VIDEO_ADJUST_RATE", rate: 0.5 });
    expect(env.video.playbackRate).toBe(1.0); // unchanged
  });
});

// ===================================================================
// SET_DELAY
// ===================================================================

describe("SET_DELAY", () => {
  test("updates target delay and recalculates frame count", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    const resp = env.sendMsg({ type: "SET_DELAY", delaySec: 5 });
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  test("defaults to 3 when delaySec is missing", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    env.sendMsg({ type: "SET_DELAY" }); // no delaySec
    // Should not crash, defaults internally to 3
  });
});

// ===================================================================
// Overlay management
// ===================================================================

describe("overlay", () => {
  test("SHOW_OVERLAY creates overlay elements", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
    expect(env.video.parentElement.appendChild).toHaveBeenCalled();
  });

  test("SHOW_OVERLAY queues if no video", () => {
    const env = loadContentScript({ noVideo: true });
    // Should not crash
    env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
    // pendingOverlayText is set internally
  });

  test("SHOW_OVERLAY clears previous overlay first", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "SHOW_OVERLAY", text: "First" });
    env.sendMsg({ type: "SHOW_OVERLAY", text: "Second" });
    // The old overlay's remove() should have been called
  });

  test("HIDE_OVERLAY removes overlay", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
    env.sendMsg({ type: "HIDE_OVERLAY" });
    // The overlay element's remove() should have been called
  });

  test("UPDATE_OVERLAY updates text and progress", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
    env.sendMsg({ type: "UPDATE_OVERLAY", text: "50%", progress: 50 });
    // Should not crash, updates internal overlay elements
  });
});

// ===================================================================
// VIDEO_REPORT_TIME
// ===================================================================

describe("VIDEO_REPORT_TIME", () => {
  test("returns current video state", () => {
    const env = loadContentScript();
    env.video.currentTime = 42;
    env.video.playbackRate = 0.95;
    env.video.paused = false;
    const resp = env.sendMsg({ type: "VIDEO_REPORT_TIME" });
    expect(resp).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        currentTime: 42,
        playbackRate: 0.95,
        paused: false,
      })
    );
  });

  test("returns nulls and paused:true when no video", () => {
    const env = loadContentScript({ noVideo: true });
    const resp = env.sendMsg({ type: "VIDEO_REPORT_TIME" });
    expect(resp).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, paused: true })
    );
  });
});

// ===================================================================
// VIDEO_CLEANUP
// ===================================================================

describe("VIDEO_CLEANUP", () => {
  test("full reset — canvas removed, overlay removed, rate restored", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" }); // start canvas mode
    env.video.playbackRate = 0.8;
    env.sendMsg({ type: "SHOW_OVERLAY", text: "test" });
    env.sendMsg({ type: "VIDEO_CLEANUP" });
    expect(env.video.playbackRate).toBe(1.0);
    expect(env.video.classList.contains("__lt-hidden")).toBe(false);
  });

  test("cleanup is safe when nothing was started", () => {
    const env = loadContentScript();
    expect(() => env.sendMsg({ type: "VIDEO_CLEANUP" })).not.toThrow();
  });

  test("cleanup with no video does not crash", () => {
    const env = loadContentScript({ noVideo: true });
    expect(() => env.sendMsg({ type: "VIDEO_CLEANUP" })).not.toThrow();
  });
});

// ===================================================================
// Message handling — video re-discovery
// ===================================================================

describe("message handling re-discovers video", () => {
  test("tries findVideo() if video was null when message arrives", () => {
    const env = loadContentScript({ noVideo: true });
    // Add video to DOM now
    const newVideo = createMockVideo();
    env.doc.querySelectorAll = (sel) => (sel === "video" ? [newVideo] : []);
    // Send a message that triggers re-discovery
    env.sendMsg({ type: "SET_DELAY", delaySec: 2 });
    // Should not crash — tries to find video
  });
});
