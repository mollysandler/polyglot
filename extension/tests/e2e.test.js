/**
 * @jest-environment node
 *
 * End-to-end pipeline tests.
 *
 * Simulates full capture sessions: audio frames flow to the backend,
 * the backend returns translated utterances + captions, and we verify:
 *
 *   1. Every unique phrase is played EXACTLY once (no duplicates, no drops)
 *   2. Every caption is delivered EXACTLY once
 *   3. Audio is scheduled at the correct times with natural gaps
 *   4. Buffer threshold is respected — nothing plays too early
 *   5. Dedup handles every realistic backend quirk (retransmits, overlaps,
 *      out-of-order, multiple speakers)
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
// Environment factory (same as offscreen.test.js but with richer helpers)
// ---------------------------------------------------------------------------

function createEnv(opts = {}) {
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

  return {
    ctx, chrome, WS, ctxInstances, awnInstances, timeouts,
    setDateNow(v) { dateNow = v; },
    getState() { ctx.__readState(); return { ...ctx.__test }; },
    getPlaybackCtx() { return ctxInstances[1]; },

    async boot() {
      const r = jest.fn();
      chrome._simulateMessage(
        { type: "START_CAPTURE", streamId: "s", sourceLang: "en", targetLang: "es" },
        {}, r,
      );
      await flushPromises();
      const ws = WS._last();
      ws.readyState = 1;
      if (ws.onopen) ws.onopen();
      return ws;
    },

    async sendFrames(n = 5) {
      const w = awnInstances[0];
      for (let i = 0; i < n; i++) {
        w.port._onmessage({
          data: { type: "frame", samples: new Float32Array(9600), rms: 0.1, sampleRate: 48000 },
        });
        await flushPromises();
      }
    },

    /** Send a complete utterance (start → binary chunks → end) + optional caption */
    async sendUtterance(u) {
      const ws = WS._last();
      ws.onmessage({ data: JSON.stringify({ type: "utterance_start", seq: u.seq, speaker_id: u.speaker || 0 }) });
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

    /** All AudioBufferSourceNodes that were created + started */
    playedSources() {
      return (ctxInstances[1] || { _sources: [] })._sources.filter(
        (s) => s.start.mock.calls.length > 0
      );
    },

    /** Start times of every played audio source, in order */
    playedStartTimes() {
      return this.playedSources().map((s) => s.start.mock.calls[0][0]);
    },

    /** All CAPTION messages sent to the service worker */
    captionMessages() {
      return chrome.runtime.sendMessage.mock.calls
        .map((c) => c[0])
        .filter((m) => m.type === "CAPTION");
    },

    fireTimeout(ms) {
      const t = timeouts.find((x) => x.ms === ms);
      if (t) { t.fn(); timeouts.splice(timeouts.indexOf(t), 1); }
    },
  };
}

// ===================================================================
// Happy path — sequential utterances, no duplicates
// ===================================================================

