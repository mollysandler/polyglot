/**
 * AudioWorkletProcessor that emits continuous 200ms PCM frames.
 *
 * Unlike the v1 ChunkAccumulator (which buffered 8 seconds), this processor
 * emits small frames suitable for streaming over a WebSocket. The offscreen
 * document handles resampling to 16 kHz before sending.
 */
class StreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Target frame duration in seconds (default 200ms)
    const params = options.processorOptions || {};
    this.frameDurationSec = params.frameDurationSec || 0.2;
    this.buffer = [];
    this.samplesNeeded = Math.round(sampleRate * this.frameDurationSec);
    this.totalSamples = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0]; // mono
    if (!channelData || channelData.length === 0) return true;

    // Accumulate samples
    for (let i = 0; i < channelData.length; i++) {
      this.buffer.push(channelData[i]);
    }
    this.totalSamples += channelData.length;

    // Emit frames when we have enough samples
    while (this.buffer.length >= this.samplesNeeded) {
      const frame = new Float32Array(this.buffer.splice(0, this.samplesNeeded));

      // Compute RMS for silence detection
      let sumSq = 0;
      for (let i = 0; i < frame.length; i++) {
        sumSq += frame[i] * frame[i];
      }
      const rms = Math.sqrt(sumSq / frame.length);

      this.port.postMessage({
        type: "frame",
        samples: frame,
        rms: rms,
        sampleRate: sampleRate,
        totalSamples: this.totalSamples,
      });
    }

    return true;
  }
}

registerProcessor("stream-processor", StreamProcessor);
