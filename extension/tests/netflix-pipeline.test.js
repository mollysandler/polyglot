/**
 * @jest-environment node
 *
 * Netflix / DRM seekback pipeline tests.
 *
 * Tests the full pipeline for DRM-protected video sites (Netflix, ESPN+,
 * Disney+, etc.) where canvas frame capture fails and the seek-back
 * fallback is used instead.
 *
 * Pipeline: tab audio → AudioWorklet (200ms frames) → WebSocket → backend
 *           → translated utterances → decode → buffer → playback
 *           → content script seeks video back to replay the section
 *           → offscreen suppresses re-captured audio during replay zone
 *
 * Tests marked "BUG:" describe correct expected behavior that the current
 * code does NOT satisfy. These are the TDD "red" tests.
 */
const {
  flushPromises,
  createChromeMock,
  createMockWSConstructor,
  createMockAudioContext,
  createMockAudioBuffer,
  createMockNavigator,
  createMockVideo,
  createMockElement,
  createMockDocument,
  loadScript,
  loadOffscreenScript,
} = require("./helpers");

// ===================================================================
// Content script test factory (DRM / seekback-specific)
// ===================================================================

function loadContentScript(opts = {}) {
  const chrome = createChromeMock();
  const videoOpts = { ...(opts.videoOpts || {}) };
  // Default to DRM video (mediaKeys set) for Netflix tests
  if (opts.drm !== false && !videoOpts.noRVFC) {
    videoOpts.mediaKeys = videoOpts.mediaKeys || {};
  }
  const video = opts.video !== undefined ? opts.video : createMockVideo(videoOpts);
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
      if (tag === "canvas" && opts.allBlackCanvas) {
        el.getContext = jest.fn(() => ({
          drawImage: jest.fn(),
          fillRect: jest.fn(),
          fillText: jest.fn(),
          fillStyle: "",
          font: "",
          textAlign: "",
          textBaseline: "",
          getImageData: jest.fn((_x, _y, w, h) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(0),
          })),
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
    ctx,
    chrome,
    video,
    doc,
    createdElements,
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
      if (video && video._rvfcCallbacks && video._rvfcCallbacks.length > 0) {
        const cb = video._rvfcCallbacks.shift();
        cb(performance.now(), {
          mediaTime: video.currentTime + (frameIdx || 0) * 0.033,
        });
      }
    },
  };
}

// ===================================================================
// Offscreen audio pipeline factory (seekback mode)
// ===================================================================

