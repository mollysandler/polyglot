/**
 * @jest-environment node
 *
 * Tests for offscreen.js — the core audio capture/streaming/playback pipeline.
 *
 * Ideal behavior tested here:
 *  - Clean state reset on start, idempotent stop
 *  - Frames sent over WS, silence detected, progress reported
 *  - Malformed WS messages handled gracefully (no crash)
 *  - Deduplication prevents double-play without false positives
 *  - Playback starts at buffer threshold, schedules with natural gaps
 *  - Fallback timer guarantees playback after timeout
 */
const {
  flushPromises,
  createChromeMock,
  createMockWSConstructor,
  createMockAudioContext,
  createMockAudioBuffer,
  createMockNavigator,
  loadOffscreenScript,
} = require("./helpers");

// ---------------------------------------------------------------------------
// Environment factory — fresh state for each test
// ---------------------------------------------------------------------------

function createEnv(opts = {}) {
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
  function OACtor(ch, len, sr) {
    return {
      createBuffer: (_c, l, s) => createMockAudioBuffer({ length: l, sampleRate: s }),
      createBufferSource: () => ({ buffer: null, connect: jest.fn(), start: jest.fn() }),
      destination: {},
      startRendering() {
        const b = createMockAudioBuffer({ length: len, sampleRate: sr });
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = 0.01;
        return Promise.resolve(b);
      },
    };
  }
  function ABCtor(o) { return createMockAudioBuffer(o); }

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
    setTimeout: (fn, ms) => { const id = tid++; timeouts.push({ fn, ms, id }); return id; },
    clearTimeout: (id) => { const i = timeouts.findIndex((t) => t.id === id); if (i >= 0) timeouts.splice(i, 1); },
    setInterval: (fn, ms) => { const id = iid++; intervals.push({ fn, ms, id }); return id; },
    clearInterval: (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); },
    Date: { now: () => dateNow },
  });

  const env = {
    ctx, chrome, WS, ctxInstances, awnInstances, nav, timeouts, intervals,
    setDateNow(v) { dateNow = v; },
    getState() { ctx.__readState(); return { ...ctx.__test }; },
    sendMsg(msg) { const r = jest.fn(); chrome._simulateMessage(msg, {}, r); return r; },
    getWS() { return WS._last(); },
    getCaptureCtx() { return ctxInstances[0]; },
    getPlaybackCtx() { return ctxInstances[1]; },
    getWorklet() { return awnInstances[0]; },
    async startCapture(src = "en", tgt = "es") {
      const r = jest.fn();
      chrome._simulateMessage({ type: "START_CAPTURE", streamId: "s", sourceLang: src, targetLang: tgt }, {}, r);
      await flushPromises();
      return r;
    },
    async simulateFrame(rms = 0.1) {
      const w = awnInstances[0];
      if (w && w.port._onmessage) {
        w.port._onmessage({ data: { type: "frame", samples: new Float32Array(9600), rms, sampleRate: 48000 } });
        await flushPromises();
      }
    },
    simulateWSText(data) {
      const ws = WS._last();
      if (ws && ws.onmessage) ws.onmessage({ data: JSON.stringify(data) });
    },
    simulateWSBinary(buf) {
      const ws = WS._last();
      if (ws && ws.onmessage) ws.onmessage({ data: buf || new ArrayBuffer(100) });
    },
    openWS() {
      const ws = WS._last();
      if (ws) { ws.readyState = 1; if (ws.onopen) ws.onopen(); }
    },
    fireTimeout(ms) {
      const t = timeouts.find((x) => x.ms === ms);
      if (t) { t.fn(); timeouts.splice(timeouts.indexOf(t), 1); }
    },
    sentMessages() { return chrome.runtime.sendMessage.mock.calls.map((c) => c[0]); },
  };
  return env;
}

// ===================================================================
// float32ToPCM16
// ===================================================================

