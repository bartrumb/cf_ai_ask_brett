/*
 * AudioWorklet for live dictation. It turns microphone audio at the device's rate into 16 kHz,
 * 16-bit mono PCM and posts one 100 ms chunk at a time to the page, which sends it to the server.
 * Plain JavaScript, served as its own file: worklet modules load by URL under the page's script-src.
 * Adapted from Shop Shepherd's capture processor.
 */
const TARGET_RATE = 16000;
/** 100 ms at the target rate. */
const CHUNK = 1600;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the AudioWorkletGlobalScope's own rate, so no message is needed to learn it.
    this.ratio = sampleRate / TARGET_RATE;
    this.buffer = new Float32Array(Math.ceil(CHUNK * this.ratio));
    this.length = 0;
    this.stopped = false;
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
      if (this.length === this.buffer.length) this.flush();
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