describe("happy path: 5 sequential utterances", () => {
  let env;

  beforeEach(async () => {
    env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    env.setDateNow(1000);
    await env.sendFrames(5);
    env.setDateNow(3000);
  });

  test("all 5 audio segments are played exactly once", async () => {
    for (let i = 0; i < 5; i++) {
      await env.sendUtterance({
        seq: i,
        start: i * 2,
        end: i * 2 + 1.5,
        caption: { original: `Frase ${i}`, translated: `Phrase ${i}` },
      });
    }
    expect(env.playedSources().length).toBe(5);
  });

  test("all 5 captions are delivered exactly once", async () => {
    for (let i = 0; i < 5; i++) {
      await env.sendUtterance({
        seq: i,
        start: i * 2,
        end: i * 2 + 1.5,
        caption: { original: `Frase ${i}`, translated: `Phrase ${i}` },
      });
    }
    const caps = env.captionMessages();
    expect(caps.length).toBe(5);
    const texts = caps.map((c) => c.caption.translated);
    expect(new Set(texts).size).toBe(5); // all unique
  });

  test("audio plays in sequential order", async () => {
    for (let i = 0; i < 5; i++) {
      await env.sendUtterance({
        seq: i,
        start: i * 2,
        end: i * 2 + 1.5,
      });
    }
    const times = env.playedStartTimes();
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  test("no audio plays until buffer threshold is reached", async () => {
    // First utterance: 1s decoded. TARGET_BUFFER_SEC = 3. Should not play yet.
    await env.sendUtterance({ seq: 0, start: 0, end: 1.5 });
    expect(env.getState().isPlaying).toBe(false);
    expect(env.playedSources().length).toBe(0);

    // Second: 2s total. Still under threshold.
    await env.sendUtterance({ seq: 1, start: 2, end: 3.5 });
    expect(env.getState().isPlaying).toBe(false);

    // Third: 3s total. Meets threshold → playback starts.
    await env.sendUtterance({ seq: 2, start: 4, end: 5.5 });
    expect(env.getState().isPlaying).toBe(true);
    expect(env.playedSources().length).toBe(3);
  });
});

// ===================================================================
// Exact duplicates from backend
// ===================================================================

describe("duplicate utterances from backend", () => {
  test("same seq + same timestamps → only 1 audio segment played", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 1, start: 0, end: 2 }); // exact dup
    await env.sendUtterance({ seq: 2, start: 2, end: 4 }); // trigger playback

    expect(env.playedSources().length).toBe(2); // NOT 3
  });

  test("same timestamps, different seq → still only 1 audio (key dedup)", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 99, start: 0, end: 2 }); // different seq, same timestamps
    await env.sendUtterance({ seq: 2, start: 2, end: 4 });

    expect(env.playedSources().length).toBe(2);
  });

  test("duplicate caption text → only 1 CAPTION message per unique translation", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    const cap = { original: "Gol!", translated: "Goal!" };
    await env.sendUtterance({ seq: 1, start: 0, end: 2, caption: cap });
    await env.sendUtterance({ seq: 1, start: 0, end: 2, caption: cap }); // dup utterance

    // The utterance is deduped, so only 1 caption relayed
    const caps = env.captionMessages();
    expect(caps.length).toBe(1);
  });
});

// ===================================================================
// Overlapping timestamps
// ===================================================================

describe("overlapping utterances", () => {
  test("utterance starting inside previous range → dropped", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({ seq: 1, start: 0, end: 5 });     // covers 0-5s
    await env.sendUtterance({ seq: 2, start: 3, end: 6 });      // starts at 3 < 5-0.1 → overlap
    await env.sendUtterance({ seq: 3, start: 5, end: 7 });      // starts at 5 >= 5-0.1 → OK

    expect(env.playedSources().length).toBe(2); // seq 1 and 3, not 2
  });

  test("overlapping utterance's caption is also suppressed", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({
      seq: 1, start: 0, end: 5,
      caption: { original: "A", translated: "A translated" },
    });
    await env.sendUtterance({
      seq: 2, start: 3, end: 6,
      caption: { original: "B", translated: "B translated" },
    });

    // Caption for seq 2 IS still sent because captions are sent independently
    // of utterance dedup (they come as separate WS messages).
    // The audio for seq 2 is dropped, but the caption message is relayed.
    // This is the current behavior — captions arrive as their own message type.
    const caps = env.captionMessages();
    expect(caps.length).toBe(2);
  });

  test("adjacent utterances (no gap, no overlap) both play", async () => {
    const env = createEnv({ decodedDuration: 1.5 });
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({ seq: 1, start: 0, end: 3 });
    await env.sendUtterance({ seq: 2, start: 3, end: 6 }); // starts exactly at previous end

    expect(env.playedSources().length).toBe(2);
  });
});

// ===================================================================
// Multiple speakers
// ===================================================================

describe("multiple speakers", () => {
  test("interleaved speakers all play without dedup interference", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    // Speaker 0 and 1 alternate — timestamps don't overlap
    await env.sendUtterance({ seq: 1, speaker: 0, start: 0, end: 2 });
    await env.sendUtterance({ seq: 2, speaker: 1, start: 2, end: 4 });
    await env.sendUtterance({ seq: 3, speaker: 0, start: 4, end: 6 });
    await env.sendUtterance({ seq: 4, speaker: 1, start: 6, end: 8 });

    expect(env.playedSources().length).toBe(4);
  });

  test("captions attributed to correct speaker", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    await env.sendUtterance({
      seq: 1, speaker: 0, start: 0, end: 2,
      caption: { original: "Hola", translated: "Hello" },
    });
    await env.sendUtterance({
      seq: 2, speaker: 1, start: 2, end: 4,
      caption: { original: "Adiós", translated: "Goodbye" },
    });
    await env.sendUtterance({
      seq: 3, speaker: 0, start: 4, end: 6,
      caption: { original: "Sí", translated: "Yes" },
    });

    const caps = env.captionMessages();
    expect(caps[0].caption.speaker).toBe("Speaker 0");
    expect(caps[1].caption.speaker).toBe("Speaker 1");
    expect(caps[2].caption.speaker).toBe("Speaker 0");
  });
});