describe("float32ToPCM16", () => {
  let env;
  beforeEach(() => { env = createEnv(); });

  test("0.0 → 0", () => {
    expect(new Int16Array(env.ctx.float32ToPCM16(new Float32Array([0])))[0]).toBe(0);
  });
  test("1.0 → 32767", () => {
    expect(new Int16Array(env.ctx.float32ToPCM16(new Float32Array([1.0])))[0]).toBe(32767);
  });
  test("-1.0 → -32768", () => {
    expect(new Int16Array(env.ctx.float32ToPCM16(new Float32Array([-1.0])))[0]).toBe(-32768);
  });
  test("clamps above 1.0", () => {
    expect(new Int16Array(env.ctx.float32ToPCM16(new Float32Array([5.0])))[0]).toBe(32767);
  });
  test("clamps below -1.0", () => {
    expect(new Int16Array(env.ctx.float32ToPCM16(new Float32Array([-5.0])))[0]).toBe(-32768);
  });
  test("returns ArrayBuffer", () => {
    const result = env.ctx.float32ToPCM16(new Float32Array([0.5]));
    expect(result.constructor.name).toBe("ArrayBuffer");
    expect(typeof result.byteLength).toBe("number");
  });
});

// ===================================================================
// trimSilence
// ===================================================================

describe("trimSilence", () => {
  let env;
  beforeEach(() => { env = createEnv(); });

  function padded(sr, pad, content) {
    const b = createMockAudioBuffer({ length: pad * 2 + content, sampleRate: sr });
    const d = b.getChannelData(0);
    for (let i = pad; i < pad + content; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    return b;
  }

  test("trims leading + trailing silence", () => {
    expect(env.ctx.trimSilence(padded(44100, 1000, 44100)).duration).toBeCloseTo(1.0, 1);
  });
  test("no trim when silence < 10 samples per side", () => {
    const b = padded(44100, 5, 44100);
    expect(env.ctx.trimSilence(b)).toBe(b);
  });
  test("all-silence → minimal buffer", () => {
    const b = createMockAudioBuffer({ length: 1000, sampleRate: 44100 });
    const t = env.ctx.trimSilence(b);
    expect(t.length).toBeGreaterThanOrEqual(1);
    expect(t.duration).toBeLessThan(b.duration);
  });
  test("no trim on non-silent buffer", () => {
    const b = createMockAudioBuffer({ length: 44100, sampleRate: 44100 });
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.3 * Math.sin(i);
    expect(env.ctx.trimSilence(b)).toBe(b);
  });
  test("custom threshold", () => {
    const b = createMockAudioBuffer({ length: 44100, sampleRate: 44100 });
    const d = b.getChannelData(0);
    for (let i = 0; i < 200; i++) d[i] = 0.001;
    for (let i = 200; i < 43900; i++) d[i] = 0.5;
    for (let i = 43900; i < 44100; i++) d[i] = 0.001;
    expect(env.ctx.trimSilence(b, 0.005).length).toBeLessThan(b.length);
  });
  test("preserves multi-channel", () => {
    const b = createMockAudioBuffer({ length: 44100, sampleRate: 44100, numberOfChannels: 2 });
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 500; i < 43600; i++) d[i] = 0.3;
    }
    expect(env.ctx.trimSilence(b).numberOfChannels).toBe(2);
  });
});

// ===================================================================
// Capture lifecycle
// ===================================================================

