/**
 * Offscreen document: audio capture, WebSocket streaming, and playback.
 *
 * Audio pipeline (both sync modes):
 *   1. Capture tab audio continuously via AudioWorklet (200ms frames)
 *   2. Stream to backend via WebSocket for translation
 *   3. Buffer translated audio, then start playback
 *   4. Measure pipeline latency and send to content script
 *
 * Canvas mode: content script delays video frames; offscreen just plays audio.
 * Seekback mode: offscreen tells content script to seek back + adjusts rate.
 */

/* global chrome */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_URL_BASE = "ws://localhost:8765";

const TARGET_BUFFER_SEC = 3;     // seconds of translated audio before playback (canvas mode needs less)
const FALLBACK_START_SEC = 15;   // start playback regardless after this
const HEARTBEAT_MS = 10000;      // WebSocket keepalive interval
const SW_KEEPALIVE_MS = 25000;   // service worker keepalive interval
const DRIFT_MONITOR_MS = 5000;   // how often to emit VIDEO_SYNC_STATUS after playback

const SILENCE_THRESHOLD = 0.003; // lowered from 0.005 to preserve soft speech tails
const SILENCE_WARN_FRAMES = 50;

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

// Quiet by default in production. Set true to enable [offscreen] traces.
const DEBUG = false;
function dlog(...args) { if (DEBUG) dlog(...args); }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let captureStream = null;
let audioCtx = null;
let workletNode = null;
let playbackCtx = null;
let nextPlayTime = 0;
let decodedQueue = [];
let bufferedDurationSec = 0;
let isPlaying = false;
let isRebuffering = false;
let totalAudioCapturedSec = 0;
let heartbeatInterval = null;
let swKeepaliveInterval = null;
let fallbackTimer = null;
let isPaused = false;
let silenceFrames = 0;

let currentUtterance = null;
let lastOriginalEndSec = 0;
let translationOverrun = 0; // cumulative seconds that translated audio exceeds original duration

// Synchronous dedup (must fire before any await in finalizeUtterance)
let seenUtteranceKeys = new Set();
let highWaterEndSec = 0;

// Pipeline latency measurement
let firstFrameSentTime = 0;
let firstUtteranceReceivedTime = 0;
let measuredLatencySec = 0;
let latencySentToContent = false;

// Sync mode reported by content script
let syncMode = "canvas"; // "canvas" or "seekback"

// Caption dedup — prevent relaying the same translated text twice.
// Use a Set for O(1) lookup; track insertion order in a parallel array
// so we can evict the oldest when we hit the cap.
let recentCaptionsSet = new Set();
let recentCaptionsOrder = [];
const RECENT_CAPTIONS_MAX = 20;
function rememberCaption(text) {
  if (!text || recentCaptionsSet.has(text)) return false;
  recentCaptionsSet.add(text);
  recentCaptionsOrder.push(text);
  if (recentCaptionsOrder.length > RECENT_CAPTIONS_MAX) {
    const old = recentCaptionsOrder.shift();
    recentCaptionsSet.delete(old);
  }
  return true;
}

// Captions held while paused — flushed in order on resume
let heldCaptions = [];

// Caption sync — hold captions until their corresponding audio starts playing.
// Keyed by seq number. Whichever arrives first (caption or audio schedule) stores
// its data; the second arrival triggers the timed delivery.
let pendingCaptions = new Map(); // seq -> caption object (caption arrived before audio scheduled)
let scheduledAudioTimes = new Map(); // seq -> nextPlayTime (audio scheduled before caption arrived)

// Bound the sync maps: if one side of the pair never arrives (utterance
// dropped by dedup, caption missing from backend, etc.) the entry would
// otherwise leak forever. Map preserves insertion order, so oldest is first.
const SYNC_MAP_MAX = 50;
function capSyncMap(m) {
  while (m.size > SYNC_MAP_MAX) m.delete(m.keys().next().value);
}