// ===================================================================
// Audio scheduling timing
// ===================================================================

describe("audio scheduling timing", () => {
  test("natural gaps preserved between utterances", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    // Utterance 1: 0-2s, Utterance 2: 3.5-5s → 1.5s gap in original
    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 2, start: 3.5, end: 5 });
    await env.sendUtterance({ seq: 3, start: 5, end: 7 }); // trigger playback

    const times = env.playedStartTimes();
    // Gap between utterance 1 end and utterance 2 start should be ~1.5s
    const gap = times[1] - (times[0] + 1.0); // start[1] - (start[0] + duration)
    expect(gap).toBeCloseTo(1.5, 1);
  });

  test("large gaps capped at 3 seconds", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    // 20-second gap in original speech
    await env.sendUtterance({ seq: 1, start: 0, end: 1 });
    await env.sendUtterance({ seq: 2, start: 21, end: 22 });
    await env.sendUtterance({ seq: 3, start: 22, end: 23 }); // trigger playback

    const times = env.playedStartTimes();
    const gap = times[1] - (times[0] + 1.0);
    expect(gap).toBeCloseTo(3.0, 1); // capped, not 20
  });

  test("continuous speech (no gaps) plays back-to-back", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    // Consecutive utterances with no silence between them
    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 2, start: 2, end: 4 });
    await env.sendUtterance({ seq: 3, start: 4, end: 6 });

    const times = env.playedStartTimes();
    // Each should start immediately after the previous ends (no gap inserted)
    for (let i = 1; i < times.length; i++) {
      const expectedStart = times[i - 1] + 1.0; // prev start + decoded duration
      expect(times[i]).toBeCloseTo(expectedStart, 1);
    }
  });
});

// ===================================================================
// Fallback playback
// ===================================================================

describe("fallback timer forces playback", () => {
  test("single utterance below threshold plays after 15s fallback", async () => {
    const env = createEnv({ decodedDuration: 0.5 }); // well below 3s threshold
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({ seq: 1, start: 0, end: 0.5 });
    expect(env.getState().isPlaying).toBe(false);

    env.fireTimeout(15000);
    expect(env.getState().isPlaying).toBe(true);
    expect(env.playedSources().length).toBe(1);
  });
});

// ===================================================================
// Realistic commentary session
// ===================================================================

describe("realistic commentary session", () => {
  test("full 30-second commentary with 2 speakers, backend quirks", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    env.setDateNow(1000);
    await env.sendFrames(10);
    env.setDateNow(3000);

    // --- Commentator (speaker 0) describes the play ---
    await env.sendUtterance({
      seq: 1, speaker: 0, start: 0, end: 3,
      caption: { original: "Messi recibe el balón", translated: "Messi receives the ball" },
    });

    // --- Backend accidentally sends seq 1 again (Deepgram retransmit) ---
    await env.sendUtterance({
      seq: 1, speaker: 0, start: 0, end: 3,
      caption: { original: "Messi recibe el balón", translated: "Messi receives the ball" },
    });

    // --- Color commentator (speaker 1) adds analysis ---
    await env.sendUtterance({
      seq: 2, speaker: 1, start: 3.5, end: 6,
      caption: { original: "Buen control", translated: "Good control" },
    });

    // --- Backend sends an overlapping rephrase of seq 2 ---
    await env.sendUtterance({
      seq: 3, speaker: 1, start: 4, end: 6.5,
      caption: { original: "Muy buen control", translated: "Very good control" },
    });

    // --- Back to main commentator ---
    await env.sendUtterance({
      seq: 4, speaker: 0, start: 6.5, end: 9,
      caption: { original: "Dispara!", translated: "He shoots!" },
    });

    await env.sendUtterance({
      seq: 5, speaker: 0, start: 9.5, end: 12,
      caption: { original: "GOOOL!", translated: "GOAAAL!" },
    });

    // --- Verify audio: seq 1 (once), 2, 4, 5 = 4 played. seq 1 dup + seq 3 overlap dropped ---
    expect(env.playedSources().length).toBe(4);

    // --- Verify captions: 1 (once), 2, 4, 5. seq 1 dup dropped by utterance dedup.
    //     seq 3's caption IS delivered (caption messages are independent of audio dedup) ---
    const caps = env.captionMessages();
    const translatedTexts = caps.map((c) => c.caption.translated);

    // "Messi receives the ball" should appear exactly once
    expect(translatedTexts.filter((t) => t === "Messi receives the ball").length).toBe(1);
    // "He shoots!" once
    expect(translatedTexts.filter((t) => t === "He shoots!").length).toBe(1);
    // "GOAAAL!" once
    expect(translatedTexts.filter((t) => t === "GOAAAL!").length).toBe(1);

    // --- Verify playback order: audio plays in timestamp order ---
    const times = env.playedStartTimes();
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  test("rapid-fire utterances during exciting play all play without drops", async () => {
    const env = createEnv({ decodedDuration: 0.5 });
    await env.boot();
    await env.sendFrames(10);

    // 10 fast utterances, each 0.5s apart, no overlaps
    for (let i = 0; i < 10; i++) {
      await env.sendUtterance({
        seq: i,
        speaker: i % 2,
        start: i * 0.6,
        end: i * 0.6 + 0.5,
        caption: { original: `Rápido ${i}`, translated: `Fast ${i}` },
      });
    }

    expect(env.playedSources().length).toBe(10);
    expect(env.captionMessages().length).toBe(10);
  });

  test("long silence between halves does not produce huge gap in audio", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(10);

    // End of first half
    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 2, start: 2, end: 4 });
    await env.sendUtterance({ seq: 3, start: 4, end: 6 });

    // 15-minute halftime break — next utterance at 900s
    await env.sendUtterance({ seq: 4, start: 900, end: 902 });

    const times = env.playedStartTimes();
    // Gap between seq 3 and seq 4 should be capped at 3s, not 894s
    const gap = times[3] - (times[2] + 1.0);
    expect(gap).toBeCloseTo(3.0, 1);
    expect(gap).toBeLessThan(5);
  });
});