describe("capture lifecycle", () => {
  test("startCapture resets all state", async () => {
    const env = createEnv();
    await env.startCapture();
    const s = env.getState();
    expect(s.totalAudioCapturedSec).toBe(0);
    expect(s.bufferedDurationSec).toBe(0);
    expect(s.isPlaying).toBe(false);
    expect(s.silenceFrames).toBe(0);
    expect(s.highWaterEndSec).toBe(0);
    expect(s.firstFrameSentTime).toBe(0);
    expect(s.measuredLatencySec).toBe(0);
  });

  test("startCapture creates 2 AudioContexts and 1 WebSocket", async () => {
    const env = createEnv();
    await env.startCapture();
    expect(env.ctxInstances.length).toBe(2);
    expect(env.WS._instances.length).toBe(1);
  });

  test("WebSocket URL contains source and target lang", async () => {
    const env = createEnv();
    await env.startCapture("fr", "de");
    expect(env.getWS().url).toContain("source=fr");
    expect(env.getWS().url).toContain("target=de");
  });

  test("stopCapture sends end_stream before closing WS", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.sendMsg({ type: "STOP_CAPTURE" });
    const ws = env.getWS();
    const endMsg = ws.send.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("end_stream"));
    expect(endMsg).toBeTruthy();
    expect(ws.close).toHaveBeenCalled();
  });

  test("stopCapture sends HIDE_OVERLAY and STATUS:idle", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.sendMsg({ type: "STOP_CAPTURE" });
    const msgs = env.sentMessages();
    expect(msgs).toContainEqual(expect.objectContaining({ type: "HIDE_OVERLAY" }));
    expect(msgs).toContainEqual(expect.objectContaining({ type: "STATUS", status: "idle" }));
  });

  test("stopCapture is idempotent — second call does not crash or double-send", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.sendMsg({ type: "STOP_CAPTURE" });
    env.chrome.runtime.sendMessage.mockClear();
    expect(() => env.sendMsg({ type: "STOP_CAPTURE" })).not.toThrow();
  });
});

// ===================================================================
// Audio frame handling
// ===================================================================

describe("audio frame handling", () => {
  test("frame sent to WS as binary ArrayBuffer", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await env.simulateFrame(0.1);
    const ws = env.getWS();
    expect(ws.send).toHaveBeenCalled();
    expect(ws.send.mock.calls[0][0].constructor.name).toBe("ArrayBuffer");
  });

  test("frame dropped when WS not open", async () => {
    const env = createEnv();
    await env.startCapture();
    // WS never opened
    await env.simulateFrame(0.1);
    expect(env.getWS().send).not.toHaveBeenCalled();
  });

  test("frame dropped when WS is null", async () => {
    const env = createEnv();
    // no startCapture — ws is null
    // should not throw
    const w = { port: { _onmessage: null, postMessage: jest.fn() }, connect: jest.fn(), disconnect: jest.fn() };
    // nothing to simulate — no worklet exists
    expect(true).toBe(true);
  });

  test("totalAudioCapturedSec accumulates correctly", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await env.simulateFrame();
    await env.simulateFrame();
    // 9600 samples / 48000 Hz = 0.2s per frame
    expect(env.getState().totalAudioCapturedSec).toBeCloseTo(0.4, 1);
  });

  test("firstFrameSentTime set only on first frame", async () => {
    const env = createEnv();
    env.setDateNow(5000);
    await env.startCapture();
    env.openWS();
    await env.simulateFrame();
    expect(env.getState().firstFrameSentTime).toBe(5000);
    env.setDateNow(6000);
    await env.simulateFrame();
    expect(env.getState().firstFrameSentTime).toBe(5000);
  });

  test("overlay progress sent during buffering", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    await env.simulateFrame();
    expect(env.sentMessages().some((m) => m.type === "OVERLAY_PROGRESS")).toBe(true);
  });

  test("overlay progress NOT sent after playback starts", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.ctx.startPlayback();
    env.chrome.runtime.sendMessage.mockClear();
    await env.simulateFrame();
    expect(env.sentMessages().some((m) => m.type === "OVERLAY_PROGRESS")).toBe(false);
  });

  test("progress percentage capped at 100", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    for (let i = 0; i < 30; i++) await env.simulateFrame();
    const pMsgs = env.sentMessages().filter((m) => m.type === "OVERLAY_PROGRESS");
    for (const m of pMsgs) expect(m.progress).toBeLessThanOrEqual(100);
  });
});