// Seekback replay zone — suppress frames that are re-captured content.
// After seekback, the video replays from 0 and the tab produces the same audio
// again. We must NOT send this to the backend or it creates duplicate translations
// and a silence gap that permanently desyncs audio and video.
// Uses integer frame counting (not floating-point time) to avoid FP precision bugs.
let capturedFrameCount = 0;  // total frames captured (always increments)
let seekbackFrameMark = 0;   // capturedFrameCount at the moment of seekback
let inReplayZone = false;

// Drift monitor — emits VIDEO_SYNC_STATUS every DRIFT_MONITOR_MS while playing
// so the sidepanel can render a live sync badge. The interval is cleared on
// stopCapture / pause to avoid the leaked-handle warning Jest flags.
let driftMonitorInterval = null;
let playbackStartMs = 0;

// WebSocket reconnect state. Preserved across reconnects so the dedup sets
// and playback state survive a network blip.
let wsUrl = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

// ---------------------------------------------------------------------------
// Message relay to service worker
// ---------------------------------------------------------------------------

function sendToSW(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
}

/** Send a caption now or hold it if paused. */
function sendCaption(caption) {
  if (isPaused) {
    heldCaptions.push(caption);
  } else {
    sendToSW({ type: "CAPTION", caption });
  }
}

/** Flush held captions (called on resume). */
function flushHeldCaptions() {
  for (const cap of heldCaptions) {
    sendToSW({ type: "CAPTION", caption: cap });
  }
  heldCaptions = [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "START_CAPTURE":
      startCapture(msg.streamId, msg.sourceLang, msg.targetLang)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case "STOP_CAPTURE":
      stopCapture();
      sendResponse({ ok: true });
      break;

    case "SYNC_MODE_REPORT":
      syncMode = msg.mode || "canvas";
      dlog(`[offscreen] Content script sync mode: ${syncMode}`);
      break;

    case "PAUSE_ALL":
    case "USER_PAUSED_VIDEO":
    case "VIDEO_STALLED":
      isPaused = true;
      if (playbackCtx && playbackCtx.state === "running") {
        playbackCtx.suspend();
      }
      dlog("[offscreen] Paused");
      break;

    case "RESUME_ALL":
    case "USER_RESUMED_VIDEO":
    case "VIDEO_RESUMED_PLAYING":
      isPaused = false;
      flushHeldCaptions();
      if (playbackCtx && playbackCtx.state === "suspended") {
        playbackCtx.resume().then(() => {
          if (decodedQueue.length > 0 && isPlaying) scheduleBufferedAudio();
        });
      }
      dlog("[offscreen] Resumed");
      break;
  }
});

// ---------------------------------------------------------------------------
// Capture pipeline
// ---------------------------------------------------------------------------

function openWebSocket(url) {
  const w = new WebSocket(url);
  w.binaryType = "arraybuffer";

  const isReconnect = reconnectAttempts > 0;
  w.onopen = () => {
    if (isReconnect) {
      dlog(`[offscreen] WebSocket reconnected (attempt ${reconnectAttempts})`);
      reconnectAttempts = 0;
      // Session state (isPlaying, highWaterEndSec, seenUtteranceKeys) is
      // intentionally preserved. Don't re-send SHOW_OVERLAY / START_SYNC —
      // the user was already watching.
    } else {
      sendToSW({ type: "STATUS", status: "streaming" });
      sendToSW({ type: "SHOW_OVERLAY", text: "Buffering translation..." });
      sendToSW({ type: "START_SYNC" });
    }
  };
  w.onmessage = (event) => {
    if (typeof event.data === "string") {
      try { handleTextMessage(JSON.parse(event.data)); }
      catch (e) { console.error("[offscreen] Failed to parse WS message:", e); }
    } else {
      handleBinaryMessage(event.data);
    }
  };
  w.onerror = () => {
    sendToSW({ type: "CAPTURE_ERROR", error: "WebSocket connection failed" });
  };
  w.onclose = (event) => handleWSClose(event);
  return w;
}

