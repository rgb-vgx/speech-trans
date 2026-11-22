/**
 * Tab audio -> 16 kHz mono int16, in 100 ms frames.
 *
 * The tab stream runs at the AudioContext rate (44.1/48 kHz). This worklet
 * downmixes to mono, resamples to 16 kHz with linear interpolation and posts
 * 1600-sample Int16Array buffers (transferable) to the offscreen document.
 */
class Pcm16Resampler extends AudioWorkletProcessor {
  constructor() {
    super();
    // `step` is in INPUT samples: one output sample every `step` inputs.
    // 16 kHz out of 48 kHz -> 3. (Getting this inverted silently produces 3
    // outputs per input, i.e. 9x the audio and garbage for ASR.)
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.prev = 0;
    this.started = false;
    this.frameSize = 1600; // 100 ms @ 16 kHz
    this.out = new Float32Array(this.frameSize);
    this.outLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    const right = input.length > 1 ? input[1] : null;

    for (let i = 0; i < left.length; i += 1) {
      const cur = right ? (left[i] + right[i]) * 0.5 : left[i];
      if (!this.started) {
        this.prev = cur;
        this.started = true;
      }
      while (this.pos < 1) {
        this.out[this.outLen] = this.prev + (cur - this.prev) * this.pos;
        this.outLen += 1;
        if (this.outLen === this.frameSize) this.flush();
        this.pos += this.step;
      }
      this.pos -= 1;
      this.prev = cur;
    }
    return true;
  }

  flush() {
    const pcm = new Int16Array(this.frameSize);
    for (let i = 0; i < this.frameSize; i += 1) {
      let v = this.out[i];
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.outLen = 0;
  }
}

registerProcessor("pcm16-resampler", Pcm16Resampler);