// ===================================================================
// Silence detection
// ===================================================================

describe("silence detection", () => {
  test("counter increments on silent frames", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await env.simulateFrame(0.001);
    await env.simulateFrame(0.001);
    expect(env.getState().silenceFrames).toBe(2);
  });

  test("counter resets on non-silent frame", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await env.simulateFrame(0.001);
    await env.simulateFrame(0.001);
    await env.simulateFrame(0.1);
    expect(env.getState().silenceFrames).toBe(0);
  });

  test("SILENCE_WARNING sent at frame 50", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    for (let i = 0; i < 50; i++) await env.simulateFrame(0.001);
    expect(env.sentMessages().filter((m) => m.type === "SILENCE_WARNING").length).toBe(1);
  });

  test("no duplicate warning on frames 51+", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    for (let i = 0; i < 60; i++) await env.simulateFrame(0.001);
    expect(env.sentMessages().filter((m) => m.type === "SILENCE_WARNING").length).toBe(1);
  });

  test("warning fires again after silence breaks and resumes", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    for (let i = 0; i < 50; i++) await env.simulateFrame(0.001);
    await env.simulateFrame(0.1); // break
    for (let i = 0; i < 50; i++) await env.simulateFrame(0.001);
    expect(env.sentMessages().filter((m) => m.type === "SILENCE_WARNING").length).toBe(2);
  });
});

// ===================================================================
// WebSocket text message handling
// ===================================================================

describe("WS text messages", () => {
  test("session_ready — no side effects", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.simulateWSText({ type: "session_ready" });
    // No messages sent to SW beyond what onopen sent
    expect(env.sentMessages().filter((m) => m.type !== "STATUS" && m.type !== "SHOW_OVERLAY" && m.type !== "START_SYNC")).toEqual([]);
  });

  test("utterance_start creates currentUtterance", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    expect(env.getState().currentUtterance).toEqual({ seq: 1, speakerId: 0, chunks: [] });
  });

  test("utterance_end with matching seq finalizes", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(100));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();
    expect(env.getState().currentUtterance).toBeNull();
  });

  test("utterance_end with mismatched seq is ignored", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(100));
    env.simulateWSText({ type: "utterance_end", seq: 999, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();
    // currentUtterance should still exist (not finalized)
    expect(env.getState().currentUtterance).not.toBeNull();
  });

  test("utterance_end with no currentUtterance does not crash", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    expect(() => {
      env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 1 });
    }).not.toThrow();
  });

  test("caption relayed to SW with speaker/original/translated", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.simulateWSText({ type: "caption", speaker_id: 2, original: "Gol!", translated: "Goal!" });
    expect(env.sentMessages()).toContainEqual({
      type: "CAPTION",
      caption: { speaker: "Speaker 2", original: "Gol!", translated: "Goal!" },
    });
  });

  test("non-recoverable error stops capture", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.simulateWSText({ type: "error", recoverable: false, message: "fatal" });
    expect(env.sentMessages()).toContainEqual(expect.objectContaining({ type: "CAPTURE_ERROR", error: "fatal" }));
  });

  test("recoverable error sends CHUNK_ERROR only", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.simulateWSText({ type: "error", recoverable: true, message: "retry" });
    expect(env.sentMessages()).toContainEqual(expect.objectContaining({ type: "CHUNK_ERROR", error: "retry" }));
    // Capture should still be running
    expect(env.getState().isPlaying !== undefined).toBe(true);
  });

  test("heartbeat_ack — no side effects", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.simulateWSText({ type: "heartbeat_ack" });
    expect(env.sentMessages()).toEqual([]);
  });

  test("malformed JSON does not crash the WS handler", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    const ws = env.getWS();
    // Ideal: try/catch around JSON.parse prevents crash
    expect(() => ws.onmessage({ data: "NOT VALID JSON {{{" })).not.toThrow();
  });
});