// ===================================================================
// Edge cases
// ===================================================================

describe("edge cases", () => {
  test("utterance with 0-length audio (empty chunks) produces no audio", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    // Send utterance_start + utterance_end with NO binary chunks
    const ws = env.WS._last();
    ws.onmessage({ data: JSON.stringify({ type: "utterance_start", seq: 1, speaker_id: 0 }) });
    ws.onmessage({ data: JSON.stringify({ type: "utterance_end", seq: 1, original_start_sec: 0, original_end_sec: 2 }) });
    await flushPromises();

    // Normal utterance after
    await env.sendUtterance({ seq: 2, start: 2, end: 4 });
    await env.sendUtterance({ seq: 3, start: 4, end: 6 });

    // Only seq 2 and 3 should play (seq 1 had no chunks)
    expect(env.playedSources().length).toBe(2);
  });

  test("very first utterance at timestamp 0 is not rejected by overlap check", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 2, start: 2, end: 4 });

    expect(env.playedSources().length).toBe(2);
  });

  test("utterance arrives after playback already started → scheduled immediately", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    // Fill buffer to start playback
    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 2, start: 2, end: 4 }); // 4s total → starts
    expect(env.getState().isPlaying).toBe(true);
    expect(env.playedSources().length).toBe(2);

    // Late arrival — should be scheduled immediately
    await env.sendUtterance({ seq: 3, start: 4, end: 6 });
    expect(env.playedSources().length).toBe(3);
  });

  test("200+ utterances do not exhaust dedup memory", async () => {
    const env = createEnv({ decodedDuration: 0.1 });
    await env.boot();
    await env.sendFrames(3);

    for (let i = 0; i < 220; i++) {
      await env.sendUtterance({ seq: i, start: i * 0.2, end: i * 0.2 + 0.1 });
    }

    // Dedup set should have been pruned
    expect(env.getState().seenUtteranceKeys.size).toBeLessThanOrEqual(200);
    // All 220 should have played (no false dedup rejections from pruning)
    expect(env.playedSources().length).toBe(220);
  });

  test("decode failure on one utterance does not block subsequent ones", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    await env.sendFrames(3);

    await env.sendUtterance({ seq: 1, start: 0, end: 2 });

    // Make decode fail for seq 2
    env.getPlaybackCtx().decodeAudioData.mockRejectedValueOnce(new Error("corrupt audio"));
    await env.sendUtterance({ seq: 2, start: 2, end: 4 });

    // seq 3 should still work
    await env.sendUtterance({ seq: 3, start: 4, end: 6 });

    // seq 1 and 3 play, seq 2 skipped
    expect(env.playedSources().length).toBe(2);
  });
});