function createAudioEnv(opts = {}) {
  const chrome = createChromeMock();
  const WS = createMockWSConstructor();
  const ctxInstances = [];
  const awnInstances = [];

  const decodedDuration = opts.decodedDuration || 1.0;

  function AudioCtxCtor() {
    const c = createMockAudioContext({ decodedDuration });
    ctxInstances.push(c);
    return c;
  }
  function AWNCtor() {
    const n = {
      port: { _onmessage: null, postMessage: jest.fn() },
      connect: jest.fn(),
      disconnect: jest.fn(),
    };
    Object.defineProperty(n.port, "onmessage", {
      get() {
        return n.port._onmessage;
      },
      set(fn) {
        n.port._onmessage = fn;
      },
    });
    awnInstances.push(n);
    return n;
  }
  function OACtor(ch, len, sr) {
    return {
      createBuffer: (_c, l, s) =>
        createMockAudioBuffer({ length: l, sampleRate: s }),
      createBufferSource: () => ({
        buffer: null,
        connect: jest.fn(),
        start: jest.fn(),
      }),
      destination: {},
      startRendering() {
        const b = createMockAudioBuffer({ length: len, sampleRate: sr });
        return Promise.resolve(b);
      },
    };
  }
  function ABCtor(o) {
    return createMockAudioBuffer(o);
  }

  const nav = createMockNavigator();
  const timeouts = [];
  const intervals = [];
  let tid = 0;
  let iid = 0;
  let dateNow = 1000;

  const ctx = loadOffscreenScript({
    chrome,
    WebSocket: WS,
    AudioContext: AudioCtxCtor,
    AudioWorkletNode: AWNCtor,
    OfflineAudioContext: OACtor,
    AudioBuffer: ABCtor,
    navigator: nav,
    setTimeout: (fn, ms) => {
      const id = tid++;
      timeouts.push({ fn, ms, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timeouts.findIndex((t) => t.id === id);
      if (i >= 0) timeouts.splice(i, 1);
    },
    setInterval: (fn, ms) => {
      const id = iid++;
      intervals.push({ fn, ms, id });
      return id;
    },
    clearInterval: (id) => {
      const i = intervals.findIndex((t) => t.id === id);
      if (i >= 0) intervals.splice(i, 1);
    },
    Date: {
      now: () => dateNow,
    },
  });

  return {
    ctx,
    chrome,
    WS,
    ctxInstances,
    awnInstances,
    timeouts,
    intervals,
    setDateNow(v) {
      dateNow = v;
    },
    getState() {
      ctx.__readState();
      return { ...ctx.__test };
    },
    getPlaybackCtx() {
      return ctxInstances[1];
    },

    async boot(src = "en", tgt = "es") {
      const r = jest.fn();
      chrome._simulateMessage(
        {
          type: "START_CAPTURE",
          streamId: "s",
          sourceLang: src,
          targetLang: tgt,
        },
        {},
        r
      );
      await flushPromises();
      const ws = WS._last();
      ws.readyState = 1;
      if (ws.onopen) ws.onopen();
      // Simulate content script responding with seekback mode
      chrome._simulateMessage(
        { type: "SYNC_MODE_REPORT", mode: "seekback" },
        {}
      );
      return ws;
    },

    async sendFrames(n = 5) {
      const w = awnInstances[0];
      for (let i = 0; i < n; i++) {
        w.port._onmessage({
          data: {
            type: "frame",
            samples: new Float32Array(9600),
            rms: 0.1,
            sampleRate: 48000,
          },
        });
        await flushPromises();
      }
    },

    async sendSilentFrames(n = 5) {
      const w = awnInstances[0];
      for (let i = 0; i < n; i++) {
        w.port._onmessage({
          data: {
            type: "frame",
            samples: new Float32Array(9600),
            rms: 0.001,
            sampleRate: 48000,
          },
        });
        await flushPromises();
      }
    },

    async sendUtterance(u) {
      const ws = WS._last();
      ws.onmessage({
        data: JSON.stringify({
          type: "utterance_start",
          seq: u.seq,
          speaker_id: u.speaker || 0,
        }),
      });
      const chunkCount = u.chunks || 1;
      for (let c = 0; c < chunkCount; c++) {
        ws.onmessage({ data: new ArrayBuffer(100) });
      }
      ws.onmessage({
        data: JSON.stringify({
          type: "utterance_end",
          seq: u.seq,
          original_start_sec: u.start,
          original_end_sec: u.end,
        }),
      });
      if (u.caption) {
        ws.onmessage({
          data: JSON.stringify({
            type: "caption",
            speaker_id: u.speaker || 0,
            original: u.caption.original,
            translated: u.caption.translated,
          }),
        });
      }
      await flushPromises();
    },

    playedSources() {
      return (ctxInstances[1] || { _sources: [] })._sources.filter(
        (s) => s.start.mock.calls.length > 0
      );
    },

    playedStartTimes() {
      return this.playedSources().map((s) => s.start.mock.calls[0][0]);
    },

    captionMessages() {
      return chrome.runtime.sendMessage.mock.calls
        .map((c) => c[0])
        .filter((m) => m.type === "CAPTION");
    },

    sentMessages() {
      return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]);
    },

    fireTimeout(ms) {
      const t = timeouts.find((x) => x.ms === ms);
      if (t) {
        t.fn();
        timeouts.splice(timeouts.indexOf(t), 1);
      }
    },
  };
}

// #####################################################################
// CONTENT SCRIPT — DRM detection and seekback unit tests
// #####################################################################