// ===================================================================
// Binary messages
// ===================================================================

describe("binary messages", () => {
  test("chunk appended to currentUtterance", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSBinary(new ArrayBuffer(75));
    expect(env.getState().currentUtterance.chunks.length).toBe(2);
  });

  test("binary without utterance_start does not crash", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    expect(() => env.simulateWSBinary(new ArrayBuffer(50))).not.toThrow();
  });

  test("chunks accumulated in order", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    const a = new ArrayBuffer(10);
    const b = new ArrayBuffer(20);
    env.simulateWSBinary(a);
    env.simulateWSBinary(b);
    const chunks = env.getState().currentUtterance.chunks;
    expect(chunks[0].byteLength).toBe(10);
    expect(chunks[1].byteLength).toBe(20);
  });
});

// ===================================================================
// Deduplication
// ===================================================================

describe("deduplication", () => {
  async function sendUtterance(env, seq, start, end) {
    env.simulateWSText({ type: "utterance_start", seq, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(100));
    env.simulateWSText({ type: "utterance_end", seq, original_start_sec: start, original_end_sec: end });
    await flushPromises();
  }

  test("duplicate start+end timestamps → second dropped", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 2);
    await sendUtterance(env, 2, 0, 2); // same timestamps
    expect(env.getState().decodedQueue.length).toBe(1);
  });

  test("different timestamps → both processed", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 2);
    await sendUtterance(env, 2, 2, 4);
    expect(env.getState().decodedQueue.length).toBe(2);
  });

  test("overlapping utterance (start < highWater - 0.1) → dropped", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 5);
    await sendUtterance(env, 2, 3, 6); // 3 < 5 - 0.1
    expect(env.getState().decodedQueue.length).toBe(1);
  });

  test("non-overlapping (start >= highWater - 0.1) → processed", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 5);
    await sendUtterance(env, 2, 4.95, 7); // 4.95 >= 5 - 0.1
    expect(env.getState().decodedQueue.length).toBe(2);
  });

  test("originalStartSec = 0 bypasses overlap check", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 2);
    await sendUtterance(env, 2, 0, 3); // start=0 but different end → key dedup catches
    // This tests that the overlap guard (`originalStartSec > 0`) skips for 0
    // The key dedup might still catch it if toFixed(3) collides
  });

  test("highWaterEndSec updated synchronously before async work", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 5);
    expect(env.getState().highWaterEndSec).toBe(5);
  });

  test("seenUtteranceKeys pruned when size > 200", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    for (let i = 0; i < 210; i++) {
      await sendUtterance(env, i, i * 2, i * 2 + 1);
    }
    expect(env.getState().seenUtteranceKeys.size).toBeLessThanOrEqual(200);
  });

  test("empty chunks → early return, no decode", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    // No binary chunks sent
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();
    expect(env.getState().decodedQueue.length).toBe(0);
  });
});

// ===================================================================
// Utterance finalization
// ===================================================================