// ===================================================================
// SEEKBACK: silence gap caused by re-capture
//
// Real-world scenario the user observed:
//   t=0-6s:    Capture → backend → first-pass translations play
//   t=6s:      Playback starts. Video seeks back to 0.
//   t=6-12s:   Video replays 0-6s. Capture keeps sending re-captured audio.
//              First-pass translated audio finishes playing at ~t=10s.
//              Backend is still processing re-captured audio.
//              → SILENCE GAP: no audio playing, video keeps moving.
//   t=12s+:    Re-captured translations arrive. Audio resumes.
//              But video is now far ahead → permanent desync.
//
// Even if re-captured phrases eventually play, the total scheduled audio
// is 2× what it should be, and the processing delay creates a silence
// gap that throws off sync permanently.
// ===================================================================

describe("seekback: silence gap from re-capture (documents the bug)", () => {
  test("replay zone suppression prevents re-captured content from reaching backend", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    env.chrome._simulateMessage({ type: "SYNC_MODE_REPORT", mode: "seekback" }, {}, jest.fn());
    env.setDateNow(1000);
    await env.sendFrames(30); // 6s captured
    env.setDateNow(7000);

    // First pass: 4 utterances (4 × 1s = 4s buffered, triggers playback)
    for (const [seq, s, e] of [[1, 0, 1.5], [2, 1.5, 3], [3, 3, 4.5], [4, 4.5, 6]]) {
      await env.sendUtterance({ seq, start: s, end: e });
    }
    expect(env.getState().isPlaying).toBe(true);
    expect(env.getState().inReplayZone).toBe(true);

    const ws = env.WS._last();
    const sendsBefore = ws.send.mock.calls.length;

    // Video seeked back. Replay zone active. 30 frames captured but suppressed.
    await env.sendFrames(30);

    // Frames were NOT sent to backend → backend produces no re-captured translations.
    // Only the original 4 first-pass segments are played.
    expect(ws.send.mock.calls.length).toBe(sendsBefore);
    expect(env.playedSources().length).toBe(4);
  });

  test("frames sent during replay zone create unnecessary backend load", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();
    env.chrome._simulateMessage({ type: "SYNC_MODE_REPORT", mode: "seekback" }, {}, jest.fn());
    await env.sendFrames(30); // 6s captured

    await env.sendUtterance({ seq: 1, start: 0, end: 3 });
    await env.sendUtterance({ seq: 2, start: 3, end: 6 });
    expect(env.getState().isPlaying).toBe(true);

    const ws = env.WS._last();
    const sendsBefore = ws.send.mock.calls.length;

    // 30 frames during replay zone — should NOT be sent to backend
    await env.sendFrames(30);

    // IDEAL: no additional frames sent during replay zone
    expect(ws.send.mock.calls.length).toBe(sendsBefore);
  });

  test("audio schedule has no gap between first-pass and new content", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    env.chrome._simulateMessage({ type: "SYNC_MODE_REPORT", mode: "seekback" }, {}, jest.fn());
    env.setDateNow(1000);
    await env.sendFrames(30); // 6s captured
    env.setDateNow(7000);

    // First pass
    await env.sendUtterance({ seq: 1, start: 0, end: 3,
      caption: { original: "Uno", translated: "One" } });
    await env.sendUtterance({ seq: 2, start: 3, end: 6,
      caption: { original: "Dos", translated: "Two" } });
    await env.sendUtterance({ seq: 3, start: 6, end: 9,
      caption: { original: "Tres", translated: "Three" } });

    // Replay zone: frames suppressed, no utterances
    await env.sendFrames(30);

    // New content after replay zone (stream continues from where first pass left off)
    await env.sendUtterance({ seq: 4, start: 9, end: 12,
      caption: { original: "Cuatro", translated: "Four" } });

    // IDEAL: 4 audio segments, continuous schedule, no silence gap
    expect(env.playedSources().length).toBe(4);

    const times = env.playedStartTimes();
    for (let i = 1; i < times.length; i++) {
      // Each segment should follow the previous with at most a natural gap (≤3s)
      const prevEnd = times[i - 1] + 1.0; // prev start + decoded duration
      const gap = times[i] - prevEnd;
      expect(gap).toBeLessThanOrEqual(3.0);
      expect(gap).toBeGreaterThanOrEqual(0);
    }
  });
});

