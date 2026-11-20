import { automationAt } from "./patch.js";
import { volumeToGain, filterLow, filterHigh, filterUses } from "./templates.js";

export const sampleRate = 44100;

function layerCurve(layer, id, plan) {
  const nodes = plan.evolving ? layer.automation?.[id] : null;
  const value = layer.values[id];
  return nodes ? sample => automationAt(nodes, plan.timeline, sample / sampleRate) : () => value;
}

class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;

  tune(frequency, high) {
    const omega = (2 * Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(omega) / (2 * Math.SQRT1_2);
    const cosine = Math.cos(omega);
    const edge = high ? (1 + cosine) / 2 : (1 - cosine) / 2;
    const norm = 1 + alpha;
    this.b0 = edge / norm;
    this.b1 = (high ? -(1 + cosine) : 1 - cosine) / norm;
    this.b2 = edge / norm;
    this.a1 = (-2 * cosine) / norm;
    this.a2 = (1 - alpha) / norm;
  }

  process(input) {
    const output = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }
}

function applyFilter(samples, layer, plan, wrapping) {
  const type = Number(layer.values.filter ?? 0);
  if (!type) {
    return;
  }
  const stages = [];
  for (const [id, map, high] of [["filterLow", filterLow, true], ["filterHigh", filterHigh, false]]) {
    if (filterUses(type, id)) {
      stages.push({ curve: layerCurve(layer, id, plan), map, high, filter: new Biquad() });
    }
  }
  const run = (index, write) => {
    for (const stage of stages) {
      if (index % 32 === 0) {
        stage.filter.tune(stage.map(stage.curve(index)), stage.high);
      }
    }
    let sample = samples[index];
    for (const stage of stages) {
      sample = stage.filter.process(sample);
    }
    if (write) {
      samples[index] = sample;
    }
  };
  if (wrapping) {
    const warmup = Math.min(samples.length, Math.round(0.5 * sampleRate));
    for (let index = samples.length - warmup; index < samples.length; index++) {
      run(index, false);
    }
  }
  for (let index = 0; index < samples.length; index++) {
    run(index, true);
  }
}

function synthSampler(source, layer, plan) {
  if (!source.variants) {
    return (index, mix) => source.dry[index] * (1 - mix) + source.wet[index] * mix;
  }
  const nodes = layer.automation[source.blend.control];
  const steps = source.blend.count - 1;
  return (index, mix) => {
    const position = automationAt(nodes, plan.timeline, index / sampleRate) * steps;
    const low = Math.min(steps, Math.floor(position));
    const high = Math.min(steps, low + 1);
    const fraction = position - low;
    const lowWeight = Math.cos((fraction * Math.PI) / 2);
    const highWeight = Math.sin((fraction * Math.PI) / 2);
    const sampleOf = variant => (variant ? variant.dry[index] * (1 - mix) + variant.wet[index] * mix : 0);
    return sampleOf(source.variants[low]) * lowWeight + sampleOf(source.variants[high]) * highWeight;
  };
}

function sourceLength(source) {
  return source.variants ? source.variants.find(Boolean).dry.length : source.dry.length;
}

function clipStarts(layer, clipSamples, total, wrapping) {
  if (!layer.loop) {
    return layer.hits.map(time => Math.round(time * sampleRate));
  }
  const first = Math.round((layer.hits[0] ?? 0) * sampleRate);
  const starts = [];
  const begin = wrapping ? first - Math.ceil(first / clipSamples) * clipSamples : first;
  for (let start = begin; start < total; start += clipSamples) {
    starts.push(start);
  }
  return starts;
}

function foldLoop(samples, loopSamples) {
  const crossfade = samples.length - loopSamples;
  const output = samples.slice(0, loopSamples);
  for (let index = 0; index < crossfade; index++) {
    const position = index / crossfade;
    output[index] = samples[index] * Math.sin((position * Math.PI) / 2) + samples[loopSamples + index] * Math.cos((position * Math.PI) / 2);
  }
  return output;
}