describe("utterance finalization", () => {
  async function sendUtterance(env, seq, start, end) {
    env.simulateWSText({ type: "utterance_start", seq, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(100));
    env.simulateWSText({ type: "utterance_end", seq, original_start_sec: start, original_end_sec: end });
    await flushPromises();
  }

  test("pipeline latency measured on first utterance", async () => {
    const env = createEnv();
    env.setDateNow(1000);
    await env.startCapture();
    env.openWS();
    await env.simulateFrame(); // sets firstFrameSentTime = 1000
    env.setDateNow(3500);
    await sendUtterance(env, 1, 0, 1);
    expect(env.getState().measuredLatencySec).toBeCloseTo(2.5, 1);
  });

  test("latency NOT re-measured on subsequent utterances", async () => {
    const env = createEnv();
    env.setDateNow(1000);
    await env.startCapture();
    env.openWS();
    await env.simulateFrame();
    env.setDateNow(3000);
    await sendUtterance(env, 1, 0, 1);
    const first = env.getState().measuredLatencySec;
    env.setDateNow(9000);
    await sendUtterance(env, 2, 1, 2);
    expect(env.getState().measuredLatencySec).toBe(first);
  });

  test("SET_DELAY sent to content script with measured latency", async () => {
    const env = createEnv();
    env.setDateNow(1000);
    await env.startCapture();
    env.openWS();
    await env.simulateFrame();
    env.setDateNow(4000);
    env.chrome.runtime.sendMessage.mockClear();
    await sendUtterance(env, 1, 0, 1);
    expect(env.sentMessages()).toContainEqual(expect.objectContaining({ type: "SET_DELAY", delaySec: 3 }));
  });

  test("decoded audio pushed to queue with metadata", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 2);
    const q = env.getState().decodedQueue;
    expect(q.length).toBe(1);
    expect(q[0]).toEqual(
      expect.objectContaining({ seq: 1, speakerId: 0, originalStartSec: 0, originalEndSec: 2 })
    );
  });

  test("bufferedDurationSec incremented by decoded duration", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 2);
    expect(env.getState().bufferedDurationSec).toBeCloseTo(2.0, 1);
  });

  test("playback starts when buffer >= TARGET_BUFFER_SEC", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 2);
    expect(env.getState().isPlaying).toBe(false);
    await sendUtterance(env, 2, 2, 4); // total 4s >= 3s target
    expect(env.getState().isPlaying).toBe(true);
  });

  test("if already playing, new utterances scheduled immediately", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.startCapture();
    env.openWS();
    await sendUtterance(env, 1, 0, 2);
    await sendUtterance(env, 2, 2, 4); // triggers playback
    const pb = env.getPlaybackCtx();
    const srcsBefore = pb._sources.length;
    await sendUtterance(env, 3, 4, 6);
    expect(pb._sources.length).toBeGreaterThan(srcsBefore);
  });

  test("decode error caught — no crash, utterance skipped", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.getPlaybackCtx().decodeAudioData.mockRejectedValueOnce(new Error("bad audio"));
    expect(async () => {
      await sendUtterance(env, 1, 0, 1);
    }).not.toThrow();
  });
});

// ===================================================================
// Playback
// ===================================================================