function handleWSClose(event) {
  const code = event?.code;
  // 1000 = clean close (intentional). No URL means we've already torn down.
  if (code === 1000 || !wsUrl) {
    stopCapture();
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    dlog("[offscreen] Max reconnect attempts reached — stopping");
    stopCapture();
    return;
  }
  reconnectAttempts++;
  const scheduleReconnect = () => {
    if (!wsUrl) return; // torn down in the meantime
    ws = openWebSocket(wsUrl);
  };
  if (reconnectAttempts === 1) {
    // First retry: microtask — recovers from blips immediately.
    Promise.resolve().then(scheduleReconnect);
  } else {
    // Subsequent retries: backoff.
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts - 1, RECONNECT_DELAYS_MS.length - 1)];
    dlog(`[offscreen] WS closed — reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(scheduleReconnect, delay);
  }
}

async function startCapture(streamId, sourceLang, targetLang) {
  stopCapture();

  totalAudioCapturedSec = 0;
  bufferedDurationSec = 0;
  decodedQueue = [];
  isPlaying = false;
  silenceFrames = 0;
  currentUtterance = null;
  lastOriginalEndSec = 0;
  translationOverrun = 0;
  seenUtteranceKeys = new Set();
  highWaterEndSec = 0;
  firstFrameSentTime = 0;
  firstUtteranceReceivedTime = 0;
  measuredLatencySec = 0;
  latencySentToContent = false;
  recentCaptionsSet = new Set();
  recentCaptionsOrder = [];
  capturedFrameCount = 0;
  seekbackFrameMark = 0;
  inReplayZone = false;
  syncMode = "canvas";

  // 1. Get tab audio stream
  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  // 2. AudioContext for capture + playback
  audioCtx = new AudioContext();
  playbackCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(captureStream);

  await audioCtx.audioWorklet.addModule("stream-processor.js");
  workletNode = new AudioWorkletNode(audioCtx, "stream-processor");
  workletNode.port.onmessage = (e) => {
    if (e.data.type === "frame") handleAudioFrame(e.data);
  };
  source.connect(workletNode); // NOT to destination = mutes original

  // 3. WebSocket to backend
  wsUrl = `${WS_URL_BASE}/ws/translate?source=${sourceLang}&target=${targetLang}`;
  reconnectAttempts = 0;
  ws = openWebSocket(wsUrl);

  // 4. Keepalives
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, HEARTBEAT_MS);
  swKeepaliveInterval = setInterval(() => sendToSW({ type: "keepalive" }), SW_KEEPALIVE_MS);

  // 5. Fallback timer
  fallbackTimer = setTimeout(() => {
    if (!isPlaying && decodedQueue.length > 0) startPlayback();
  }, FALLBACK_START_SEC * 1000);
}

function stopCapture() {
  // Mark the session as torn down BEFORE closing the WS so handleWSClose
  // (which will fire) takes the stopCapture branch instead of reconnecting.
  wsUrl = null;
  reconnectAttempts = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end_stream" }));
      ws.close();
    } catch (e) {}
    ws = null;
  }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  if (captureStream) { captureStream.getTracks().forEach((t) => t.stop()); captureStream = null; }
  if (playbackCtx) { playbackCtx.close().catch(() => {}); playbackCtx = null; }

  clearInterval(heartbeatInterval);
  clearInterval(swKeepaliveInterval);
  clearTimeout(fallbackTimer);
  stopDriftMonitor();
  heartbeatInterval = null;
  swKeepaliveInterval = null;
  fallbackTimer = null;

  isPlaying = false;
  isPaused = false;
  isRebuffering = false;
  heldCaptions = [];
  decodedQueue = [];
  currentUtterance = null;
  lastOriginalEndSec = 0;
  utterancesScheduledSinceStart = 0;
  pendingCaptions.clear();
  scheduledAudioTimes.clear();

  sendToSW({ type: "HIDE_OVERLAY" });
  sendToSW({ type: "STATUS", status: "idle" });
}

// ---------------------------------------------------------------------------
// Audio frame handling (capture -> resample -> WebSocket)
// ---------------------------------------------------------------------------

async function handleAudioFrame(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isPaused) return;

  const frameDuration = frame.samples.length / frame.sampleRate;
  capturedFrameCount++;

  // Seekback replay zone: the video is replaying already-translated content.
  // Suppress frames so the backend doesn't produce duplicate translations.
  //
  // NOTE on BUG-010: this condition was originally flagged as "assumes 1×
  // playback rate" but that turns out to be wrong — audio frames are
  // produced at the audio sample rate (200ms of audio per frame regardless
  // of video rate), so frame count tracks audio content, not wall-clock
  // time. Doubling the seekback frame mark gives us exactly the duration of
  // re-captured audio we need to suppress.
  // totalAudioCapturedSec is NOT incremented during the replay zone because
  // these frames are duplicate content that the backend never sees.
  if (inReplayZone) {
    if (capturedFrameCount >= seekbackFrameMark * 2) {
      inReplayZone = false;
      dlog("[offscreen] Replay zone ended — resuming capture to backend");
    }
    return; // suppress ALL replay zone frames including the boundary
  }

  totalAudioCapturedSec += frameDuration;

  if (frame.rms < SILENCE_THRESHOLD) {
    silenceFrames++;
    if (silenceFrames === SILENCE_WARN_FRAMES) sendToSW({ type: "SILENCE_WARNING" });
  } else {
    silenceFrames = 0;
  }

  const pcm16 = await resampleTo16kPCM16(frame.samples, frame.sampleRate);
  ws.send(pcm16);

  if (firstFrameSentTime === 0) firstFrameSentTime = Date.now();

  if (!isPlaying) {
    const progress = Math.min(100, Math.round((bufferedDurationSec / TARGET_BUFFER_SEC) * 100));
    sendToSW({
      type: "OVERLAY_PROGRESS",
      text: `Buffering translation... ${Math.round(bufferedDurationSec)}s / ${TARGET_BUFFER_SEC}s`,
      progress,
    });
  }
}

function resampleTo16kPCM16(samples, sourceSampleRate) {
  const targetRate = 16000;
  if (sourceSampleRate === targetRate) return float32ToPCM16(samples);

  // Linear interpolation resampler — synchronous, no GC pressure from
  // creating a new OfflineAudioContext for every 200ms frame (5/sec).
  const ratio = sourceSampleRate / targetRate;
  const outputLength = Math.ceil(samples.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const srcFloor = Math.floor(srcIdx);
    const frac = srcIdx - srcFloor;
    const s0 = samples[srcFloor] || 0;
    const s1 = samples[Math.min(srcFloor + 1, samples.length - 1)] || 0;
    output[i] = s0 + frac * (s1 - s0);
  }

  return float32ToPCM16(output);
}

function float32ToPCM16(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16.buffer;
}

// ---------------------------------------------------------------------------
// WebSocket message handling (from backend)
// ---------------------------------------------------------------------------

function handleTextMessage(data) {
  switch (data.type) {
    case "session_ready":
      break;
    case "utterance_start":
      currentUtterance = { seq: data.seq, speakerId: data.speaker_id, chunks: [] };
      break;
    case "utterance_end":
      if (currentUtterance && currentUtterance.seq === data.seq) {
        finalizeUtterance(currentUtterance, data.original_start_sec || 0, data.original_end_sec || 0);
        currentUtterance = null;
      }
      break;
    case "caption": {
      const translated = data.translated || "";
      if (translated && !rememberCaption(translated)) break;

      const caption = {
        speaker: `Speaker ${data.speaker_id}`,
        original: data.original,
        translated,
      };

      // Sync caption with audio: delay delivery until the audio starts playing.
      if (!playbackCtx || data.seq === undefined) {
        // No audio context or no seq — send immediately (fallback)
        sendCaption(caption);
      } else {
        const timing = scheduledAudioTimes.get(data.seq);
        if (timing) {
          const delayMs = Math.max(0, (timing - playbackCtx.currentTime) * 1000);
          if (delayMs < 50) {
            sendCaption(caption);
          } else {
            setTimeout(() => sendCaption(caption), delayMs);
          }
          scheduledAudioTimes.delete(data.seq);
        } else {
          pendingCaptions.set(data.seq, caption);
          capSyncMap(pendingCaptions);
        }
      }
      break;
    }
    case "rebuffer_start":
      isRebuffering = true;
      if (playbackCtx && playbackCtx.state === "running") {
        playbackCtx.suspend();
      }
      sendToSW({ type: "SHOW_OVERLAY", text: "New speaker detected \u2014 analyzing voice..." });
      sendToSW({ type: "REBUFFER_START" });
      dlog(`[offscreen] Re-buffering for new speaker ${data.speaker_id}`);
      break;

    case "rebuffer_progress":
      sendToSW({
        type: "OVERLAY_PROGRESS",
        text: `Analyzing new speaker... ${data.progress}%`,
        progress: data.progress,
      });
      break;

    case "rebuffer_end":
      isRebuffering = false;
      if (playbackCtx && playbackCtx.state === "suspended" && !isPaused) {
        playbackCtx.resume().then(() => {
          if (decodedQueue.length > 0 && isPlaying) scheduleBufferedAudio();
        });
      }
      sendToSW({ type: "HIDE_OVERLAY" });
      sendToSW({ type: "REBUFFER_END" });
      dlog("[offscreen] Re-buffer complete — resuming playback");
      break;

    case "error":
      if (!data.recoverable) { sendToSW({ type: "CAPTURE_ERROR", error: data.message }); stopCapture(); }
      else sendToSW({ type: "CHUNK_ERROR", error: data.message });
      break;
    case "heartbeat_ack":
      break;
  }
}

function handleBinaryMessage(arrayBuffer) {
  if (currentUtterance) currentUtterance.chunks.push(arrayBuffer);
}

// ---------------------------------------------------------------------------
// MP3 silence trimming
// ---------------------------------------------------------------------------

function trimSilence(audioBuffer, threshold = SILENCE_THRESHOLD) {
  const data = audioBuffer.getChannelData(0);
  let start = 0;
  while (start < data.length && Math.abs(data[start]) < threshold) start++;
  let end = data.length - 1;
  while (end > start && Math.abs(data[end]) < threshold) end--;
  if (start < 10 && end > data.length - 10) return audioBuffer;
  const trimmedLength = Math.max(1, end - start + 1);
  const trimmed = new AudioBuffer({
    length: trimmedLength,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
  });
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    trimmed.getChannelData(ch).set(audioBuffer.getChannelData(ch).subarray(start, end + 1));
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Utterance finalization
// ---------------------------------------------------------------------------

async function finalizeUtterance(utterance, originalStartSec, originalEndSec) {
  if (utterance.chunks.length === 0) return;

  // Measure pipeline latency on first utterance
  if (firstUtteranceReceivedTime === 0 && firstFrameSentTime > 0) {
    firstUtteranceReceivedTime = Date.now();
    measuredLatencySec = (firstUtteranceReceivedTime - firstFrameSentTime) / 1000;
    dlog(`[offscreen] Measured pipeline latency: ${measuredLatencySec.toFixed(1)}s`);
    // Send to content script so canvas knows how much to delay
    sendToSW({ type: "SET_DELAY", delaySec: measuredLatencySec });
    latencySentToContent = true;
  }

  // ---- SYNCHRONOUS dedup (must complete before any await) ----

  // 1. Exact key match: same start+end = same Deepgram segment
  const dedupKey = `${originalStartSec.toFixed(3)}|${originalEndSec.toFixed(3)}`;
  if (seenUtteranceKeys.has(dedupKey)) {
    dlog(`[offscreen] Dedup: dropping duplicate seq=${utterance.seq} key=${dedupKey}`);
    pendingCaptions.delete(utterance.seq);
    scheduledAudioTimes.delete(utterance.seq);
    return;
  }
  seenUtteranceKeys.add(dedupKey);
  if (seenUtteranceKeys.size > 200) {
    const iter = seenUtteranceKeys.values();
    for (let i = 0; i < 100; i++) seenUtteranceKeys.delete(iter.next().value);
  }

  // 2. Timestamp overlap: skip if this utterance's time range is already covered
  if (originalStartSec > 0 && originalStartSec < highWaterEndSec - 0.1) {
    dlog(
      `[offscreen] Dedup: skipping overlapping seq=${utterance.seq} ` +
      `(start=${originalStartSec.toFixed(1)}s < highWater=${highWaterEndSec.toFixed(1)}s)`
    );
    pendingCaptions.delete(utterance.seq);
    scheduledAudioTimes.delete(utterance.seq);
    return;
  }
  // Update high-water SYNCHRONOUSLY before the await
  if (originalEndSec > highWaterEndSec) highWaterEndSec = originalEndSec;

  // ---- end synchronous dedup ----

  const totalSize = utterance.chunks.reduce((s, c) => s + c.byteLength, 0);
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of utterance.chunks) {
    combined.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  try {
    let audioBuffer = await playbackCtx.decodeAudioData(combined.buffer.slice(0));
    audioBuffer = trimSilence(audioBuffer);

    decodedQueue.push({
      audioBuffer,
      seq: utterance.seq,
      speakerId: utterance.speakerId,
      originalStartSec,
      originalEndSec,
    });
    bufferedDurationSec += audioBuffer.duration;

    if (isPlaying && !isRebuffering) {
      scheduleBufferedAudio();
    } else if (!isPlaying && bufferedDurationSec >= TARGET_BUFFER_SEC) {
      startPlayback();
    }
    // During rebuffer: decoded audio stays in decodedQueue, scheduled on resume
  } catch (e) {
    console.error("[offscreen] Failed to decode audio:", e);
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function startPlayback() {
  if (isPlaying) return;
  isPlaying = true;

  clearTimeout(fallbackTimer);
  fallbackTimer = null;

  if (playbackCtx.state === "suspended") playbackCtx.resume();
  nextPlayTime = playbackCtx.currentTime + 0.1;

  // Capture the first utterance's video position BEFORE draining the queue —
  // the content script needs this to align the canvas to the same position.
  const audioStartSec = decodedQueue.length > 0 ? decodedQueue[0].originalStartSec : 0;

  scheduleBufferedAudio();

  if (syncMode === "seekback") {
    seekbackFrameMark = capturedFrameCount;
    inReplayZone = true;
    sendToSW({ type: "VIDEO_SEEK_BACK", seekBackSec: totalAudioCapturedSec });
  } else {
    sendToSW({ type: "PLAYBACK_STARTED", audioStartSec });
  }

  sendToSW({ type: "HIDE_OVERLAY" });

  playbackStartMs = Date.now();
  startDriftMonitor();

  dlog(
    `[offscreen] Playback started (${syncMode} mode). ` +
    `Buffer: ${bufferedDurationSec.toFixed(1)}s, ` +
    `measured latency: ${measuredLatencySec.toFixed(1)}s`
  );
}

// Periodically emit VIDEO_SYNC_STATUS so the sidepanel can render a live
// sync badge and so any future content-script driver has a poll loop to
// hook into. Uses translated-audio buffer-ahead (decodedQueue duration)
// as the proxy for sync health.
function startDriftMonitor() {
  if (driftMonitorInterval) return;
  driftMonitorInterval = setInterval(() => {
    if (!isPlaying || isPaused || !playbackCtx) return;
    const bufferAheadMs = Math.max(0, (nextPlayTime - playbackCtx.currentTime) * 1000);
    const synced = bufferAheadMs >= 500 && bufferAheadMs <= TARGET_BUFFER_SEC * 4 * 1000;
    sendToSW({
      type: "VIDEO_SYNC_STATUS",
      bufferAheadMs,
      videoRate: 1.0,
      synced,
    });
  }, DRIFT_MONITOR_MS);
  // Don't keep the Node test runner alive on stray intervals (no-op in browser).
  if (driftMonitorInterval && typeof driftMonitorInterval.unref === "function") {
    driftMonitorInterval.unref();
  }
}

function stopDriftMonitor() {
  if (driftMonitorInterval) {
    clearInterval(driftMonitorInterval);
    driftMonitorInterval = null;
  }
}

function scheduleBufferedAudio() {
  while (decodedQueue.length > 0) {
    scheduleAudioItem(decodedQueue.shift());
  }
}

// Emit a VIDEO_SYNC_STATUS every Nth utterance so the sync badge updates
// even outside the 5s interval cadence (e.g. in tests, or when the SW is
// suspended and re-woken between timer ticks).
const SYNC_STATUS_EVERY_N = 10;
let utterancesScheduledSinceStart = 0;
function emitSyncStatusIfDue() {
  if (!isPlaying || !playbackCtx) return;
  utterancesScheduledSinceStart++;
  if (utterancesScheduledSinceStart % SYNC_STATUS_EVERY_N !== 0) return;
  const bufferAheadMs = Math.max(0, (nextPlayTime - playbackCtx.currentTime) * 1000);
  const synced = bufferAheadMs >= 500 && bufferAheadMs <= TARGET_BUFFER_SEC * 4 * 1000;
  sendToSW({
    type: "VIDEO_SYNC_STATUS",
    bufferAheadMs,
    videoRate: 1.0,
    synced,
  });
}

function scheduleAudioItem(item) {
  if (!playbackCtx) return;

  const source = playbackCtx.createBufferSource();
  source.buffer = item.audioBuffer;
  source.connect(playbackCtx.destination);

  if (nextPlayTime < playbackCtx.currentTime) {
    nextPlayTime = playbackCtx.currentTime + 0.05;
  }

  // Track how much translated audio overruns the original speech duration.
  // If a 2s original utterance produces 2.6s of TTS, that's +0.6s overrun.
  // This accumulates across utterances as translations consistently expand.
  const originalDuration = (item.originalEndSec || 0) - (item.originalStartSec || 0);
  if (originalDuration > 0) {
    translationOverrun += item.audioBuffer.duration - originalDuration;
    if (translationOverrun < 0) translationOverrun = 0; // don't go negative
  }

  // Insert natural gap from original speech timing, but REDUCE it by the
  // accumulated overrun. This self-corrects translation expansion drift:
  // if translations are running long, gaps shrink to compensate.
  // The audio content itself is NEVER cut or sped up — only silence shrinks.
  if (item.originalStartSec > lastOriginalEndSec) {
    const gap = item.originalStartSec - lastOriginalEndSec;
    const adjustedGap = Math.max(0, gap - translationOverrun);
    nextPlayTime += Math.min(adjustedGap, 3.0);
    // Consume the overrun we just compensated for
    translationOverrun = Math.max(0, translationOverrun - gap);
  }

  source.start(nextPlayTime);
  emitSyncStatusIfDue();

  // Sync caption delivery with audio playback.
  const caption = pendingCaptions.get(item.seq);
  if (caption) {
    const delayMs = Math.max(0, (nextPlayTime - playbackCtx.currentTime) * 1000);
    if (delayMs < 50) {
      sendCaption(caption);
    } else {
      setTimeout(() => sendCaption(caption), delayMs);
    }
    pendingCaptions.delete(item.seq);
  } else if (item.seq !== undefined) {
    scheduledAudioTimes.set(item.seq, nextPlayTime);
    capSyncMap(scheduledAudioTimes);
  }

  nextPlayTime += item.audioBuffer.duration;

  if (item.originalEndSec > 0) lastOriginalEndSec = item.originalEndSec;

  // BUG-025: previously called scheduleBufferedAudio() unconditionally,
  // which is a no-op walk over an empty queue. Now we only re-drain when
  // there's actually pending work to schedule.
  source.onended = () => {
    if (decodedQueue.length > 0 && !isPaused && !isRebuffering) {
      scheduleBufferedAudio();
    }
  };
}
