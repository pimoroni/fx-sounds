import { templateById } from "./templates.js";

export const nodeCount = 16;

const voiceDefaults = {
  wave: "square",
  pulse_width: 0.5,
  pitch: 100,
  pitch_scale: 1,
  glide: 0,
  vibrato: "0 0",
  gate: 1,
  gate_slew: 0.003,
  level: 0,
  noise: "off",
  noise_colour: "white",
  noise_mod: 0,
  crackle: "off",
  blips: "off",
  babble: "off",
  engine: "off",
  rpm: "off",
  density: 1,
  drive: 0,
  highpass: 0,
  lowpass: 0,
  bandpass: "off",
  bandpass_q: 4,
  peak_eq: "0 0 1",
  sequence: "off",
};

export function formatNumber(value) {
  return Number(value.toFixed(4)).toString();
}

function formatValue(value) {
  return typeof value === "number" ? formatNumber(value) : String(value);
}

export function automationAt(nodes, timeline, time) {
  const position = Math.max(0, (time / timeline) * nodeCount);
  if (position >= nodeCount - 1) {
    return nodes[nodeCount - 1];
  }
  const index = Math.floor(position);
  return nodes[index] + (nodes[index + 1] - nodes[index]) * (position - index);
}

export function loopsCleanly(nodes) {
  return Math.abs(nodes[nodeCount - 1] - nodes[0]) < 0.005;
}

export function nodeTimes(length) {
  return Array.from({ length: nodeCount }, (_, index) => (index * length) / nodeCount);
}

export function automationEnvelope(nodes, timeline, length, map) {
  const times = nodeTimes(timeline);
  const points = nodes.map((node, index) => `${formatNumber(map(node))}@${formatNumber(times[index])}`);
  points.push(`${formatNumber(map(nodes[nodeCount - 1]))}@${formatNumber(length)}`);
  return `linear ${points.join(" ")}`;
}

export function controlValues(template, values = {}) {
  const resolved = {};
  for (const control of template.controls) {
    resolved[control.id] = control.id in values ? values[control.id] : control.value;
  }
  return resolved;
}

export function soundName(layer) {
  return `${layer.template}_${layer.variation}`;
}

export function buildPatch(layer, { length, timeline = length, oversampling, evolving }) {
  const template = templateById(layer.template);
  const values = controlValues(template, layer.values);
  const automated = id => Boolean(evolving && layer.automation?.[id]);
  const context = {
    length,
    values,
    evolving,
    automated,
    valueAt: (id, time) => (automated(id) ? automationAt(layer.automation[id], timeline, time) : values[id]),
  };
  const evaluate = value => (typeof value === "function" ? value(context) : value);

  const voices = template.voices.map(voice => {
    const keys = {};
    for (const [key, value] of Object.entries(voice.keys)) {
      keys[key] = evaluate(value);
    }
    return { name: voice.name, keys };
  });
  const voiceNamed = name => voices.find(voice => voice.name === name);

  const soundKeys = { length: formatNumber(length), oversampling, loudness: -20 };
  for (const [key, value] of Object.entries(template.sound)) {
    soundKeys[key] = evaluate(value);
  }

  for (const control of template.controls) {
    const nodes = evolving && control.automatable !== false && control.kind !== "choice" ? layer.automation?.[control.id] : null;
    for (const target of control.targets) {
      const value = nodes ? automationEnvelope(nodes, timeline, length, node => target.map(node, context)) : target.map(values[control.id], context);
      if (target.voice) {
        voiceNamed(target.voice).keys[target.key] = value;
      } else {
        soundKeys[target.key] = value;
      }
    }
  }

  const name = soundName(layer);
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(soundKeys)) {
    lines.push(`${key} = ${formatValue(value)}`);
  }
  const [main, ...extras] = voices;
  for (const [key, value] of Object.entries(main.keys)) {
    lines.push(`${key} = ${formatValue(value)}`);
  }
  for (const voice of extras) {
    lines.push("", `[${name}.${voice.name}]`);
    for (const key of Object.keys(main.keys)) {
      if (!(key in voice.keys)) {
        lines.push(`${key} = ${formatValue(voiceDefaults[key])}`);
      }
    }
    for (const [key, value] of Object.entries(voice.keys)) {
      lines.push(`${key} = ${formatValue(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}
