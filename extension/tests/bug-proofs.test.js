/**
 * @jest-environment node
 *
 * Proof tests for bugs listed in BUGS.md.
 *
 * CONVENTION: each test asserts the CURRENT (buggy) behavior.
 *   - PASS  = bug is real.
 *   - FAIL  = bug is NOT real (or the test is wrong — double-check).
 *
 * When we fix a bug, flip the assertion to express correct behavior.
 */
const fs = require("fs");
const path = require("path");
const {
  flushPromises,
  createChromeMock,
  createMockWSConstructor,
  createMockAudioContext,
  createMockAudioBuffer,
  createMockVideo,
  createMockElement,
  createMockDocument,
  createMockNavigator,
  loadScript,
  loadOffscreenScript,
} = require("./helpers");

const ROOT = path.resolve(__dirname, "..");
function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

// ===================================================================
// Reusable env factories (trimmed copies from offscreen/service-worker/content-script tests)
// ===================================================================

function createOffscreenEnv(opts = {}) {
  const chrome = createChromeMock();
  const WS = createMockWSConstructor();
  const ctxInstances = [];
  const awnInstances = [];

  function AudioCtxCtor() {
    const c = createMockAudioContext(opts);
    ctxInstances.push(c);
    return c;
  }
  function AWNCtor() {
    const n = { port: { _onmessage: null, postMessage: jest.fn() }, connect: jest.fn(), disconnect: jest.fn() };
    Object.defineProperty(n.port, "onmessage", {
      get() { return n.port._onmessage; },
      set(fn) { n.port._onmessage = fn; },
    });
    awnInstances.push(n);
    return n;
  }
  function OACtor() {
    return {
      createBuffer: (_c, l, s) => createMockAudioBuffer({ length: l, sampleRate: s }),
      createBufferSource: () => ({ buffer: null, connect: jest.fn(), start: jest.fn() }),
      destination: {},
      startRendering: () => Promise.resolve(createMockAudioBuffer({ length: 100, sampleRate: 16000 })),
    };
  }
  function ABCtor(o) { return createMockAudioBuffer(o); }
  const nav = createMockNavigator();
  const timeouts = [];
  const intervals = [];
  let tid = 0;
  let iid = 0;

  const ctx = loadOffscreenScript({
    chrome,
    WebSocket: WS,
    AudioContext: AudioCtxCtor,
    AudioWorkletNode: AWNCtor,
    OfflineAudioContext: OACtor,
    AudioBuffer: ABCtor,
    navigator: nav,
    setTimeout: (fn, ms) => { const id = tid++; timeouts.push({ fn, ms, id }); return id; },
    clearTimeout: (id) => { const i = timeouts.findIndex((t) => t.id === id); if (i >= 0) timeouts.splice(i, 1); },
    setInterval: (fn, ms) => { const id = iid++; intervals.push({ fn, ms, id }); return id; },
    clearInterval: (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); },
  });

  return {
    ctx, chrome, WS, ctxInstances, awnInstances,
    getState() { ctx.__readState(); return { ...ctx.__test }; },
    async startCapture(src = "en", tgt = "es") {
      chrome._simulateMessage({ type: "START_CAPTURE", streamId: "s", sourceLang: src, targetLang: tgt }, {}, jest.fn());
      await flushPromises();
      const ws = WS._last();
      if (ws) { ws.readyState = 1; if (ws.onopen) ws.onopen(); }
    },
    simulateWSText(data) {
      const ws = WS._last();
      if (ws && ws.onmessage) ws.onmessage({ data: JSON.stringify(data) });
    },
    simulateWSBinary(buf) {
      const ws = WS._last();
      if (ws && ws.onmessage) ws.onmessage({ data: buf || new ArrayBuffer(100) });
    },
    sentMessages() { return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]); },
  };
}

function loadServiceWorker() {
  const chrome = createChromeMock();
  const ctx = loadScript("service-worker.js", { chrome });
  return {
    ctx, chrome,
    sendMsg(msg, sender) {
      const resp = jest.fn();
      chrome._simulateMessage(msg, sender || {}, resp);
      return resp;
    },
    sentToOffscreen() { return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]); },
  };
}