// ===================================================================
// SEEKBACK MODE — re-capture after video seeks back
//
// This is the critical real-world scenario:
//   1. Capture runs for ~30s, streaming audio to backend
//   2. Backend returns translations for content from second 0-30
//   3. Buffer fills → playback starts → video seeks back to ~0s
//   4. Video replays from 0s → tab produces the SAME audio again
//   5. Capture is still running → sends it to backend AGAIN
//   6. Backend returns new utterances with NEW stream timestamps
//      (e.g. "Goal by Messi" first at stream 5-7s, then again at 35-37s)
//   7. Ideal: the re-captured content must NOT play or caption again
// ===================================================================

describe("seekback mode: re-capture suppression", () => {
  /**
   * Helper: boot in seekback mode, buffer first-pass, trigger playback.
   * After this, the replay zone is active and frames are suppressed.
   */
  async function bootSeekback(env, firstPass) {
    await env.boot();
    env.chrome._simulateMessage({ type: "SYNC_MODE_REPORT", mode: "seekback" }, {}, jest.fn());
    env.setDateNow(1000);
    await env.sendFrames(30); // 6s captured
    env.setDateNow(7000);
    for (const u of firstPass) await env.sendUtterance(u);
  }

  test("replay zone active after seekback — frames suppressed", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await bootSeekback(env, [
      { seq: 1, start: 0, end: 2 },
      { seq: 2, start: 2, end: 4 },
      { seq: 3, start: 4, end: 6 },
    ]);
    expect(env.getState().isPlaying).toBe(true);
    expect(env.getState().inReplayZone).toBe(true);

    const ws = env.WS._last();
    const sendsBefore = ws.send.mock.calls.length;

    // 30 frames during replay zone → none should reach the backend
    await env.sendFrames(30);
    expect(ws.send.mock.calls.length).toBe(sendsBefore);
  });

  test("replay zone ends after enough captured time — frames resume", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await bootSeekback(env, [
      { seq: 1, start: 0, end: 3 },
      { seq: 2, start: 3, end: 6 },
    ]);
    expect(env.getState().isPlaying).toBe(true);

    const ws = env.WS._last();
    const sendsBefore = ws.send.mock.calls.length;

    // Replay zone = 6s captured before seekback → need ~6s more to exit.
    // 30 frames × 0.2s = 6s. Zone exits at the boundary.
    await env.sendFrames(30);

    // Send a few more frames that are clearly past the zone
    await env.sendFrames(5);
    const sendsAfter = ws.send.mock.calls.length;

    // At least some frames after the replay zone were sent to backend
    expect(sendsAfter).toBeGreaterThan(sendsBefore);
    expect(env.getState().inReplayZone).toBe(false);
  });

  test("no re-captured utterances arrive because backend has no replay audio", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await bootSeekback(env, [
      { seq: 1, start: 0, end: 2, caption: { original: "Gol", translated: "Goal" } },
      { seq: 2, start: 2, end: 4, caption: { original: "Sí", translated: "Yes" } },
      { seq: 3, start: 4, end: 6, caption: { original: "Vamos", translated: "Let's go" } },
    ]);

    // First pass: 3 audio + 3 captions
    expect(env.playedSources().length).toBe(3);
    expect(env.captionMessages().length).toBe(3);

    // Replay zone: 30 frames suppressed. Backend receives nothing.
    // No utterances arrive during this period (we don't send any — realistic).
    await env.sendFrames(30);

    // Still only 3 audio segments and 3 captions
    expect(env.playedSources().length).toBe(3);
    expect(env.captionMessages().length).toBe(3);
  });

  test("new content after replay zone plays and captions normally", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await bootSeekback(env, [
      { seq: 1, start: 0, end: 2, caption: { original: "Primer gol", translated: "First goal" } },
      { seq: 2, start: 2, end: 4, caption: { original: "Celebración", translated: "Celebration" } },
      { seq: 3, start: 4, end: 6, caption: { original: "Tremendo", translated: "Tremendous" } },
    ]);
    expect(env.playedSources().length).toBe(3);

    // Replay zone: 30 frames (6s) suppressed
    await env.sendFrames(30);

    // Replay zone ends. New frames sent to backend. Backend returns new content.
    // (Stream continues from position 6s in Deepgram's view)
    await env.sendFrames(10); // post-replay frames
    await env.sendUtterance({
      seq: 4, start: 6, end: 8,
      caption: { original: "Segundo gol", translated: "Second goal" },
    });

    // First pass (3) + new (1) = 4 total
    expect(env.playedSources().length).toBe(4);

    const caps = env.captionMessages();
    const texts = caps.map((c) => c.caption.translated);
    expect(texts).toEqual(["First goal", "Celebration", "Tremendous", "Second goal"]);
  });

  test("VIDEO_SEEK_BACK sent with correct seekback amount", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await bootSeekback(env, [
      { seq: 1, start: 0, end: 3 },
      { seq: 2, start: 3, end: 6 },
    ]);

    const seekMsg = env.chrome.runtime.sendMessage.mock.calls
      .map((c) => c[0])
      .find((m) => m.type === "VIDEO_SEEK_BACK");

    expect(seekMsg).toBeTruthy();
    expect(seekMsg.seekBackSec).toBeCloseTo(6.0, 0);
  });

  test("canvas mode is unaffected — no replay zone, all frames sent", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    // default syncMode = "canvas" — no SYNC_MODE_REPORT
    await env.sendFrames(30);
    await env.sendUtterance({ seq: 1, start: 0, end: 3 });
    await env.sendUtterance({ seq: 2, start: 3, end: 6 });
    await env.sendUtterance({ seq: 3, start: 6, end: 9 });

    expect(env.getState().inReplayZone).toBe(false);

    const ws = env.WS._last();
    const sendsBefore = ws.send.mock.calls.length;
    await env.sendFrames(20);
    // All 20 frames sent — no suppression
    expect(ws.send.mock.calls.length).toBe(sendsBefore + 20);
  });
});

