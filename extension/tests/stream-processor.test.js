/**
 * @jest-environment node
 *
 * Tests for stream-processor.js (AudioWorkletProcessor).
 * Ideal behavior: reliably emits 200ms frames with accurate RMS,
 * handles missing/empty input gracefully, preserves leftover samples.
 */

let ProcessorClass;

beforeAll(() => {
  global.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: jest.fn() };
    }
  };
  global.registerProcessor = jest.fn((name, cls) => {
    ProcessorClass = cls;
  });
  global.sampleRate = 48000;

  jest.isolateModules(() => {
    require("../offscreen/stream-processor");
  });
});

afterAll(() => {
  delete global.AudioWorkletProcessor;
  delete global.registerProcessor;
  delete global.sampleRate;
});

describe("StreamProcessor", () => {
  test("registers as 'stream-processor'", () => {
    expect(global.registerProcessor).toHaveBeenCalledWith("stream-processor", expect.any(Function));
  });

  test("default frame duration is 200ms (9600 samples at 48kHz)", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    expect(p.samplesNeeded).toBe(9600);
  });

  test("custom frameDurationSec changes frame size", () => {
    const p = new ProcessorClass({ processorOptions: { frameDurationSec: 0.1 } });
    expect(p.samplesNeeded).toBe(4800);
  });

  test("accumulates samples across multiple process() calls", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    p.process([[new Float32Array(4800)]]);
    expect(p.port.postMessage).not.toHaveBeenCalled();
    p.process([[new Float32Array(4800)]]);
    expect(p.port.postMessage).toHaveBeenCalledTimes(1);
  });

  test("emits frame with correct structure", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    p.process([[new Float32Array(9600)]]);
    expect(p.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "frame",
        samples: expect.any(Float32Array),
        rms: expect.any(Number),
        sampleRate: 48000,
        totalSamples: expect.any(Number),
      })
    );
  });

  test("emits multiple frames when buffer overflows in one call", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    p.process([[new Float32Array(9600 * 3)]]);
    expect(p.port.postMessage).toHaveBeenCalledTimes(3);
  });

  test("RMS is 0 for silence", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    p.process([[new Float32Array(9600)]]); // all zeros
    expect(p.port.postMessage.mock.calls[0][0].rms).toBe(0);
  });

  test("RMS is correct for constant amplitude", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    const data = new Float32Array(9600).fill(0.5);
    p.process([[data]]);
    expect(p.port.postMessage.mock.calls[0][0].rms).toBeCloseTo(0.5, 3);
  });

  test("totalSamples tracks cumulative count", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    p.process([[new Float32Array(9600)]]);
    const t1 = p.port.postMessage.mock.calls[0][0].totalSamples;
    p.process([[new Float32Array(9600)]]);
    const t2 = p.port.postMessage.mock.calls[1][0].totalSamples;
    expect(t2).toBe(t1 + 9600);
  });

  test("returns true for empty input (keeps processor alive)", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    expect(p.process([])).toBe(true);
    expect(p.process([[]])).toBe(true);
  });

  test("returns true for missing channel data", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    expect(p.process([[null]])).toBe(true);
    expect(p.process([[undefined]])).toBe(true);
  });

  test("leftover samples preserved for next call", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    p.process([[new Float32Array(5000)]]);
    expect(p.port.postMessage).not.toHaveBeenCalled();
    // 5000 + 5000 = 10000 → 1 frame (9600) + 400 leftover
    p.process([[new Float32Array(5000)]]);
    expect(p.port.postMessage).toHaveBeenCalledTimes(1);
    // 400 + 9200 = 9600 → another frame
    p.process([[new Float32Array(9200)]]);
    expect(p.port.postMessage).toHaveBeenCalledTimes(2);
  });

  test("frame samples have exactly samplesNeeded length", () => {
    const p = new ProcessorClass({ processorOptions: {} });
    p.process([[new Float32Array(9600)]]);
    expect(p.port.postMessage.mock.calls[0][0].samples.length).toBe(9600);
  });
});