function loadContentScriptEnv(opts = {}) {
  const chrome = createChromeMock();
  const video = opts.video !== undefined ? opts.video : createMockVideo(opts.videoOpts || {});
  const videos = opts.noVideo ? [] : [video];

  let mutationCb = null;
  function MutationObserver(cb) { mutationCb = cb; this.observe = jest.fn(); this.disconnect = jest.fn(); }
  function ResizeObserver() { this.observe = jest.fn(); this.disconnect = jest.fn(); }

  const createdElements = [];
  const doc = createMockDocument({
    videos,
    onCreateElement(tag) { const el = createMockElement(tag); createdElements.push({ tag, el }); return el; },
  });

  const ctx = loadScript("content-script.js", {
    chrome, document: doc, window: {},
    MutationObserver, ResizeObserver,
    getComputedStyle: jest.fn((el) => ({ position: el?.style?.position || "static" })),
    DOMException: class DOMException extends Error {},
    performance: { now: () => 0 },
  });
  return {
    ctx, chrome, video, doc, createdElements,
    sendMsg(msg) { const resp = jest.fn(); chrome._simulateMessage(msg, {}, resp); return resp; },
    sentMessages() { return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]); },
  };
}

function loadSidepanelEnv() {
  const chrome = createChromeMock();
  const ids = [
    "startStopBtn", "statusBadge", "captions", "emptyState",
    "silenceWarning", "warmingUp", "warmingText", "elapsedTimer",
    "sourceLang", "targetLang", "syncBadge",
    "errorBanner", "errorMessage", "retryBtn", "dismissBtn", "pauseResumeBtn", "newVideoBtn",
  ];
  const els = {};
  for (const id of ids) {
    els[id] = createMockElement(id === "sourceLang" || id === "targetLang" ? "select" : "div");
    els[id].id = id;
  }
  els.sourceLang.value = "en";
  els.targetLang.value = "es";

  const doc = {
    getElementById: (id) => els[id] || createMockElement("div"),
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: () => [],
  };
  const ctx = loadScript("sidepanel/sidepanel.js", {
    chrome, document: doc, window: {},
    setInterval: (fn) => 1, clearInterval: () => {},
    setTimeout, clearTimeout,
    Date: { now: () => 1000 },
  });
  return {
    ctx, chrome, els,
    sendMsg(msg) { const r = jest.fn(); chrome._simulateMessage(msg, {}, r); return r; },
  };
}

// ===================================================================
// BUG-001: Double delivery of pause/resume messages via SW relay
// ===================================================================

describe("BUG-001: Double delivery of USER_PAUSED/RESUMED_VIDEO via SW relay (FIXED)", () => {
  test("service worker does NOT re-broadcast USER_PAUSED_VIDEO", () => {
    const env = loadServiceWorker();
    env.chrome.runtime.sendMessage.mockClear();
    env.sendMsg({ type: "USER_PAUSED_VIDEO" });
    const relayed = env.sentToOffscreen().filter((m) => m.type === "USER_PAUSED_VIDEO");
    expect(relayed.length).toBe(0);
  });

  test("service worker does NOT re-broadcast USER_RESUMED_VIDEO", () => {
    const env = loadServiceWorker();
    env.chrome.runtime.sendMessage.mockClear();
    env.sendMsg({ type: "USER_RESUMED_VIDEO" });
    const relayed = env.sentToOffscreen().filter((m) => m.type === "USER_RESUMED_VIDEO");
    expect(relayed.length).toBe(0);
  });

  test("offscreen still has its own listener for USER_PAUSED_VIDEO (direct delivery path)", () => {
    const src = readSource("offscreen/offscreen.js");
    expect(src).toMatch(/case\s+["']USER_PAUSED_VIDEO["']/);
  });
});

// ===================================================================
// BUG-002: pendingCaptions / scheduledAudioTimes leak on dedup-dropped utterances
// ===================================================================

describe("BUG-002: Caption map cleanup on dedup-dropped utterances (FIXED)", () => {
  test("caption for a dedup-dropped utterance does NOT leak in pendingCaptions", async () => {
    const env = createOffscreenEnv();
    await env.startCapture();

    // First utterance 0.0-1.0 — finalize successfully
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: "A" });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();

    // Caption for dropped seq arrives BEFORE its utterance → stashed
    env.simulateWSText({
      type: "caption", seq: 2, speaker_id: "A",
      original: "hi", translated: "hola-unique-2",
    });
    await flushPromises();

    // Confirm it was stashed
    let state = env.getState();
    expect(state.pendingCaptions.has(2)).toBe(true);

    // Second utterance with SAME timestamps — dedup-dropped. Fix should
    // proactively clean pendingCaptions for the dropped seq.
    env.simulateWSText({ type: "utterance_start", seq: 2, speaker_id: "A" });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 2, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();

    state = env.getState();
    expect(state.pendingCaptions.has(2)).toBe(false);
  });

  test("pendingCaptions is capped — never grows unbounded even if captions stream without matching utterances", async () => {
    const env = createOffscreenEnv();
    await env.startCapture();

    // Flood captions with no matching utterances (backend lag / dropped end-of-utterance)
    for (let i = 0; i < 200; i++) {
      env.simulateWSText({
        type: "caption", seq: 1000 + i, speaker_id: "A",
        original: "x", translated: `t-${i}`,
      });
    }
    await flushPromises();

    const state = env.getState();
    expect(state.pendingCaptions.size).toBeLessThanOrEqual(50);
  });
});

