/*
 * AudioWorklet for live dictation. It turns microphone audio at the device's rate into 16 kHz,
 * 16-bit mono PCM and posts one 100 ms chunk at a time to the page, which sends it to the server.
 * It also posts the input level as a number from 0 to 1, for a "listening" indicator.
 * Plain JavaScript, served as its own file: worklet modules load by URL under the page's script-src.
 * Adapted from Shop Shepherd's capture processor.
 */
const TARGET_RATE = 16000;
/** 100 ms at the target rate. */
const CHUNK = 1600;
/** Render quanta (128 frames each) per level report: about 20 a second at 48 kHz. */
const LEVEL_EVERY = 16;
/** Scales speech RMS, which is usually well under 0.3, into a useful 0 to 1 range. */
const LEVEL_GAIN = 4;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the AudioWorkletGlobalScope's own rate, so no message is needed to learn it.
    this.ratio = sampleRate / TARGET_RATE;
    this.buffer = new Float32Array(Math.ceil(CHUNK * this.ratio));
    this.length = 0;
    this.stopped = false;
    this.levelSum = 0;
    this.levelFrames = 0;
    this.quanta = 0;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.stopped = true;
        this.flush();
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (this.stopped) return false;
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.buffer[this.length] = channel[index];
      this.length += 1;
      this.levelSum += channel[index] * channel[index];
      if (this.length === this.buffer.length) this.flush();
    }
    this.levelFrames += channel.length;
    this.quanta += 1;
    if (this.quanta === LEVEL_EVERY) {
      this.port.postMessage(Math.min(1, Math.sqrt(this.levelSum / this.levelFrames) * LEVEL_GAIN));
      this.levelSum = 0;
      this.levelFrames = 0;
      this.quanta = 0;
    }
    return true;
  }

  /** Resamples by linear interpolation, converts to Int16 and posts the buffered audio. */
  flush() {
    if (this.length === 0) return;
    const count = Math.floor(this.length / this.ratio);
    const out = new Int16Array(count);
    for (let index = 0; index < count; index += 1) {
      const position = index * this.ratio;
      const low = Math.floor(position);
      const high = Math.min(low + 1, this.length - 1);
      const value = this.buffer[low] + (this.buffer[high] - this.buffer[low]) * (position - low);
      const clipped = Math.max(-1, Math.min(1, value));
      out[index] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    }
    this.length = 0;
    this.port.postMessage(out.buffer, [out.buffer]);
  }
}

registerProcessor("capture-processor", CaptureProcessor);