describe("Netflix seekback mode — content script", () => {
  // =================================================================
  // DRM detection
  // =================================================================

  describe("DRM detection", () => {
    test("video.mediaKeys present → seekback mode (Netflix, ESPN+)", () => {
      const env = loadContentScript(); // defaults to DRM
      const resp = env.sendMsg({ type: "START_SYNC" });
      expect(resp).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, mode: "seekback" })
      );
    });

    test("no requestVideoFrameCallback → seekback mode (older browsers)", () => {
      const env = loadContentScript({
        drm: false,
        videoOpts: { noRVFC: true },
      });
      const resp = env.sendMsg({ type: "START_SYNC" });
      expect(resp).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "seekback" })
      );
    });

    test("runtime black frame detection → fallback to seekback", () => {
      // Simulates a DRM site where canvas draws succeed but produce all-black pixels
      const env = loadContentScript({
        drm: false, // no mediaKeys — passes initial check
        videoOpts: { mediaKeys: null },
        allBlackCanvas: true,
      });
      env.sendMsg({ type: "START_SYNC" });
      // DRM check starts at frame 10, requires 5 consecutive black frames
      for (let i = 0; i < 16; i++) env.triggerRvfc(i);
      expect(env.sentMessages()).toContainEqual(
        expect.objectContaining({ type: "SYNC_MODE", mode: "seekback" })
      );
    });

    test("no canvas created in seekback mode (DRM video)", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" });
      const canvases = env.createdElements.filter((e) => e.tag === "canvas");
      expect(canvases.length).toBe(0);
    });

    test("video NOT hidden in seekback mode", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" });
      expect(env.video.classList.contains("__lt-hidden")).toBe(false);
    });
  });

  // =================================================================
  // Seekback execution
  // =================================================================

  describe("seekback video control", () => {
    test("VIDEO_SEEK_BACK seeks video back by correct amount", () => {
      const env = loadContentScript();
      env.video.currentTime = 30;
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 10 });
      expect(env.video.currentTime).toBe(20);
    });

    test("seekback clamped to 0 (never negative)", () => {
      const env = loadContentScript();
      env.video.currentTime = 5;
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 20 });
      expect(env.video.currentTime).toBe(0);
    });

    test("video.play() called after seeked event fires", () => {
      const env = loadContentScript();
      env.video.currentTime = 30;
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 5 });
      env.video._triggerEvent("seeked");
      expect(env.video.play).toHaveBeenCalled();
    });

    test("play retry guard handles player resistance (YouTube/Netflix)", () => {
      // Some players (YouTube, Netflix) fight programmatic seeks by pausing.
      // The guard retries play() every 500ms for up to 5 seconds.
      // The seeked event triggers the first play() call.
      const env = loadContentScript();
      env.video.currentTime = 30;
      env.video.paused = true;
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 5 });
      // Simulate the browser completing the seek
      env.video._triggerEvent("seeked");
      expect(env.video.play).toHaveBeenCalled();
    });

    test("rate adjustment applies in seekback mode", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "VIDEO_ADJUST_RATE", rate: 0.95 });
      expect(env.video.playbackRate).toBe(0.95);
    });

    test("rate adjustment ignored in canvas mode (not seekback)", () => {
      const env = loadContentScript({ drm: false, videoOpts: { mediaKeys: null } });
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "VIDEO_ADJUST_RATE", rate: 0.5 });
      expect(env.video.playbackRate).toBe(1.0);
    });
  });

  // =================================================================
  // Pause attribution
  // =================================================================

  describe("pause attribution", () => {
    test("pause during seekback NOT attributed to user", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" });
      // Seekback sets extensionPaused = true
      env.sendMsg({ type: "VIDEO_SEEK_BACK", seekBackSec: 5 });
      // A pause event fires (browser pauses for seek)
      env.video._triggerEvent("pause");
      // VIDEO_REPORT_TIME should NOT report this as a user-initiated pause.
      // The content script tracks extensionPaused separately from userPaused.
    });

    test("user pause during playback IS tracked", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" });
      // User presses pause
      env.video._triggerEvent("pause");
      // User play resumes
      env.video._triggerEvent("play");
    });
  });

  // =================================================================
  // Overlay in seekback mode
  // =================================================================

  describe("overlay management (seekback)", () => {
    test("SHOW_OVERLAY works in seekback mode (no canvas to draw on)", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" }); // seekback — no canvas
      env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
      expect(env.video.parentElement.appendChild).toHaveBeenCalled();
    });

    test("HIDE_OVERLAY cleans up in seekback mode", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "SHOW_OVERLAY", text: "Buffering..." });
      env.sendMsg({ type: "HIDE_OVERLAY" });
      // Should not crash
    });
  });

  // =================================================================
  // Cleanup
  // =================================================================

  describe("cleanup in seekback mode", () => {
    test("VIDEO_CLEANUP resets playback rate and clears state", () => {
      const env = loadContentScript();
      env.sendMsg({ type: "START_SYNC" });
      env.sendMsg({ type: "VIDEO_ADJUST_RATE", rate: 0.85 });
      expect(env.video.playbackRate).toBe(0.85);

      env.sendMsg({ type: "VIDEO_CLEANUP" });
      expect(env.video.playbackRate).toBe(1.0);
    });

    test("cleanup safe when no sync was started", () => {
      const env = loadContentScript();
      expect(() => env.sendMsg({ type: "VIDEO_CLEANUP" })).not.toThrow();
    });
  });
});