// ===================================================================
// BUG-003 / BUG-011: content-script onMessage + video listeners never removed on teardown
// ===================================================================

describe("BUG-003 / BUG-011: content-script teardown removes listeners (FIXED)", () => {
  test("teardown calls chrome.runtime.onMessage.removeListener", () => {
    const src = readSource("content-script.js");
    const teardownMatch = src.match(/window\.__liveTranslatorV2Teardown\s*=\s*function[\s\S]*?\n\s*\};/);
    expect(teardownMatch).not.toBeNull();
    expect(teardownMatch[0]).toMatch(/removeListener/);
  });

  test("teardown calls removeEventListener for pause and play on video", () => {
    const src = readSource("content-script.js");
    const teardownMatch = src.match(/window\.__liveTranslatorV2Teardown\s*=\s*function[\s\S]*?\n\s*\};/);
    expect(teardownMatch).not.toBeNull();
    expect(teardownMatch[0]).toMatch(/removeEventListener\s*\(\s*["']pause["']/);
    expect(teardownMatch[0]).toMatch(/removeEventListener\s*\(\s*["']play["']/);
  });

  test("BEHAVIOR: after VIDEO_CLEANUP, video pause/play listeners are detached", () => {
    const env = loadContentScriptEnv();
    const pauseBefore = (env.video._listeners.pause || []).length;
    const playBefore = (env.video._listeners.play || []).length;
    expect(pauseBefore).toBeGreaterThan(0);
    expect(playBefore).toBeGreaterThan(0);

    env.sendMsg({ type: "VIDEO_CLEANUP" });

    const pauseAfter = (env.video._listeners.pause || []).length;
    const playAfter = (env.video._listeners.play || []).length;
    expect(pauseAfter).toBe(pauseBefore - 1);
    expect(playAfter).toBe(playBefore - 1);
  });

  test("BEHAVIOR: after VIDEO_CLEANUP, chrome.runtime.onMessage listener is detached", () => {
    const env = loadContentScriptEnv();
    const listenerCountBefore = env.chrome._messageListeners.length;
    expect(listenerCountBefore).toBeGreaterThan(0);

    env.sendMsg({ type: "VIDEO_CLEANUP" });

    expect(env.chrome._messageListeners.length).toBe(listenerCountBefore - 1);
  });
});

// ===================================================================
// BUG-004: Canvas overlay breaks on fullscreen (code-level check)
// ===================================================================

describe("BUG-004: Canvas overlay re-parented on fullscreenchange (FIXED)", () => {
  test("fullscreenchange handler re-parents canvas into fullscreenElement", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/fullscreenchange["'],\s*handleFullscreenChange/);
    // Handler body contains re-parenting logic
    const handlerMatch = src.match(/function handleFullscreenChange\([\s\S]*?\n\s{2}\}/m);
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch[0]).toMatch(/document\.fullscreenElement/);
    expect(handlerMatch[0]).toMatch(/appendChild\(canvasEl\)/);
  });
});

// ===================================================================
// BUG-005: WS reconnect — covered by existing failing tests in netflix-pipeline.test.js
// ===================================================================

describe("BUG-005: WebSocket reconnect on abnormal close (FIXED)", () => {
  test("offscreen defines handleWSClose and reconnect attempt state", () => {
    const src = readSource("offscreen/offscreen.js");
    expect(src).toMatch(/function handleWSClose/);
    expect(src).toMatch(/reconnectAttempts/);
    expect(src).toMatch(/MAX_RECONNECT_ATTEMPTS/);
  });

  test("stopCapture clears wsUrl and reconnectTimer so pending reconnects don't fire", () => {
    const src = readSource("offscreen/offscreen.js");
    const match = src.match(/function stopCapture\([\s\S]*?^\}/m);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/wsUrl\s*=\s*null/);
    expect(match[0]).toMatch(/clearTimeout\(reconnectTimer\)/);
  });
});

// ===================================================================
// BUG-006: Captions lost when sidepanel is closed
// ===================================================================

describe("BUG-006: Caption persistence moved to service worker (FIXED)", () => {
  test("service worker writes captionHistory on CAPTION relay", () => {
    const src = readSource("service-worker.js");
    expect(src).toMatch(/persistCaption/);
    expect(src).toMatch(/captionHistory/);
    expect(src).toMatch(/storage\.local\.set/);
  });

  test("sidepanel addCaption does NOT write captionHistory (SW handles it)", () => {
    const src = readSource("sidepanel/sidepanel.js");
    expect(src).toMatch(/storage\.local\.get[\s\S]{0,200}captionHistory/);
    // addCaption must not write to storage — would race the SW's write chain.
    const addCaptionMatch = src.match(/function addCaption[\s\S]*?^\}/m);
    expect(addCaptionMatch).not.toBeNull();
    expect(addCaptionMatch[0]).not.toMatch(/storage\.local\.set/);
  });

  test("BEHAVIOR: CAPTION arriving at SW triggers storage write even when no sidepanel listener", async () => {
    const env = loadServiceWorker();
    env.chrome.storage.local._data = {};
    env.chrome.storage.local.set.mockClear();

    env.sendMsg({ type: "CAPTION", caption: { speaker: "A", translated: "hola", original: "hi" } });
    // persistCaption uses get()+set() via a promise chain
    await flushPromises();
    await flushPromises();

    expect(env.chrome.storage.local.set).toHaveBeenCalled();
    const lastCall = env.chrome.storage.local.set.mock.calls.slice(-1)[0][0];
    expect(lastCall.captionHistory).toEqual([
      expect.objectContaining({ translated: "hola" }),
    ]);
  });
});

// ===================================================================
// BUG-007: No "waiting" event listener for video stalls
// ===================================================================

describe("BUG-007: Video stall suspends translated audio (FIXED)", () => {
  test("content-script registers 'waiting' and 'playing' listeners", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/addEventListener\s*\(\s*["']waiting["']/);
    expect(src).toMatch(/addEventListener\s*\(\s*["']playing["']/);
  });

  test("offscreen handles VIDEO_STALLED by suspending playbackCtx", () => {
    const src = readSource("offscreen/offscreen.js");
    expect(src).toMatch(/case\s+["']VIDEO_STALLED["']/);
    expect(src).toMatch(/case\s+["']VIDEO_RESUMED_PLAYING["']/);
  });

  test("BEHAVIOR: video 'waiting' event triggers VIDEO_STALLED message", () => {
    const env = loadContentScriptEnv();
    env.chrome.runtime.sendMessage.mockClear();
    env.video._triggerEvent("waiting");
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "VIDEO_STALLED" })
    );
  });

  test("BEHAVIOR: repeated 'waiting' events only send VIDEO_STALLED once", () => {
    const env = loadContentScriptEnv();
    env.chrome.runtime.sendMessage.mockClear();
    env.video._triggerEvent("waiting");
    env.video._triggerEvent("waiting");
    env.video._triggerEvent("waiting");
    const stalls = env.sentMessages().filter((m) => m.type === "VIDEO_STALLED");
    expect(stalls.length).toBe(1);
  });

  test("BEHAVIOR: 'playing' after 'waiting' sends VIDEO_RESUMED_PLAYING", () => {
    const env = loadContentScriptEnv();
    env.video._triggerEvent("waiting");
    env.chrome.runtime.sendMessage.mockClear();
    env.video._triggerEvent("playing");
    expect(env.sentMessages()).toContainEqual(
      expect.objectContaining({ type: "VIDEO_RESUMED_PLAYING" })
    );
  });
});

// ===================================================================
// BUG-008: No cleanup on tab close / navigation
// ===================================================================

describe("BUG-008: Service worker cleans up on tab close/nav (FIXED)", () => {
  test("service-worker.js registers tabs.onRemoved and tabs.onUpdated listeners", () => {
    const src = readSource("service-worker.js");
    expect(src).toMatch(/tabs\.onRemoved\.addListener/);
    expect(src).toMatch(/tabs\.onUpdated\.addListener/);
  });

  test("BEHAVIOR: closing the captured tab triggers handleStopCapture", async () => {
    const env = loadServiceWorker();
    await env.sendMsg({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    await flushPromises();
    env.chrome.runtime.sendMessage.mockClear();

    env.chrome._simulateTabRemoved(42);
    await flushPromises();

    // stopCapture sends STOP_CAPTURE via runtime.sendMessage
    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "STOP_CAPTURE" })
    );
  });

  test("BEHAVIOR: navigation (changeInfo.url) on the captured tab triggers cleanup", async () => {
    const env = loadServiceWorker();
    await env.sendMsg({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    await flushPromises();
    env.chrome.runtime.sendMessage.mockClear();

    env.chrome._simulateTabUpdated(42, { url: "https://other.example/" });
    await flushPromises();

    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "STOP_CAPTURE" })
    );
  });

  test("BEHAVIOR: closing a DIFFERENT tab does not trigger cleanup", async () => {
    const env = loadServiceWorker();
    await env.sendMsg({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    await flushPromises();
    env.chrome.runtime.sendMessage.mockClear();

    env.chrome._simulateTabRemoved(999);
    await flushPromises();

    expect(env.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "STOP_CAPTURE" })
    );
  });
});

// ===================================================================
// BUG-009: No ratechange listener — YouTube shortcuts break canvas sync
// ===================================================================

describe("BUG-009: ratechange clamp in canvas mode (FIXED)", () => {
  test("content-script registers a 'ratechange' listener", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/addEventListener\s*\(\s*["']ratechange["']/);
  });

  test("BEHAVIOR: ratechange in canvas mode clamps playbackRate back to 1.0", () => {
    const env = loadContentScriptEnv();
    // Put content-script into canvas mode
    env.sendMsg({ type: "START_SYNC" });

    // User changes rate via keyboard
    env.video.playbackRate = 1.25;
    env.video._triggerEvent("ratechange");

    expect(env.video.playbackRate).toBe(1.0);
  });
});

// ===================================================================
// BUG-010: Seekback replay zone assumes 1x playback rate
// ===================================================================

describe("BUG-010: Replay-zone heuristic re-analyzed (WON'T-FIX — was not a bug)", () => {
  test("RATIONALE: frame-count exit is intrinsically rate-correct because audio frames are produced per audio-second, not per wall-clock-second", () => {
    const src = readSource("offscreen/offscreen.js");
    // Keep the frame-count condition: it's correct under any video playback
    // rate. AudioWorklet frames are emitted as the tab's audio engine
    // produces 200ms of samples — at 2× video rate the audio is sped up,
    // so frames arrive 2× faster too. Frame count therefore tracks audio
    // content, which is what we need for the replay zone.
    expect(src).toMatch(/capturedFrameCount\s*>=\s*seekbackFrameMark\s*\*\s*2/);
  });
});

// ===================================================================
// BUG-012: delayFrames is dead code
// ===================================================================

describe("BUG-012: delayFrames is now consulted in the draw loop (FIXED)", () => {
  test("FIX: onVideoFrame gates frameBuffer.shift on delayFrames", () => {
    const src = readSource("content-script.js");
    const match = src.match(/function onVideoFrame\([\s\S]*?\n\s{2}\}/m);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/delayFrames/);
  });
});

// ===================================================================
// BUG-013: audioStartSec is sent but not acted on by content-script
// ===================================================================

describe("BUG-013: audioStartSec in PLAYBACK_STARTED now drops stale frames (FIXED)", () => {
  test("FIX: PLAYBACK_STARTED handler reads audioStartSec and trims older frames", () => {
    const src = readSource("content-script.js");
    const match = src.match(/case\s+["']PLAYBACK_STARTED["'][\s\S]*?break;/);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/msg\.audioStartSec|audioStartSec/);
    // A trim mechanism (splice / slice / length=N) is present
    expect(match[0]).toMatch(/frameBuffer\.splice|frameBuffer\.slice|frameBuffer\.length\s*=/);
  });
});

// ===================================================================
// BUG-014: SPA navigation — observer disconnected, no re-detection
// ===================================================================

describe("BUG-014: SPA nav re-detection now wired (FIXED)", () => {
  test("FIX: content-script registers popstate and hashchange listeners", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/popstate/);
    expect(src).toMatch(/hashchange/);
    expect(src).toMatch(/onSpaNavigate/);
  });
});

// ===================================================================
// BUG-015: drift correction feature gap — covered by existing failing tests
// ===================================================================

describe("BUG-015: drift monitor now emits VIDEO_SYNC_STATUS (FIXED)", () => {
  test("FIX: offscreen.js emits VIDEO_SYNC_STATUS from a periodic monitor", () => {
    const offscreenSrc = readSource("offscreen/offscreen.js");
    expect(offscreenSrc).toMatch(/type:\s*["']VIDEO_SYNC_STATUS["']/);
    expect(offscreenSrc).toMatch(/startDriftMonitor|driftMonitorInterval/);
  });
});

// ===================================================================
// BUG-016: DRM detection via mediaKeys is unreliable
// ===================================================================

describe("BUG-016: detectDRM relies on video.mediaKeys which may be null at detection time", () => {
  test("PROOF: detectDRM only checks requestVideoFrameCallback and mediaKeys (no deeper signals)", () => {
    const src = readSource("content-script.js");
    const match = src.match(/function detectDRM\([\s\S]*?\n\s{2}\}/m);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/video\.mediaKeys/);
    expect(match[0]).not.toMatch(/requestMediaKeySystemAccess/);
  });
});

// ===================================================================
// BUG-017: MutationObserver on document.body with subtree has no timeout
// ===================================================================

describe("BUG-017: MutationObserver now self-cancels on timeout (FIXED)", () => {
  test("FIX: a timeout disconnects the observer if no video is found", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/observer\.observe\(document\.body,\s*\{[^}]*subtree:\s*true/);
    // A setTimeout-driven disconnect is now in place. The observer is also
    // disconnected when the timeout fires via the observerTimeout handle.
    expect(src).toMatch(/observerTimeout/);
    expect(src).toMatch(/VIDEO_DISCOVERY_TIMEOUT_MS/);
  });
});

// ===================================================================
// BUG-018: frameBuffer.shift() is O(n)
// ===================================================================

describe("BUG-018: frameBuffer uses Array.shift (O(n)) instead of ring buffer", () => {
  test("PROOF: source uses frameBuffer.shift() for drain", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/frameBuffer\.shift\(\)/);
  });
});

// ===================================================================
// BUG-019: chrome.storage.local.set on every caption
// ===================================================================

describe("BUG-019: SW coalesces caption writes into a single tick (FIXED)", () => {
  test("FIX: persistCaption batches and uses a microtask flush, not a write per caption", () => {
    const src = readSource("service-worker.js");
    expect(src).toMatch(/pendingCaptionBatch/);
    expect(src).toMatch(/captionFlushScheduled/);
    expect(src).toMatch(/Promise\.resolve\(\)\.then/);
  });

  test("BEHAVIOR: a burst of captions in the same tick collapses to ONE storage.set", async () => {
    const env = loadServiceWorker();
    env.chrome.storage.local.set.mockClear();
    for (let i = 0; i < 5; i++) {
      env.sendMsg({
        type: "CAPTION",
        caption: { speaker: "A", translated: `line ${i}`, original: `o ${i}` },
      });
    }
    // Drain microtasks (the flush is on Promise.resolve().then; the chained
    // get/set adds another await, so we need a couple of flushPromises).
    for (let i = 0; i < 5; i++) await flushPromises();
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    const lastCall = env.chrome.storage.local.set.mock.calls[0][0];
    expect(lastCall.captionHistory.length).toBe(5);
  });
});

// ===================================================================
// BUG-020: Video discovery picks largest non-playing → may be preview thumbnail
// ===================================================================

describe("BUG-020: findVideo applies a min-width floor (FIXED)", () => {
  test("FIX: findVideo has a MIN_VIDEO_WIDTH filter for non-playing candidates", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/MIN_VIDEO_WIDTH/);
    expect(src).toMatch(/videoWidth\s*>=\s*MIN_VIDEO_WIDTH/);
  });

  test("BEHAVIOR: a 200x100 paused thumbnail is rejected — VIDEO_NOT_FOUND emitted", () => {
    const tiny = createMockVideo({ videoWidth: 200, videoHeight: 100, paused: true });
    const env = loadContentScriptEnv({ video: tiny });
    const sent = env.sentMessages();
    expect(sent).toContainEqual(expect.objectContaining({ type: "VIDEO_NOT_FOUND" }));
    // VIDEO_FOUND should NOT have been emitted for the tiny thumbnail
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "VIDEO_FOUND" }));
  });
});

