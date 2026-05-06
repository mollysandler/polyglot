/**
 * @jest-environment node
 *
 * YouTube canvas pipeline tests.
 *
 * Tests the full pipeline for non-DRM video sites (YouTube, Twitch, etc.)
 * where canvas frame-delay mode is used for video sync.
 *
 * Pipeline: tab audio → AudioWorklet (200ms frames) → WebSocket → backend
 *           → translated utterances → decode → buffer → playback
 *           → content script delays video frames on canvas to match
 *
 * Tests marked "BUG:" describe correct expected behavior that the current
 * code does NOT satisfy. These are the TDD "red" tests — fix the code to
 * make them pass.
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
// Content script test factory (canvas-specific)
// ===================================================================

function loadContentScript(opts = {}) {
  const chrome = createChromeMock();
  const video =
    opts.video !== undefined
      ? opts.video
      : createMockVideo(opts.videoOpts || {});
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
      if (tag === "canvas") {
        // Cache the context like a real canvas — same object every getContext call.
        // Without this, the script and test get different context objects.
        let cachedCtx = null;
        el.getContext = jest.fn(() => {
          if (!cachedCtx) {
            cachedCtx = {
              drawImage: jest.fn(),
              fillRect: jest.fn(),
              fillText: jest.fn(),
              fillStyle: "",
              font: "",
              textAlign: "",
              textBaseline: "",
              getImageData: jest.fn(() => ({
                data: new Uint8ClampedArray(64).fill(128),
              })),
            };
          }
          return cachedCtx;
        });
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
      if (video && video._rvfcCallbacks.length > 0) {
        const cb = video._rvfcCallbacks.shift();
        cb(performance.now(), {
          mediaTime: video.currentTime + (frameIdx || 0) * 0.033,
        });
      }
    },
    canvasCount() {
      return createdElements.filter((e) => e.tag === "canvas").length;
    },
  };
}

// ===================================================================
// Offscreen audio pipeline factory (canvas mode)
// ===================================================================

function createAudioEnv(opts = {}) {
  const chrome = createChromeMock();
  const WS = createMockWSConstructor();
  const ctxInstances = [];
  const awnInstances = [];
  let oacCallCount = 0;

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
    oacCallCount++;
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
    get oacCallCount() {
      return oacCallCount;
    },
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
      // Simulate content script responding with canvas mode
      chrome._simulateMessage(
        { type: "SYNC_MODE_REPORT", mode: "canvas" },
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
// CONTENT SCRIPT — canvas mode (re-enabled with CSS dimension fix)
// #####################################################################

describe("YouTube canvas mode — content script", () => {
  test("selects canvas mode for non-DRM video", () => {
    const env = loadContentScript();
    const resp = env.sendMsg({ type: "START_SYNC" });
    expect(resp).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, mode: "canvas" })
    );
  });

  test("canvas element created and appended", () => {
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

  test("cleanup restores video and removes canvas", () => {
    const env = loadContentScript();
    env.sendMsg({ type: "START_SYNC" });
    env.sendMsg({ type: "VIDEO_CLEANUP" });
    expect(env.video.classList.contains("__lt-hidden")).toBe(false);
    expect(env.video.playbackRate).toBe(1.0);
  });
});

// #####################################################################
// OFFSCREEN — audio pipeline unit tests (canvas mode)
// #####################################################################

describe("YouTube canvas mode — offscreen audio pipeline", () => {
  // =================================================================
  // Pipeline latency measurement
  // =================================================================

  describe("pipeline latency", () => {
    test("measured on first utterance and sent to content script", async () => {
      const env = createAudioEnv();
      env.setDateNow(1000);
      await env.boot();
      await env.sendFrames(5);
      env.setDateNow(3500); // 2.5s after first frame

      await env.sendUtterance({ seq: 0, start: 0, end: 1.5 });

      const state = env.getState();
      expect(state.measuredLatencySec).toBeCloseTo(2.5, 1);
      expect(state.latencySentToContent).toBe(true);
      // SET_DELAY should have been sent to content script
      expect(env.sentMessages()).toContainEqual(
        expect.objectContaining({ type: "SET_DELAY" })
      );
    });

    test("latency only measured once (first utterance)", async () => {
      const env = createAudioEnv();
      env.setDateNow(1000);
      await env.boot();
      await env.sendFrames(5);
      env.setDateNow(3000);

      await env.sendUtterance({ seq: 0, start: 0, end: 1 });
      const firstLatency = env.getState().measuredLatencySec;

      env.setDateNow(10000);
      await env.sendUtterance({ seq: 1, start: 1, end: 2 });
      expect(env.getState().measuredLatencySec).toBeCloseTo(firstLatency, 1);
    });
  });

  // =================================================================
  // Canvas mode sync messages
  // =================================================================

  describe("canvas mode sync", () => {
    test("PLAYBACK_STARTED sent (not VIDEO_SEEK_BACK) in canvas mode", async () => {
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
        expect.objectContaining({ type: "PLAYBACK_STARTED" })
      );
      expect(msgs).not.toContainEqual(
        expect.objectContaining({ type: "VIDEO_SEEK_BACK" })
      );
    });

    test("HIDE_OVERLAY sent when playback starts", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(5);

      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      // HIDE_OVERLAY should be among the sent messages after playback starts
      const afterPlayback = env.sentMessages();
      const hideOverlays = afterPlayback.filter(
        (m) => m.type === "HIDE_OVERLAY"
      );
      expect(hideOverlays.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =================================================================
  // BUG: No drift monitoring after playback starts
  // =================================================================

  describe("drift correction", () => {
    test("BUG: should set up periodic drift monitoring after playback starts", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(5);

      const intervalsBefore = env.intervals.length;

      // Fill buffer and trigger playback
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      expect(env.getState().isPlaying).toBe(true);

      const intervalsAfter = env.intervals.length;

      // After playback starts in canvas mode, the offscreen document should
      // set up periodic polling of the video position (via VIDEO_REPORT_TIME
      // through the service worker) to detect and correct drift between the
      // translated audio playback and the canvas frame delay.
      //
      // Currently: no drift monitoring is set up. Over a 90-minute match,
      // even tiny clock-domain drift will compound into visible desync.
      expect(intervalsAfter).toBeGreaterThan(intervalsBefore);
    });

    test("BUG: should send drift correction messages during long playback", async () => {
      const env = createAudioEnv();
      await env.boot();
      await env.sendFrames(10);

      // Start playback
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      env.chrome.runtime.sendMessage.mockClear();

      // Simulate 100 more utterances (represents ~3 minutes of commentary)
      for (let i = 3; i < 103; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }

      // After sustained playback, at least one drift-related message should
      // have been sent (VIDEO_REPORT_TIME poll, or VIDEO_ADJUST_RATE correction).
      const msgs = env.sentMessages();
      const driftMsgs = msgs.filter(
        (m) =>
          m.type === "VIDEO_REPORT_TIME" ||
          m.type === "VIDEO_ADJUST_RATE" ||
          m.type === "VIDEO_SYNC_STATUS"
      );
      expect(driftMsgs.length).toBeGreaterThan(0);
    });
  });

  // =================================================================
  // BUG: OfflineAudioContext created per frame
  // =================================================================

  describe("audio resampling", () => {
    test("should not create OfflineAudioContext for resampling (sync resampler)", async () => {
      const env = createAudioEnv();
      await env.boot();

      const before = env.oacCallCount;
      await env.sendFrames(10);
      const created = env.oacCallCount - before;

      // Resampling from 48kHz to 16kHz should use the synchronous linear
      // interpolation resampler, not create a new OfflineAudioContext per frame.
      expect(created).toBe(0);
    });
  });

  // =================================================================
  // WebSocket URL — skipped, backend deployment may change
  // =================================================================
});

// #####################################################################
// E2E — full YouTube session simulation
// #####################################################################

describe("YouTube canvas mode — E2E session", () => {
  // =================================================================
  // Happy path: full session
  // =================================================================

  describe("full YouTube session", () => {
    let env;

    beforeEach(async () => {
      env = createAudioEnv({ decodedDuration: 1.0 });
      env.setDateNow(1000);
      await env.boot();
      await env.sendFrames(5);
      env.setDateNow(3000);
    });

    test("audio flows: capture → WS → decode → buffer → playback", async () => {
      // Simulate 5 utterances from the backend
      for (let i = 0; i < 5; i++) {
        await env.sendUtterance({
          seq: i,
          start: i * 2,
          end: i * 2 + 1.5,
          caption: { original: `Gol ${i}`, translated: `Goal ${i}` },
        });
      }

      // All 5 should be played
      expect(env.playedSources().length).toBe(5);
      // All 5 captions delivered
      expect(env.captionMessages().length).toBe(5);
    });

    test("playback starts after buffer threshold met, not before", async () => {
      // 1st utterance: 1s buffer (below 3s threshold)
      await env.sendUtterance({ seq: 0, start: 0, end: 1.5 });
      expect(env.getState().isPlaying).toBe(false);

      // 2nd: 2s total
      await env.sendUtterance({ seq: 1, start: 2, end: 3.5 });
      expect(env.getState().isPlaying).toBe(false);

      // 3rd: 3s total — meets threshold
      await env.sendUtterance({ seq: 2, start: 4, end: 5.5 });
      expect(env.getState().isPlaying).toBe(true);
    });

    test("audio plays in sequential order with correct timing", async () => {
      for (let i = 0; i < 5; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      const times = env.playedStartTimes();
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThan(times[i - 1]);
      }
    });

    test("natural speech gaps preserved in playback timing", async () => {
      // 1.5s gap between utterance 0 end (1.5s) and utterance 1 start (3s)
      await env.sendUtterance({ seq: 0, start: 0, end: 1.5 });
      await env.sendUtterance({ seq: 1, start: 3, end: 4.5 });
      await env.sendUtterance({ seq: 2, start: 4.5, end: 6 });

      const times = env.playedStartTimes();
      const gap = times[1] - (times[0] + 1.0); // start[1] - (start[0] + duration)
      expect(gap).toBeCloseTo(1.5, 1);
    });

    test("captions attributed to correct speakers", async () => {
      await env.sendUtterance({
        seq: 0,
        speaker: 0,
        start: 0,
        end: 2,
        caption: { original: "Messi con la pelota", translated: "Messi with the ball" },
      });
      await env.sendUtterance({
        seq: 1,
        speaker: 1,
        start: 2,
        end: 4,
        caption: { original: "Buen control", translated: "Good control" },
      });
      await env.sendUtterance({
        seq: 2,
        speaker: 0,
        start: 4,
        end: 6,
        caption: { original: "Dispara!", translated: "He shoots!" },
      });

      const caps = env.captionMessages();
      expect(caps[0].caption.speaker).toBe("Speaker 0");
      expect(caps[1].caption.speaker).toBe("Speaker 1");
      expect(caps[2].caption.speaker).toBe("Speaker 0");
    });
  });

  // =================================================================
  // Dedup resilience (backend quirks on YouTube streams)
  // =================================================================

  describe("dedup with YouTube-style backend quirks", () => {
    test("retransmitted utterance (same seq, same timestamps) → play once", async () => {
      const env = createAudioEnv({ decodedDuration: 2.0 });
      await env.boot();
      await env.sendFrames(5);

      await env.sendUtterance({ seq: 1, start: 0, end: 2 });
      await env.sendUtterance({ seq: 1, start: 0, end: 2 }); // retransmit
      await env.sendUtterance({ seq: 2, start: 2, end: 4 }); // new

      expect(env.playedSources().length).toBe(2);
    });

    test("overlapping rephrase from Deepgram → dropped", async () => {
      const env = createAudioEnv({ decodedDuration: 2.0 });
      await env.boot();
      await env.sendFrames(5);

      await env.sendUtterance({ seq: 1, start: 0, end: 5 });
      await env.sendUtterance({ seq: 2, start: 3, end: 6 }); // overlaps
      await env.sendUtterance({ seq: 3, start: 5, end: 7 }); // new

      expect(env.playedSources().length).toBe(2); // 1 and 3, not 2
    });
  });

  // =================================================================
  // BUG: Buffer underrun with low threshold
  // =================================================================

  describe("buffer threshold adequacy", () => {
    test("BUG: with 3s buffer and realistic arrival rate, audio should not have gaps", async () => {
      const env = createAudioEnv({ decodedDuration: 1.0 });
      await env.boot();
      await env.sendFrames(10);

      // Fill buffer: 3 utterances = 3s → playback starts
      for (let i = 0; i < 3; i++) {
        await env.sendUtterance({ seq: i, start: i * 2, end: i * 2 + 1.5 });
      }
      expect(env.getState().isPlaying).toBe(true);
      const initialSources = env.playedSources().length;
      expect(initialSources).toBe(3);

      // Advance playback clock past all scheduled audio.
      // This simulates 5 seconds of real time passing — the 3s of buffered
      // audio has finished playing.
      env.getPlaybackCtx()._advanceTime(5);

      // Now a 4th utterance arrives (realistic: pipeline latency is 2-3s).
      await env.sendUtterance({ seq: 3, start: 6, end: 7.5 });

      const times = env.playedStartTimes();
      const thirdEnd = times[2] + 1.0; // when 3rd utterance finishes
      const fourthStart = times[3]; // when 4th is scheduled

      // The 4th utterance should play immediately after the 3rd with only
      // the natural speech gap (0.5s between original end 5.5 and start 6).
      // If there's a buffer underrun, the 4th starts much later (at currentTime+0.05).
      const schedulingGap = fourthStart - thirdEnd;
      expect(schedulingGap).toBeLessThan(1.5); // allows natural gap, but not underrun gap
    });
  });

  // =================================================================
  // Fallback timer
  // =================================================================

  describe("fallback timer", () => {
    test("single utterance below threshold plays after 15s fallback", async () => {
      const env = createAudioEnv({ decodedDuration: 0.5 });
      await env.boot();
      await env.sendFrames(3);

      await env.sendUtterance({ seq: 0, start: 0, end: 0.5 });
      expect(env.getState().isPlaying).toBe(false);

      env.fireTimeout(15000);
      expect(env.getState().isPlaying).toBe(true);
      expect(env.playedSources().length).toBe(1);
    });
  });
});
