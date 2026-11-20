import { sampleRate } from "./mixer.js";

export class Player extends EventTarget {
  context = null;
  analyser = null;
  buffer = null;
  source = null;
  startedAt = 0;
  looping = true;

  ensureContext() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate });
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.7;
      this.analyser.connect(this.context.destination);
    }
    return this.context;
  }

  get playing() {
    return this.source !== null;
  }

  get position() {
    if (!this.playing || !this.buffer) {
      return 0;
    }
    const elapsed = this.context.currentTime - this.startedAt;
    return this.looping ? elapsed % this.buffer.duration : Math.min(elapsed, this.buffer.duration);
  }

  setSamples(samples, looping) {
    const context = this.ensureContext();
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const offset = this.position;
    this.buffer = buffer;
    this.looping = looping;
    if (this.playing) {
      this.start(offset % buffer.duration);
    }
  }

  async play() {
    const context = this.ensureContext();
    await context.resume();
    if (this.buffer) {
      this.start(0);
    }
  }

  start(offset) {
    this.stopSource();
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.loop = this.looping;
    source.connect(this.analyser);
    source.addEventListener("ended", () => {
      if (this.source === source) {
        this.source = null;
        this.dispatchEvent(new Event("stopped"));
      }
    });
    source.start(0, offset);
    this.source = source;
    this.startedAt = this.context.currentTime - offset;
  }

  stopSource() {
    if (this.source) {
      const source = this.source;
      this.source = null;
      source.stop();
    }
  }

  stop() {
    this.stopSource();
    this.dispatchEvent(new Event("stopped"));
  }

  async decode(arrayBuffer) {
    const decoded = await this.ensureContext().decodeAudioData(arrayBuffer);
    return decoded.getChannelData(0).slice();
  }
}