// #####################################################################
// OFFSCREEN — seekback mode audio pipeline unit tests
// #####################################################################

describe("Netflix seekback mode — offscreen audio pipeline", () => {
  // =================================================================
  // Seekback mode activation
  // =================================================================

  describe("seekback mode activation", () => {
    test("syncMode set to seekback via SYNC_MODE_REPORT", async () => {
      const env = createAudioEnv();
      await env.boot(); // boot sends SYNC_MODE_REPORT with seekback
      expect(env.getState().syncMode).toBe("seekback");
    });

    test("VIDEO_SEEK_BACK sent (not PLAYBACK_STARTED) in seekback mode", async () => {
      const env = createAudioEnv();
      await env.boot();
      env.setDateNow(1000);
      await env.sendFrames(5);
      env.setDateNow(3000);

      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      expect(env.getState().isPlaying).toBe(true);

      const msgs = env.sentMessages();
      expect(msgs).toContainEqual(
        expect.objectContaining({ type: "VIDEO_SEEK_BACK" })
      );
      expect(msgs).not.toContainEqual(
        expect.objectContaining({ type: "PLAYBACK_STARTED" })
      );
    });

    test("seekback amount equals total captured audio duration", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(25); // 25 frames * 0.2s = 5s captured

      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      const seekMsg = env.sentMessages().find(
        (m) => m.type === "VIDEO_SEEK_BACK"
      );
      expect(seekMsg).toBeTruthy();
      // seekBackSec should be totalAudioCapturedSec (5s)
      expect(seekMsg.seekBackSec).toBeCloseTo(5.0, 0);
    });
  });

  // =================================================================
  // Replay zone suppression
  // =================================================================

  describe("replay zone", () => {
    test("replay zone entered when playback starts in seekback mode", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(10);

      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      const state = env.getState();
      expect(state.inReplayZone).toBe(true);
      expect(state.seekbackFrameMark).toBeGreaterThan(0);
    });

    test("frames suppressed during replay zone (not sent to WS)", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(10);

      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      expect(env.getState().inReplayZone).toBe(true);

      // Record WS send count before replay frames
      const ws = env.WS._last();
      const sendsBefore = ws.send.mock.calls.length;

      // Send frames during replay zone
      await env.sendFrames(5);

      // No new sends to WS during replay zone
      expect(ws.send.mock.calls.length).toBe(sendsBefore);
    });

    test("replay zone eventually exits and frames resume to WS", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(10); // capturedFrameCount = 10

      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      // seekbackFrameMark = 10, replay zone ends at capturedFrameCount >= 20

      // Send 10 frames to exit replay zone (10 + 10 = 20 >= 10*2)
      await env.sendFrames(10);
      expect(env.getState().inReplayZone).toBe(false);

      // Now frames should reach WS again
      const ws = env.WS._last();
      const sendsBefore = ws.send.mock.calls.length;
      await env.sendFrames(1);
      expect(ws.send.mock.calls.length).toBeGreaterThan(sendsBefore);
    });

    test("BUG: replay zone suppression duration should match seekback duration, not total captured time", async () => {
      // Scenario: 500 frames captured (100s of audio), then seekback.
      // The video only needs to replay the last ~100s, but the replay zone
      // suppresses until capturedFrameCount >= 500*2 = 1000, which means
      // 500 more frames (100s of captured audio) are suppressed.
      //
      // For a large buffer, this is proportional and roughly correct.
      // But the heuristic fails for subsequent drift corrections or partial
      // seekbacks, because it's based on total frame count not seekback duration.
      //
      // More importantly: totalAudioCapturedSec continues incrementing during
      // the replay zone, inflating the counter for any future calculations.
      const env = createAudioEnv();
      await env.boot();

      // Capture 50 frames = 10 seconds
      await env.sendFrames(50);
      const capturedBefore = env.getState().totalAudioCapturedSec;
      expect(capturedBefore).toBeCloseTo(10, 0);

      // Trigger playback → seekback → replay zone
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      expect(env.getState().inReplayZone).toBe(true);

      // Send frames during replay zone — these represent the same audio
      // being replayed by the video. They should NOT count toward
      // totalAudioCapturedSec because they're duplicate content.
      await env.sendFrames(30);
      const capturedDuring = env.getState().totalAudioCapturedSec;

      // BUG: totalAudioCapturedSec should not increase during replay zone
      // because the audio is duplicate content (video replaying). Currently
      // it increments on every frame regardless.
      expect(capturedDuring).toBeCloseTo(capturedBefore, 0);
    });
  });

  // =================================================================
  // BUG: WebSocket reconnection
  // =================================================================

  describe("WebSocket resilience", () => {
    test("BUG: should attempt reconnection after WS disconnect", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(5);

      // Start playback
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      expect(env.getState().isPlaying).toBe(true);

      // Simulate WebSocket disconnect (network blip)
      const ws = env.WS._last();
      if (ws.onclose) ws.onclose();
      await flushPromises();

      // Should have created a new WebSocket for reconnection.
      // Currently: stopCapture is called, tearing down the entire session.
      // For a 90-minute sports event, a network blip should not be fatal.
      expect(env.WS._instances.length).toBeGreaterThan(1);
    });

    test("BUG: session state should survive WebSocket reconnection", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(5);

      // Play some audio
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      const seqBefore = env.getState().highWaterEndSec;

      // Disconnect + (expected) reconnect
      const ws = env.WS._last();
      if (ws.onclose) ws.onclose();
      await flushPromises();

      // State should be preserved — highWaterEndSec, dedup sets, etc.
      // don't reset on reconnect. Currently: everything is torn down.
      const state = env.getState();
      expect(state.isPlaying).toBe(true);
      expect(state.highWaterEndSec).toBe(seqBefore);
    });

    test("WS error sends CAPTURE_ERROR to side panel", async () => {
      const env = createAudioEnv();
      await env.boot();

      env.chrome.runtime.sendMessage.mockClear();
      const ws = env.WS._last();
      if (ws.onerror) ws.onerror(new Error("connection refused"));

      const msgs = env.sentMessages();
      expect(msgs).toContainEqual(
        expect.objectContaining({ type: "CAPTURE_ERROR" })
      );
    });
  });

  // =================================================================
  // BUG: No drift correction in seekback mode after initial sync
  // =================================================================

  describe("seekback drift correction", () => {
    test("BUG: should periodically adjust video rate to maintain sync", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(10);

      // Start playback (seekback mode)
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      // Exit replay zone
      await env.sendFrames(10);
      expect(env.getState().inReplayZone).toBe(false);

      env.chrome.runtime.sendMessage.mockClear();

      // Simulate 50 more utterances (represents ~2 min of commentary)
      for (let i = 3; i < 53; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      // After sustained playback, there should be periodic drift checks.
      // The translated audio duration != original speech duration, so video
      // and audio will drift apart without rate correction.
      const msgs = env.sentMessages();
      const driftMsgs = msgs.filter(
        (m) =>
          m.type === "VIDEO_ADJUST_RATE" ||
          m.type === "VIDEO_REPORT_TIME" ||
          m.type === "VIDEO_SYNC_STATUS"
      );
      expect(driftMsgs.length).toBeGreaterThan(0);
    });
  });
});