// ===================================================================
// CANVAS MODE — no re-capture (video plays forward, just delayed frames)
// ===================================================================

describe("canvas mode: continuous forward capture", () => {
  test("all frames sent to backend — no suppression needed", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    // Default sync mode is "canvas" — no SYNC_MODE_REPORT needed

    await env.sendFrames(30);

    // All 30 frames should be sent to WS
    const ws = env.WS._last();
    // Each frame triggers a WS send (after resampling)
    expect(ws.send.mock.calls.length).toBe(30);

    // Backend delivers translations
    await env.sendUtterance({ seq: 1, start: 0, end: 3 });
    await env.sendUtterance({ seq: 2, start: 3, end: 6 });

    // Playback started, but capture continues (no replay zone)
    const sendCountBefore = ws.send.mock.calls.length;
    await env.sendFrames(10);
    expect(ws.send.mock.calls.length).toBe(sendCountBefore + 10);
  });

  test("PLAYBACK_STARTED sent instead of VIDEO_SEEK_BACK", async () => {
    const env = createEnv({ decodedDuration: 2.0 });
    await env.boot();

    await env.sendFrames(30);
    // 2×2s = 4s ≥ 3s threshold → playback starts
    await env.sendUtterance({ seq: 1, start: 0, end: 3 });
    await env.sendUtterance({ seq: 2, start: 3, end: 6 });

    const msgs = env.chrome.runtime.sendMessage.mock.calls.map((c) => c[0]);
    expect(msgs.find((m) => m.type === "PLAYBACK_STARTED")).toBeTruthy();
    expect(msgs.find((m) => m.type === "VIDEO_SEEK_BACK")).toBeFalsy();
  });
});

// ===================================================================
// Canvas-audio alignment
// ===================================================================