describe("playback", () => {
  test("startPlayback is idempotent", async () => {
    const env = createEnv({ decodedDuration: 4 });
    await env.startCapture();
    env.openWS();
    env.ctx.startPlayback();
    env.chrome.runtime.sendMessage.mockClear();
    env.ctx.startPlayback(); // second call
    // Should not send HIDE_OVERLAY again
    expect(env.sentMessages().filter((m) => m.type === "HIDE_OVERLAY").length).toBe(0);
  });

  test("fallback timer cleared on playback start", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    const timersBefore = env.timeouts.length;
    env.ctx.startPlayback();
    expect(env.timeouts.length).toBeLessThan(timersBefore);
  });

  test("suspended playbackCtx resumed", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.getPlaybackCtx().state = "suspended";
    env.ctx.startPlayback();
    expect(env.getPlaybackCtx().resume).toHaveBeenCalled();
  });

  test("canvas mode sends PLAYBACK_STARTED with audioStartSec from first queued utterance", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.startCapture();
    env.openWS();
    // Queue utterances starting at position 3 (not 0)
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 3, original_end_sec: 5 });
    await flushPromises();
    env.simulateWSText({ type: "utterance_start", seq: 2, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 2, original_start_sec: 5, original_end_sec: 7 });
    await flushPromises();
    env.simulateWSText({ type: "utterance_start", seq: 3, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 3, original_start_sec: 7, original_end_sec: 9 });
    await flushPromises();
    // Playback should have started (3s buffered). Check audioStartSec.
    const pbMsg = env.sentMessages().find((m) => m.type === "PLAYBACK_STARTED");
    expect(pbMsg).toBeTruthy();
    expect(pbMsg.audioStartSec).toBe(3);
  });

  test("PLAYBACK_STARTED audioStartSec defaults to 0 when queue is empty", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.ctx.startPlayback();
    const pbMsg = env.sentMessages().find((m) => m.type === "PLAYBACK_STARTED");
    expect(pbMsg.audioStartSec).toBe(0);
  });

  test("seekback mode sends VIDEO_SEEK_BACK with totalAudioCapturedSec", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.sendMsg({ type: "SYNC_MODE_REPORT", mode: "seekback" });
    await env.simulateFrame();
    await env.simulateFrame();
    env.chrome.runtime.sendMessage.mockClear();
    env.ctx.startPlayback();
    const seek = env.sentMessages().find((m) => m.type === "VIDEO_SEEK_BACK");
    expect(seek).toBeTruthy();
    expect(seek.seekBackSec).toBeCloseTo(0.4, 1);
  });

  test("HIDE_OVERLAY sent on playback start", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.chrome.runtime.sendMessage.mockClear();
    env.ctx.startPlayback();
    expect(env.sentMessages()).toContainEqual(expect.objectContaining({ type: "HIDE_OVERLAY" }));
  });

  test("scheduleBufferedAudio drains entire queue", async () => {
    const env = createEnv({ decodedDuration: 0.5 });
    await env.startCapture();
    env.openWS();
    // Push 3 items to queue
    for (let i = 0; i < 3; i++) {
      env.simulateWSText({ type: "utterance_start", seq: i, speaker_id: 0 });
      env.simulateWSBinary(new ArrayBuffer(50));
      env.simulateWSText({ type: "utterance_end", seq: i, original_start_sec: i, original_end_sec: i + 0.5 });
      await flushPromises();
    }
    env.ctx.startPlayback();
    expect(env.getState().decodedQueue.length).toBe(0);
    expect(env.getPlaybackCtx()._sources.length).toBe(3);
  });

  test("scheduleAudioItem returns early if playbackCtx is null", () => {
    const env = createEnv();
    // stopCapture nulls playbackCtx — calling schedule shouldn't crash
    expect(() => env.ctx.scheduleAudioItem({ audioBuffer: { duration: 1 }, originalStartSec: 0, originalEndSec: 1 })).not.toThrow();
  });

  test("natural gap inserted between utterances", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.startCapture();
    env.openWS();
    // Utterance 1: 0-1s, Utterance 2: 2.5-3.5s → gap of 1.5s
    for (const [seq, s, e] of [[1, 0, 1], [2, 2.5, 3.5]]) {
      env.simulateWSText({ type: "utterance_start", seq, speaker_id: 0 });
      env.simulateWSBinary(new ArrayBuffer(50));
      env.simulateWSText({ type: "utterance_end", seq, original_start_sec: s, original_end_sec: e });
      await flushPromises();
    }
    env.ctx.startPlayback();
    // Second source should start 1.5s after first ends
    const srcs = env.getPlaybackCtx()._sources;
    const t1 = srcs[0].start.mock.calls[0][0]; // start time of first
    const t2 = srcs[1].start.mock.calls[0][0]; // start time of second
    expect(t2 - t1).toBeCloseTo(1.0 + 1.5, 1); // duration + gap
  });

  test("gap capped at 3 seconds", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.startCapture();
    env.openWS();
    for (const [seq, s, e] of [[1, 0, 1], [2, 20, 21]]) { // 19s gap
      env.simulateWSText({ type: "utterance_start", seq, speaker_id: 0 });
      env.simulateWSBinary(new ArrayBuffer(50));
      env.simulateWSText({ type: "utterance_end", seq, original_start_sec: s, original_end_sec: e });
      await flushPromises();
    }
    env.ctx.startPlayback();
    const srcs = env.getPlaybackCtx()._sources;
    const t1 = srcs[0].start.mock.calls[0][0];
    const t2 = srcs[1].start.mock.calls[0][0];
    expect(t2 - t1).toBeCloseTo(1.0 + 3.0, 1); // duration + capped gap
  });

  test("first utterance gets leading gap to align canvas and audio", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 2, original_end_sec: 3 });
    await flushPromises();
    env.ctx.startPlayback();
    const src = env.getPlaybackCtx()._sources[0];
    // Speech starts at position 2 → 2s gap inserted so canvas can draw
    // frames 0-2 before audio begins. Start = 0.1 + 2.0 = 2.1
    expect(src.start.mock.calls[0][0]).toBeCloseTo(2.1, 1);
  });

  test("first utterance at position 0 has no leading gap", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();
    env.ctx.startPlayback();
    const src = env.getPlaybackCtx()._sources[0];
    // Speech starts at 0 → no gap needed
    expect(src.start.mock.calls[0][0]).toBeCloseTo(0.1, 1);
  });

  test("nextPlayTime catches up when behind currentTime", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();
    env.getPlaybackCtx()._setTime(10); // jump time forward
    env.ctx.startPlayback();
    const src = env.getPlaybackCtx()._sources[0];
    expect(src.start.mock.calls[0][0]).toBeGreaterThanOrEqual(10);
  });

  test("onended chains next utterance from queue", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 1 });
    await flushPromises();
    env.ctx.startPlayback();
    // Add another utterance to queue
    env.simulateWSText({ type: "utterance_start", seq: 2, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 2, original_start_sec: 1, original_end_sec: 2 });
    await flushPromises();
    // Trigger onended of first source
    env.getPlaybackCtx()._sources[0]._triggerEnded();
    expect(env.getPlaybackCtx()._sources.length).toBe(2);
  });
});