function mixClip(target, layer, source, plan, total, wrapping, volume, reverb) {
  const naturalSamples = source.dry.length;
  const clipSamples = layer.trim ? Math.min(naturalSamples, Math.round(layer.trim * sampleRate)) : naturalSamples;
  const fadeIn = Math.round(layer.fadeIn * sampleRate);
  const cutFade = clipSamples < naturalSamples ? Math.round(0.01 * sampleRate) : 0;
  const fadeOut = Math.max(cutFade, Math.round(layer.fadeOut * sampleRate));
  const first = Math.round((layer.hits[0] ?? 0) * sampleRate);
  const envelopeAt = (index, position) => {
    let envelope = 1;
    if (wrapping && layer.loop) {
      return envelope;
    }
    const sinceStart = layer.loop ? position - first : index;
    const untilEnd = layer.loop ? total - position : clipSamples - index;
    if (fadeIn > 0 && sinceStart < fadeIn) {
      envelope = sinceStart / fadeIn;
    }
    if (fadeOut > 0 && untilEnd < fadeOut) {
      envelope = Math.min(envelope, untilEnd / fadeOut);
    }
    return envelope;
  };
  for (const start of clipStarts(layer, clipSamples, total, wrapping)) {
    for (let index = 0; index < clipSamples; index++) {
      let position = start + index;
      if (wrapping) {
        position = ((position % total) + total) % total;
      } else if (position < 0) {
        continue;
      } else if (position >= total) {
        break;
      }
      const mix = reverb(position);
      const sample = source.dry[index] * (1 - mix) + source.wet[index] * mix;
      target[position] += sample * volumeToGain(volume(position)) * envelopeAt(index, position);
    }
  }
}

export function mixProject(project, sources, plan) {
  const total = Math.max(1, Math.round(plan.length * sampleRate));
  const loopSamples = Math.max(1, Math.round(plan.timeline * sampleRate));
  const wrapping = plan.looping && !plan.crossfade;
  const output = new Float32Array(total);
  const soloing = project.layers.some(layer => layer.solo);

  for (const layer of project.layers) {
    const source = sources.get(layer.id);
    if (!source || layer.muted || (soloing && !layer.solo)) {
      continue;
    }
    const volume = layerCurve(layer, "volume", plan);
    const reverb = layerCurve(layer, "reverb", plan);
    const filtered = Number(layer.values.filter ?? 0) !== 0;
    const target = filtered ? new Float32Array(total) : output;

    if (layer.kind === "synth") {
      const sampler = synthSampler(source, layer, plan);
      const length = Math.min(total, sourceLength(source));
      for (let index = 0; index < length; index++) {
        target[index] += sampler(index, reverb(index)) * volumeToGain(volume(index));
      }
    } else {
      mixClip(target, layer, source, plan, total, wrapping, volume, reverb);
    }
    if (filtered) {
      applyFilter(target, layer, plan, wrapping);
      for (let index = 0; index < total; index++) {
        output[index] += target[index];
      }
    }
  }

  if (plan.evolving && !plan.looping) {
    const fadeIn = Math.round(project.fadeIn * sampleRate);
    const fadeOut = Math.round(project.fadeOut * sampleRate);
    for (let index = 0; index < total; index++) {
      let envelope = 1;
      if (fadeIn > 0 && index < fadeIn) {
        envelope = index / fadeIn;
      }
      if (fadeOut > 0 && total - index < fadeOut) {
        envelope = Math.min(envelope, (total - index) / fadeOut);
      }
      output[index] *= envelope;
    }
  }

  return plan.crossfade ? foldLoop(output, loopSamples) : output;
}

export function peakOf(samples) {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

export function normalise(samples, target = 0.891) {
  const peak = peakOf(samples);
  if (peak > 0) {
    const gain = target / peak;
    for (let index = 0; index < samples.length; index++) {
      samples[index] *= gain;
    }
  }
  return samples;
}

export function limit(samples, ceiling = 0.891) {
  if (peakOf(samples) > ceiling) {
    normalise(samples, ceiling);
  }
  return samples;
}