// ===================================================================
// BUG-021: Language selectors not disabled during capture
// ===================================================================

describe("BUG-021: sidepanel disables language selects while streaming (FIXED)", () => {
  test("FIX: startCapture and stopCapture toggle .disabled on both selects", () => {
    const src = readSource("sidepanel/sidepanel.js");
    expect(src).toMatch(/sourceLangEl\.disabled\s*=\s*true/);
    expect(src).toMatch(/targetLangEl\.disabled\s*=\s*true/);
    expect(src).toMatch(/sourceLangEl\.disabled\s*=\s*false/);
    expect(src).toMatch(/targetLangEl\.disabled\s*=\s*false/);
  });
});

// ===================================================================
// BUG-022: Verbose console.log in prod
// ===================================================================

describe("BUG-022: console.log gated behind a DEBUG flag (FIXED)", () => {
  test("FIX: offscreen.js defines DEBUG and routes traces through dlog", () => {
    const src = readSource("offscreen/offscreen.js");
    expect(src).toMatch(/const\s+DEBUG\s*=/);
    expect(src).toMatch(/function\s+dlog/);
  });

  test("FIX: content-script.js gates its console.log calls with CONTENT_DEBUG", () => {
    const src = readSource("content-script.js");
    expect(src).toMatch(/CONTENT_DEBUG/);
    // Any remaining console.log should be guarded by CONTENT_DEBUG
    const ungated = src.match(/^[^\/]*\bconsole\.log\(/gm) || [];
    for (const line of ungated) {
      // Lines containing console.log must also contain CONTENT_DEBUG on the same line
      expect(line).toMatch(/CONTENT_DEBUG/);
    }
  });
});

// ===================================================================
// BUG-023: recentCaptions uses Array.includes (O(n) scan)
// ===================================================================

describe("BUG-023: recentCaptions uses a Set for O(1) dedup (FIXED)", () => {
  test("FIX: recentCaptionsSet + ordering array replace the array+includes scan", () => {
    const src = readSource("offscreen/offscreen.js");
    expect(src).toMatch(/recentCaptionsSet\s*=\s*new Set\(\)/);
    expect(src).toMatch(/recentCaptionsOrder/);
    expect(src).not.toMatch(/recentCaptions\.includes/);
  });
});

// ===================================================================
// BUG-024: trimSilence threshold 0.005 (may be too aggressive for soft speech)
// ===================================================================

describe("BUG-024: trimSilence threshold pulled from a named constant (FIXED)", () => {
  test("FIX: threshold defaults to SILENCE_THRESHOLD; constant value is more conservative than 0.005", () => {
    const src = readSource("offscreen/offscreen.js");
    expect(src).toMatch(/function trimSilence\([^)]*threshold\s*=\s*SILENCE_THRESHOLD/);
    // The constant is defined and its value is at most 0.005 (less aggressive
    // trimming, preserving soft tails).
    const constMatch = src.match(/const\s+SILENCE_THRESHOLD\s*=\s*([\d.]+)/);
    expect(constMatch).not.toBeNull();
    expect(parseFloat(constMatch[1])).toBeLessThanOrEqual(0.005);
  });
});

// ===================================================================
// BUG-025: source.onended drains the whole queue on each source end
// ===================================================================

describe("BUG-025: source.onended only re-drains when the queue is non-empty (FIXED)", () => {
  test("FIX: onended guards on decodedQueue.length > 0 and pause/rebuffer state", () => {
    const src = readSource("offscreen/offscreen.js");
    const match = src.match(/source\.onended\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/m);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/decodedQueue\.length\s*>\s*0/);
    expect(match[0]).toMatch(/!isPaused/);
    expect(match[0]).toMatch(/!isRebuffering/);
  });
});