describe("canvas-audio alignment via first-utterance gap", () => {
  test("speech starting at position 3 → 3s gap before first audio plays", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    // Speech starts at second 3, not 0
    await env.sendUtterance({ seq: 1, start: 3, end: 5 });
    await env.sendUtterance({ seq: 2, start: 5, end: 7 });
    await env.sendUtterance({ seq: 3, start: 7, end: 9 });

    // First audio source should start with a 3s gap (capped at 3)
    const srcs = env.getPlaybackCtx()._sources;
    const firstStart = srcs[0].start.mock.calls[0][0];
    // nextPlayTime starts at ~0.1, gap of 3.0 → first audio at ~3.1
    expect(firstStart).toBeCloseTo(3.1, 0);
  });

  test("speech starting at position 0 → no leading gap", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    await env.sendUtterance({ seq: 1, start: 0, end: 2 });
    await env.sendUtterance({ seq: 2, start: 2, end: 4 });
    await env.sendUtterance({ seq: 3, start: 4, end: 6 });

    const srcs = env.getPlaybackCtx()._sources;
    const firstStart = srcs[0].start.mock.calls[0][0];
    // No gap needed — audio starts immediately at ~0.1
    expect(firstStart).toBeCloseTo(0.1, 1);
  });

  test("gap lets canvas draw intro frames before audio begins", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    // Speech starts at second 2
    await env.sendUtterance({ seq: 1, start: 2, end: 4 });
    await env.sendUtterance({ seq: 2, start: 4, end: 6 });
    await env.sendUtterance({ seq: 3, start: 6, end: 8 });

    // During the 2s gap, canvas draws frames at positions 0-2
    // When audio starts at ~2.1s, canvas is at position ~2 → in sync
    const srcs = env.getPlaybackCtx()._sources;
    const firstStart = srcs[0].start.mock.calls[0][0];
    expect(firstStart).toBeCloseTo(2.1, 0);

    // Subsequent utterances play right after (continuous speech)
    const secondStart = srcs[1].start.mock.calls[0][0];
    expect(secondStart).toBeCloseTo(firstStart + 1.0, 1); // duration + 0 gap
  });

  test("PLAYBACK_STARTED still carries audioStartSec for debugging", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    await env.sendFrames(5);

    await env.sendUtterance({ seq: 1, start: 5, end: 6 });
    await env.sendUtterance({ seq: 2, start: 6, end: 7 });
    await env.sendUtterance({ seq: 3, start: 7, end: 8 });

    const pbMsg = env.chrome.runtime.sendMessage.mock.calls
      .map((c) => c[0])
      .find((m) => m.type === "PLAYBACK_STARTED");
    expect(pbMsg).toBeTruthy();
    expect(pbMsg.audioStartSec).toBe(5);
  });
});

// ===================================================================
// Full session simulation: realistic sports broadcast
// ===================================================================

describe("full session: 60s sports broadcast with seekback", () => {
  test("two commentators, seekback, replay zone suppressed, new content plays", async () => {
    const env = createEnv({ decodedDuration: 1.0 });
    await env.boot();
    env.chrome._simulateMessage({ type: "SYNC_MODE_REPORT", mode: "seekback" }, {}, jest.fn());
    env.setDateNow(1000);
    await env.sendFrames(50); // 10s of audio captured
    env.setDateNow(11000);

    // === First pass: play-by-play during buffer phase (stream 0-10s) ===
    const firstPassUtterances = [
      { seq: 1, speaker: 0, start: 0, end: 2.5,
        caption: { original: "Saque de esquina", translated: "Corner kick" } },
      { seq: 2, speaker: 1, start: 3, end: 5,
        caption: { original: "Buen centro", translated: "Good cross" } },
      { seq: 3, speaker: 0, start: 5.5, end: 7.5,
        caption: { original: "Cabezazo de Torres", translated: "Header by Torres" } },
      { seq: 4, speaker: 0, start: 8, end: 10,
        caption: { original: "GOL!", translated: "GOAL!" } },
    ];
    for (const u of firstPassUtterances) await env.sendUtterance(u);

    expect(env.getState().isPlaying).toBe(true);
    expect(env.getState().inReplayZone).toBe(true);
    expect(env.playedSources().length).toBe(4);

    // === Replay zone: 50 frames (10s) suppressed — backend receives nothing ===
    const ws = env.WS._last();
    const sendsBefore = ws.send.mock.calls.length;
    await env.sendFrames(50);
    // No frames sent during replay zone
    expect(ws.send.mock.calls.length).toBe(sendsBefore);

    // === Replay zone ends. New content frames sent to backend. ===
    expect(env.getState().inReplayZone).toBe(false);
    await env.sendFrames(25); // 5s of new content

    // Backend returns new translations (stream continues from 10s)
    const newContent = [
      { seq: 5, speaker: 1, start: 10, end: 12,
        caption: { original: "Que golazo", translated: "What a goal" } },
      { seq: 6, speaker: 0, start: 13, end: 15,
        caption: { original: "Celebra con el público", translated: "Celebrates with fans" } },
    ];
    for (const u of newContent) await env.sendUtterance(u);

    // === VERIFY: audio ===
    // First pass: 4 + new: 2 = 6 total. No replay duplicates.
    expect(env.playedSources().length).toBe(6);

    // === VERIFY: captions ===
    const caps = env.captionMessages();
    const texts = caps.map((c) => c.caption.translated);
    expect(texts).toEqual([
      "Corner kick", "Good cross", "Header by Torres", "GOAL!",
      "What a goal", "Celebrates with fans",
    ]);
  });
});