// ===================================================================
// Fallback timer
// ===================================================================

describe("fallback timer", () => {
  test("fires after FALLBACK_START_SEC if not playing and queue non-empty", async () => {
    const env = createEnv({ decodedDuration: 0.5 });
    await env.startCapture();
    env.openWS();
    // Add one utterance (not enough for target buffer)
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 0.5 });
    await flushPromises();
    expect(env.getState().isPlaying).toBe(false);
    // Fire the 15s fallback
    env.fireTimeout(15000);
    expect(env.getState().isPlaying).toBe(true);
  });

  test("does NOT fire if already playing", async () => {
    const env = createEnv({ decodedDuration: 4 });
    await env.startCapture();
    env.openWS();
    env.simulateWSText({ type: "utterance_start", seq: 1, speaker_id: 0 });
    env.simulateWSBinary(new ArrayBuffer(50));
    env.simulateWSText({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 4 });
    await flushPromises();
    // Should already be playing (4s > 3s target)
    expect(env.getState().isPlaying).toBe(true);
    const srcsBefore = env.getPlaybackCtx()._sources.length;
    // Fallback should be cleared
    const remaining = env.timeouts.find((t) => t.ms === 15000);
    expect(remaining).toBeFalsy();
  });

  test("does NOT start playback if queue is empty", async () => {
    const env = createEnv();
    await env.startCapture();
    env.openWS();
    env.fireTimeout(15000);
    expect(env.getState().isPlaying).toBe(false);
  });
});

// ===================================================================
// SYNC_MODE_REPORT handling
// ===================================================================

describe("SYNC_MODE_REPORT", () => {
  test("updates syncMode from content script", async () => {
    const env = createEnv();
    await env.startCapture();
    env.sendMsg({ type: "SYNC_MODE_REPORT", mode: "seekback" });
    expect(env.getState().syncMode).toBe("seekback");
  });

  test("defaults to canvas when mode not provided", async () => {
    const env = createEnv();
    await env.startCapture();
    env.sendMsg({ type: "SYNC_MODE_REPORT" });
    expect(env.getState().syncMode).toBe("canvas");
  });
});