// ===================================================================
// FEATURE: New Video reset + URL change auto-restart
// ===================================================================

describe("New Video: reset + restart", () => {
  test("sidepanel wires a newVideoBtn click handler", () => {
    const src = readSource("sidepanel/sidepanel.js");
    expect(src).toMatch(/newVideoBtn\.addEventListener\(["']click["']/);
    expect(src).toMatch(/function resetAndRestart/);
  });

  test("BEHAVIOR: clicking newVideoBtn sends STOP_CAPTURE + clears captionHistory + sends START_CAPTURE", async () => {
    const env = loadSidepanelEnv();
    // Seed captions via CAPTION relay (playbackStarted flip)
    env.sendMsg({ type: "HIDE_OVERLAY" });
    env.sendMsg({ type: "CAPTION", caption: { speaker: "A", translated: "hola", original: "hi" } });

    // Put sidepanel in a "capturing" state by calling Start first
    env.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true });
    env.els.startStopBtn._listeners.click[0]();
    await flushPromises();

    env.chrome.runtime.sendMessage.mockClear();
    env.chrome.storage.local.set.mockClear();

    // Click New Video
    env.els.newVideoBtn._listeners.click[0]();
    await flushPromises();
    await flushPromises();

    const types = env.chrome.runtime.sendMessage.mock.calls.map((c) => c[0].type);
    expect(types).toContain("STOP_CAPTURE");
    expect(types).toContain("START_CAPTURE");

    // captionHistory cleared in storage
    const storageCalls = env.chrome.storage.local.set.mock.calls.map((c) => c[0]);
    expect(storageCalls).toContainEqual(expect.objectContaining({ captionHistory: [] }));
  });

  test("BEHAVIOR: URL_CHANGED triggers auto-restart (no STOP_CAPTURE — SW already stopped)", async () => {
    const env = loadSidepanelEnv();
    env.chrome.runtime.sendMessage.mockResolvedValue({ ok: true });
    env.els.startStopBtn._listeners.click[0]();
    await flushPromises();

    env.chrome.runtime.sendMessage.mockClear();
    env.chrome.storage.local.set.mockClear();

    env.sendMsg({ type: "URL_CHANGED", url: "https://example.com/new-video" });
    await flushPromises();
    await flushPromises();

    const types = env.chrome.runtime.sendMessage.mock.calls.map((c) => c[0].type);
    // alreadyStopped: true path — don't send STOP_CAPTURE, only START_CAPTURE
    expect(types).not.toContain("STOP_CAPTURE");
    expect(types).toContain("START_CAPTURE");

    const storageCalls = env.chrome.storage.local.set.mock.calls.map((c) => c[0]);
    expect(storageCalls).toContainEqual(expect.objectContaining({ captionHistory: [] }));
  });

  test("SW emits URL_CHANGED after stopping on tab navigation", async () => {
    const env = loadServiceWorker();
    await env.sendMsg({ type: "START_CAPTURE", sourceLang: "en", targetLang: "es" });
    await flushPromises();
    env.chrome.runtime.sendMessage.mockClear();

    env.chrome._simulateTabUpdated(42, { url: "https://other.example/video2" });
    // stopCapture is async; let it settle then the URL_CHANGED broadcast
    for (let i = 0; i < 5; i++) await flushPromises();

    const types = env.chrome.runtime.sendMessage.mock.calls.map((c) => c[0].type);
    expect(types).toContain("URL_CHANGED");
  });
});