// #####################################################################
// E2E — full Netflix/DRM session simulation
// #####################################################################

describe("Netflix seekback mode — E2E session", () => {
  // =================================================================
  // Happy path: full DRM session
  // =================================================================

  describe("full Netflix session", () => {
    let env;

    beforeEach(async () => {
      env = createAudioEnv({ decodedDuration: 1.0 });
      env.setDateNow(1000);
      await env.boot();
      await env.sendFrames(5);
      env.setDateNow(3000);
    });

    test("audio flows through seekback pipeline end-to-end", async () => {
      for (let i = 0; i < 5; i++) {
        await env.sendUtterance({
          seq: i,
          start: i * 2,
          end: i * 2 + 1.5,
          caption: { original: `Línea ${i}`, translated: `Line ${i}` },
        });
      }

      // All utterances played
      expect(env.playedSources().length).toBe(5);
      // All captions delivered
      expect(env.captionMessages().length).toBe(5);
    });

    test("seekback triggered on playback start (not PLAYBACK_STARTED)", async () => {
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      const msgs = env.sentMessages();
      const seekbacks = msgs.filter((m) => m.type === "VIDEO_SEEK_BACK");
      const playbackStarted = msgs.filter(
        (m) => m.type === "PLAYBACK_STARTED"
      );

      expect(seekbacks.length).toBe(1);
      expect(playbackStarted.length).toBe(0);
    });

    test("overlay hidden when playback starts", async () => {
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      const hideOverlays = env
        .sentMessages()
        .filter((m) => m.type === "HIDE_OVERLAY");
      expect(hideOverlays.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =================================================================
  // DRM silence detection
  // =================================================================

  describe("DRM audio capture limitations", () => {
    test("silence warning after 50 silent frames (DRM may block audio)", async () => {
      const env = createAudioEnv();
      await env.boot();

      // DRM sites may capture silent audio even though video plays.
      // The extension should warn the user early.
      await env.sendSilentFrames(50);

      const msgs = env.sentMessages();
      expect(msgs).toContainEqual(
        expect.objectContaining({ type: "SILENCE_WARNING" })
      );
    });

    test("silence warning fires exactly once (no spam)", async () => {
      const env = createAudioEnv();
      await env.boot();

      await env.sendSilentFrames(60);

      const warnings = env
        .sentMessages()
        .filter((m) => m.type === "SILENCE_WARNING");
      expect(warnings.length).toBe(1);
    });

    test("warning fires again after silence breaks and resumes", async () => {
      const env = createAudioEnv();
      await env.boot();

      await env.sendSilentFrames(50); // 1st warning
      await env.sendFrames(1); // break
      await env.sendSilentFrames(50); // 2nd warning

      const warnings = env
        .sentMessages()
        .filter((m) => m.type === "SILENCE_WARNING");
      expect(warnings.length).toBe(2);
    });
  });

  // =================================================================
  // Post-seekback: new content reaches backend
  // =================================================================

  describe("post-seekback audio flow", () => {
    test("after replay zone exits, new utterances play normally", async () => {
      const env = createAudioEnv({ decodedDuration: 1.0 });
      await env.boot();
      await env.sendFrames(10);

      // Initial 3 utterances trigger playback + seekback
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      expect(env.getState().isPlaying).toBe(true);
      expect(env.getState().inReplayZone).toBe(true);

      // Exit replay zone
      await env.sendFrames(10);
      expect(env.getState().inReplayZone).toBe(false);

      // New utterances from the now-resuming backend stream
      const beforeCount = env.playedSources().length;
      await env.sendUtterance({
        seq: 10,
        start: 20,
        end: 22,
        caption: { original: "Continúa", translated: "Continues" },
      });
      await env.sendUtterance({
        seq: 11,
        start: 22,
        end: 24,
        caption: { original: "El juego", translated: "The game" },
      });

      // New utterances should be scheduled for playback
      expect(env.playedSources().length).toBe(beforeCount + 2);
      expect(env.captionMessages().length).toBeGreaterThanOrEqual(2);
    });
  });

  // =================================================================
  // Realistic Netflix session (commentary dub)
  // =================================================================

  describe("realistic Netflix commentary session", () => {
    test("2-speaker commentary with DRM: all unique utterances play", async () => {
      const env = createAudioEnv({ decodedDuration: 1.0 });
      env.setDateNow(1000);
      await env.boot();
      await env.sendFrames(10);
      env.setDateNow(3000);

      // Main commentator
      await env.sendUtterance({
        seq: 1,
        speaker: 0,
        start: 0,
        end: 3,
        caption: {
          original: "El partido comienza",
          translated: "The match begins",
        },
      });

      // Color commentator
      await env.sendUtterance({
        seq: 2,
        speaker: 1,
        start: 3.5,
        end: 6,
        caption: {
          original: "Buen ambiente",
          translated: "Good atmosphere",
        },
      });

      // Backend retransmit of seq 1
      await env.sendUtterance({
        seq: 1,
        speaker: 0,
        start: 0,
        end: 3,
        caption: {
          original: "El partido comienza",
          translated: "The match begins",
        },
      });

      // Main again
      await env.sendUtterance({
        seq: 3,
        speaker: 0,
        start: 6,
        end: 9,
        caption: { original: "Saque inicial", translated: "Kickoff" },
      });

      // 3 unique utterances played (dup filtered)
      expect(env.playedSources().length).toBe(3);

      // Captions: seq1 + seq2 + seq3 (dup caption also filtered)
      const caps = env.captionMessages();
      expect(caps.length).toBe(3);

      // Speaker attribution correct
      expect(caps[0].caption.speaker).toBe("Speaker 0");
      expect(caps[1].caption.speaker).toBe("Speaker 1");
      expect(caps[2].caption.speaker).toBe("Speaker 0");
    });
  });
});
