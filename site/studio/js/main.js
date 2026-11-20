import { templates, templateById, mixerControls, filterUses } from "./templates.js";
import { buildPatch, controlValues, soundName, automationAt, loopsCleanly, nodeCount } from "./patch.js";
import { renderPatch } from "./engine.js";
import { mixProject, sampleRate, limit, normalise, peakOf } from "./mixer.js";
import { Player } from "./player.js";
import { drawSpectrum, drawWaveform, drawOverview, themeColours } from "./visualiser.js";
import { createAutomationEditor, createClipEditor } from "./timeline.js";
import { saveRecord, listRecords, getRecord, deleteRecord } from "./store.js";
import { encodeWav } from "./wav.js";

const maximumLayers = 4;
const lengthRange = [0.5, 120];
const clipGroupTitles = {
  clips: "Clips",
  uk: "UK emergency",
  us: "US emergency",
  scifi: "Sci-fi",
  alarms: "Alarms",
  fire: "Fire",
  civil: "Civil defence",
  rail: "Railway",
  maritime: "Maritime",
  signals: "Signals",
  phones: "Telephone tones",
  electric: "Electricity",
  engines: "Engines",
  ambience: "Ambience",
  roomtone: "Room tone",
};

const elements = {
  body: document.body,
  form: document.querySelector("#project-form"),
  name: document.querySelector("#project-name"),
  heading: document.querySelector("#project-heading"),
  rename: document.querySelector("#rename"),
  length: document.querySelector("#project-length"),
  fadeIn: document.querySelector("#fade-in"),
  fadeOut: document.querySelector("#fade-out"),
  play: document.querySelector("#play"),
  loopPlayback: document.querySelector("#loop-playback"),
  exportButton: document.querySelector("#export"),
  saveProject: document.querySelector("#save-project"),
  newProject: document.querySelector("#new-project"),
  overview: document.querySelector("#overview"),
  overviewCanvas: document.querySelector("#overview canvas"),
  status: document.querySelector("#status"),
  position: document.querySelector("#position"),
  layers: document.querySelector("#layers"),
  layersHint: document.querySelector("#layers-hint"),
  spectrum: document.querySelector("#spectrum"),
  waveform: document.querySelector("#waveform"),
  templateGroups: document.querySelector("#template-groups"),
  clipGroups: document.querySelector("#clip-groups"),
  savedSounds: document.querySelector("#saved-sounds"),
  savedProjects: document.querySelector("#saved-projects"),
  dialog: document.querySelector("#name-dialog"),
};

const project = emptyProject();
const previews = new Map();
const clipSources = new Map();
const views = new Map();
const player = new Player();
let nextLayerId = 1;
let mixed = null;
let renderTimer = null;
let remixTimer = null;
let renderGeneration = 0;
const colours = themeColours(document.body);
let persistTimer = null;
const currentProjectKey = "fx-sounds-studio:current";

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(currentProjectKey, JSON.stringify(projectSnapshot()));
    } catch {
    }
  }, 400);
}

function restoredProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(currentProjectKey));
    return saved && Array.isArray(saved.layers) ? saved : null;
  } catch {
    return null;
  }
}

function emptyProject() {
  return { name: "Untitled", length: 8, loop: true, fadeIn: 0, fadeOut: 0, layers: [] };
}

function previewOversampling() {
  return project.length <= 30 ? 2 : 1;
}

function exportOversampling() {
  return project.length <= 30 ? 8 : project.length <= 60 ? 4 : 2;
}

function renderPlan() {
  const timeline = project.length;
  if (!project.loop) {
    return { evolving: true, looping: false, timeline, length: timeline, crossfade: 0 };
  }
  const breaksLoop = project.layers.some(layer => Object.values(layer.automation).some(nodes => !loopsCleanly(nodes)));
  const crossfade = breaksLoop ? Math.min(2, timeline / 4) : 0;
  return { evolving: true, looping: true, timeline, length: timeline + crossfade, crossfade };
}

function renderSettings(oversampling) {
  const plan = renderPlan();
  return { length: plan.length, timeline: plan.timeline, oversampling, evolving: plan.evolving };
}

function slug(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sound";
}

function prettyName(name) {
  return name.replace(/_/g, " ").replace(/^\w/, letter => letter.toUpperCase());
}

function setStatus(message) {
  elements.status.textContent = message;
}

function idleStatus() {
  const count = project.layers.length;
  if (!count) {
    setStatus("Add a sound from the palette to start.");
    return;
  }
  const plan = renderPlan();
  const mode = !plan.looping
    ? "one-shot"
    : plan.crossfade
      ? `loop, crossfaded over ${plan.crossfade.toFixed(1)} s because some curves end differently from how they start`
      : "seamless loop";
  setStatus(`${count} ${count === 1 ? "layer" : "layers"}, ${project.length.toFixed(1)} s ${mode}.`);
}

function mixerDefaults() {
  return Object.fromEntries(mixerControls.map(control => [control.id, control.value]));
}

function automatableControls(layer) {
  const own = layer.kind === "synth"
    ? templateById(layer.template).controls.filter(control => control.automatable !== false)
    : [];
  return [...own, ...mixerControls.filter(control => control.automatable !== false)];
}

function formatControl(control, value) {
  return control.format ? control.format(value) : `${Math.round(value * 100)}%`;
}

function choicePosition(control, value) {
  const index = control.options.findIndex(([option]) => Number(option) === Number(value));
  return Math.max(0, index) / (control.options.length - 1);
}

function formatBlend(control, position) {
  const scaled = position * (control.options.length - 1);
  const low = Math.floor(scaled + 0.001);
  const fraction = scaled - low;
  if (fraction < 0.02 || low >= control.options.length - 1) {
    return control.options[Math.min(low, control.options.length - 1)][1];
  }
  if (fraction > 0.98) {
    return control.options[low + 1][1];
  }
  return `${control.options[low][1]} to ${control.options[low + 1][1]}, ${Math.round(fraction * 100)}%`;
}

function formatAutomated(control, value) {
  return control.kind === "choice" ? formatBlend(control, value) : formatControl(control, value);
}

function addSynthLayer(templateId, saved = null) {
  if (project.layers.length >= maximumLayers) {
    setStatus(`A project can have up to ${maximumLayers} layers.`);
    return;
  }
  const template = templateById(templateId);
  const layer = {
    id: nextLayerId++,
    kind: "synth",
    template: templateId,
    variation: saved?.variation ?? 1,
    values: { ...mixerDefaults(), ...controlValues(template), ...(saved?.values ?? {}) },
    automation: structuredClone(saved?.automation ?? {}),
    parked: structuredClone(saved?.parked ?? {}),
    muted: false,
    solo: false,
  };
  layer.focus = automatableControls(layer)[0].id;
  project.layers.push(layer);
  layersChanged();
}

function addClipLayer(source, name) {
  if (project.layers.length >= maximumLayers) {
    setStatus(`A project can have up to ${maximumLayers} layers.`);
    return;
  }
  project.layers.push({
    id: nextLayerId++,
    kind: "clip",
    source,
    name,
    hits: [0],
    loop: false,
    fadeIn: 0,
    fadeOut: 0,
    values: { ...mixerDefaults(), reverb: 0.3 },
    automation: {},
    muted: false,
    solo: false,
    focus: "volume",
  });
  layersChanged();
}

function layersChanged() {
  renderLayers();
  scheduleRender(0);
}

function clipKey(source) {
  return source.type === "gallery" ? `gallery:${source.file}` : `saved:${source.id}`;
}

function layerFromRecord(record) {
  return { template: record.template, variation: record.variation, values: record.values, automation: record.automation };
}

function trimClip({ dry, wet }) {
  let peak = 0;
  for (const sample of dry) {
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak === 0) {
    return { dry, wet };
  }
  const threshold = peak * 0.003;
  const first = dry.findIndex(sample => Math.abs(sample) > threshold);
  const last = dry.findLastIndex(sample => Math.abs(sample) > threshold);
  const tail = Math.round(1.0 * sampleRate);
  const start = Math.max(0, first - Math.round(0.005 * sampleRate));
  const end = Math.min(dry.length, last + tail);
  if (end - start > dry.length * 0.95) {
    return { dry, wet };
  }
  const fade = Math.max(1, end - last);
  const cut = samples => {
    const trimmed = samples.slice(start, end);
    for (let index = 0; index < fade; index++) {
      trimmed[trimmed.length - 1 - index] *= index / fade;
    }
    return trimmed;
  };
  return { dry: cut(dry), wet: cut(wet) };
}

function peaksOf(samples, bins = 64) {
  const peaks = [];
  let loudest = 0;
  for (let bin = 0; bin < bins; bin++) {
    let peak = 0;
    const start = Math.floor((bin / bins) * samples.length);
    const end = Math.floor(((bin + 1) / bins) * samples.length);
    for (let index = start; index < end; index++) {
      peak = Math.max(peak, Math.abs(samples[index]));
    }
    peaks.push(peak);
    loudest = Math.max(loudest, peak);
  }
  return peaks.map(peak => (loudest > 0 ? peak / loudest : 0));
}

function finishClip(clip) {
  const trimmed = trimClip(clip);
  return { ...trimmed, peaks: peaksOf(trimmed.wet) };
}

async function fetchClip(source) {
  if (source.type === "gallery") {
    const [dry, wet] = await Promise.all(["dry", "wet"].map(async mix => {
      const response = await fetch(`../sounds/${source.file}_${mix}.wav`);
      if (!response.ok) {
        throw new Error(`Could not load ${source.file}`);
      }
      return player.decode(await response.arrayBuffer());
    }));
    return finishClip({ dry, wet });
  }
  const record = await getRecord("sounds", source.id);
  if (!record) {
    throw new Error("That saved sound no longer exists");
  }
  const patch = buildPatch(layerFromRecord(record), { length: record.length, oversampling: 4, evolving: true });
  const [sound] = await renderPatch(patch);
  return finishClip({ dry: sound.dry, wet: sound.wet });
}

function loadClip(source) {
  const key = clipKey(source);
  if (!clipSources.has(key)) {
    clipSources.set(key, fetchClip(source).catch(error => {
      clipSources.delete(key);
      throw error;
    }));
  }
  return clipSources.get(key);
}

function layerStatus(layer, message) {
  const output = views.get(layer.id)?.article.querySelector('[data-role="status"]');
  if (output) {
    output.textContent = message;
  }
}

async function renderSynthSource(layer, oversampling, previous, onRender = () => {}) {
  const settings = renderSettings(oversampling);
  const template = templateById(layer.template);
  const blend = settings.evolving ? template.controls.find(control => control.kind === "choice" && layer.automation[control.id]) : null;
  const variantLayers = [];
  if (!blend) {
    variantLayers.push([0, layer]);
  } else {
    const positions = layer.automation[blend.id].map(node => node * (blend.options.length - 1));
    const low = Math.floor(Math.min(...positions));
    const high = Math.min(blend.options.length - 1, Math.ceil(Math.max(...positions)));
    for (let index = low; index <= high; index++) {
      const automation = { ...layer.automation };
      delete automation[blend.id];
      variantLayers.push([index, { ...layer, values: { ...layer.values, [blend.id]: blend.options[index][0] }, automation }]);
    }
  }
  const patches = new Map();
  const variants = [];
  const warnings = [];
  for (const [index, variantLayer] of variantLayers) {
    const patch = buildPatch(variantLayer, settings);
    let sound = previous?.patches?.get(patch);
    if (!sound) {
      onRender();
      [sound] = await renderPatch(patch);
    }
    patches.set(patch, sound);
    variants[index] = sound;
    warnings.push(...sound.warnings);
  }
  const source = { patches, warnings };
  if (blend) {
    return { ...source, variants, blend: { control: blend.id, count: blend.options.length } };
  }
  return { ...source, dry: variants[0].dry, wet: variants[0].wet };
}

async function ensurePreview(layer, oversampling) {
  if (layer.kind === "synth") {
    const source = await renderSynthSource(layer, oversampling, previews.get(layer.id), () => layerStatus(layer, "Rendering…"));
    previews.set(layer.id, source);
    layerStatus(layer, [...new Set(source.warnings)].join(" "));
    return;
  }
  const clip = await loadClip(layer.source);
  previews.set(layer.id, { key: clipKey(layer.source), ...clip });
  const naturalLength = clip.dry.length / sampleRate;
  const view = views.get(layer.id);
  view?.clipEditor?.update({ clipLength: clipLength(layer, clip), length: project.length, peaks: clip.peaks });
  if (view?.trimInput) {
    view.trimInput.max = naturalLength.toFixed(2);
    view.trimInput.value = clipLength(layer, clip).toFixed(2);
  }
  layerStatus(layer, `${naturalLength.toFixed(2)} s clip${layer.trim ? `, cut to ${layer.trim.toFixed(2)} s` : ""}`);
}

function clipLength(layer, clip) {
  const natural = clip.dry.length / sampleRate;
  return layer.trim ? Math.min(natural, layer.trim) : natural;
}

function scheduleRender(delay = 250) {
  persist();
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreviews, delay);
}

async function renderPreviews() {
  const generation = ++renderGeneration;
  const oversampling = previewOversampling();
  elements.body.setAttribute("aria-busy", "true");
  try {
    for (const layer of project.layers) {
      if (generation !== renderGeneration) {
        return;
      }
      try {
        await ensurePreview(layer, oversampling);
      } catch (error) {
        layerStatus(layer, `Error: ${error.message}`);
      }
    }
    if (generation === renderGeneration) {
      remix();
    }
  } finally {
    if (generation === renderGeneration) {
      elements.body.removeAttribute("aria-busy");
    }
  }
}

function scheduleRemix() {
  clearTimeout(remixTimer);
  remixTimer = setTimeout(remix, 60);
}

function remix() {
  persist();
  for (const id of previews.keys()) {
    if (!project.layers.some(layer => layer.id === id)) {
      previews.delete(id);
    }
  }
  const plan = renderPlan();
  const full = mixProject(project, previews, plan);
  const reference = peakOf(full) || 1;
  mixed = limit(full);
  player.setSamples(mixed, plan.looping);
  drawOverview(elements.overviewCanvas, mixed, colours);
  for (const view of views.values()) {
    const layer = { ...view.layer, muted: false, solo: false };
    view.waveform = { samples: mixProject({ ...project, layers: [layer] }, previews, plan), gain: 1 / reference };
    drawLayerWaveform(view);
  }
  idleStatus();
}

function drawLayerWaveform(view) {
  if (view.waveform) {
    drawOverview(view.article.querySelector('[data-role="waveform"] canvas'), view.waveform.samples, colours, view.waveform.gain);
  }
}

function renderLayers() {
  elements.layers.replaceChildren();
  views.clear();
  for (const layer of project.layers) {
    elements.layers.append(buildLayerView(layer));
  }
  const free = maximumLayers - project.layers.length;
  elements.layersHint.textContent = project.layers.length
    ? `${free} of ${maximumLayers} layers free.`
    : `Up to ${maximumLayers} layers. Add sounds and clips from the palette.`;
  for (const button of document.querySelectorAll("aside [data-add]")) {
    button.disabled = free === 0;
  }
}

let fieldCount = 0;

function controlField(view, control, onChange) {
  const { layer } = view;
  const id = `control-${++fieldCount}`;
  const item = document.createElement("li");
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = control.label;
  const output = document.createElement("output");
  output.setAttribute("for", id);
  let input;
  if (control.kind === "choice") {
    input = document.createElement("select");
    for (const [value, text] of control.options) {
      input.append(new Option(text, value, false, Number(value) === Number(layer.values[control.id])));
    }
    input.addEventListener("change", () => {
      layer.values[control.id] = Number(input.value);
      onChange(control);
    });
  } else {
    input = document.createElement("input");
    Object.assign(input, { type: "range", min: 0, max: 1, step: 0.01, value: layer.values[control.id] });
    input.addEventListener("input", () => {
      layer.values[control.id] = Number(input.value);
      output.textContent = formatControl(control, layer.values[control.id]);
      onChange(control);
    });
    output.textContent = formatControl(control, layer.values[control.id]);
  }
  input.id = id;
  item.append(label, input, output);
  const field = { item, input, output, control };
  if (control.automatable !== false) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.append(icon("tune"));
    toggle.title = "Automate";
    toggle.setAttribute("aria-pressed", "false");
    toggle.setAttribute("aria-label", `Automate ${control.label} on the timeline`);
    toggle.addEventListener("click", () => toggleAutomation(view, control));
    item.append(toggle);
    field.toggle = toggle;
  }
  return field;
}

function toggleAutomation(view, control) {
  const { layer } = view;
  layer.parked ??= {};
  if (layer.automation[control.id]) {
    layer.parked[control.id] = layer.automation[control.id];
    delete layer.automation[control.id];
  } else if (layer.parked[control.id]) {
    layer.automation[control.id] = layer.parked[control.id];
    delete layer.parked[control.id];
  } else {
    const start = control.kind === "choice" ? choicePosition(control, layer.values[control.id]) : layer.values[control.id];
    layer.automation[control.id] = Array(nodeCount).fill(start);
  }
  layer.focus = control.id;
  view.focusSelect.value = control.id;
  buildAutomation(view);
  refreshControlStates(view);
  scheduleRender(0);
}

function automationTime() {
  return player.playing && player.buffer ? (player.position / player.buffer.duration) * project.length : 0;
}

function showAutomatedValue(field, nodes, time) {
  const value = automationAt(nodes, project.length, time);
  if (field.control.kind === "choice") {
    const index = Math.round(value * (field.control.options.length - 1));
    field.input.value = field.control.options[index][0];
  } else {
    field.input.value = value;
  }
  field.output.textContent = formatAutomated(field.control, value);
}

function refreshControlStates(view) {
  const time = automationTime();
  for (const field of view.fields) {
    const id = field.control.id;
    const unused = id.startsWith("filter") && id !== "filter" && !filterUses(Number(view.layer.values.filter ?? 0), id);
    const nodes = view.layer.automation[id];
    field.input.disabled = Boolean(nodes) || unused;
    if (field.toggle) {
      field.toggle.disabled = unused;
    }
    field.item.toggleAttribute("data-unused", unused);
    field.toggle?.setAttribute("aria-pressed", String(Boolean(view.layer.automation[field.control.id])));
    if (nodes) {
      showAutomatedValue(field, nodes, time);
    } else if (field.control.kind === "choice") {
      field.input.value = view.layer.values[field.control.id];
    } else {
      field.input.value = view.layer.values[field.control.id];
      field.output.textContent = formatControl(field.control, view.layer.values[field.control.id]);
    }
  }
}

function buildAutomation(view) {
  const { layer, article } = view;
  const figure = article.querySelector('[data-role="automation"]');
  if (!figure) {
    return;
  }
  const control = automatableControls(layer).find(candidate => candidate.id === layer.focus);
  const isMix = mixerControls.includes(control);
  const editor = createAutomationEditor({
    label: control.label,
    nodes: layer.automation[control.id] ?? null,
    baseline: control.kind === "choice" ? choicePosition(control, layer.values[control.id]) : layer.values[control.id],
    length: project.length,
    format: value => formatAutomated(control, value),
    onInput: nodes => {
      layer.automation[control.id] = nodes;
      refreshControlStates(view);
      if (isMix) {
        scheduleRemix();
      }
    },
    onCommit: nodes => {
      layer.automation[control.id] = nodes;
      refreshControlStates(view);
      scheduleRender(isMix ? 0 : 100);
    },
  });
  figure.replaceChildren(editor);
}

function buildLayerView(layer) {
  const fragment = document.querySelector(layer.kind === "synth" ? "#synth-layer" : "#clip-layer").content.firstElementChild.cloneNode(true);
  const article = fragment.querySelector("article");
  const view = { layer, article, fields: [] };
  views.set(layer.id, view);
  new ResizeObserver(() => drawLayerWaveform(view)).observe(article.querySelector('[data-role="waveform"] canvas'));

  if (layer.kind === "synth") {
    const template = templateById(layer.template);
    article.querySelector("h3").textContent = template.name;
    article.querySelector("header p").textContent = `${template.description}. Variation ${layer.variation}.`;
    const soundList = document.createElement("ul");
    article.querySelector('[data-group="sound"]').append(soundList);
    for (const control of template.controls) {
      const field = controlField(view, control, () => {
        scheduleRender();
        if (layer.focus === control.id && !layer.automation[control.id]) {
          buildAutomation(view);
        }
      });
      view.fields.push(field);
      soundList.append(field.item);
    }
  } else {
    article.querySelector("h3").textContent = layer.name;
    const loop = article.querySelector('[data-role="loop"]');
    const trim = article.querySelector('[data-role="trim"]');
    view.trimInput = trim;
    trim.addEventListener("change", () => {
      const clip = previews.get(layer.id);
      const natural = clip ? clip.dry.length / sampleRate : Infinity;
      const value = Math.max(0.05, Number(trim.value) || natural);
      layer.trim = value >= natural - 0.001 ? null : value;
      if (clip) {
        view.clipEditor.update({ clipLength: clipLength(layer, clip) });
        layerStatus(layer, `${natural.toFixed(2)} s clip${layer.trim ? `, cut to ${layer.trim.toFixed(2)} s` : ""}`);
      }
      remix();
    });
    const fadeIn = article.querySelector('[data-role="fade-in"]');
    const fadeOut = article.querySelector('[data-role="fade-out"]');
    loop.checked = layer.loop;
    fadeIn.value = layer.fadeIn;
    fadeOut.value = layer.fadeOut;
    loop.addEventListener("change", () => {
      layer.loop = loop.checked;
      if (layer.loop && layer.hits.length > 1) {
        layer.hits = layer.hits.slice(0, 1);
      }
      renderLayers();
      remix();
    });
    fadeIn.addEventListener("change", () => {
      layer.fadeIn = Math.max(0, Number(fadeIn.value) || 0);
      remix();
    });
    fadeOut.addEventListener("change", () => {
      layer.fadeOut = Math.max(0, Number(fadeOut.value) || 0);
      remix();
    });
    const preview = previews.get(layer.id);
    if (preview) {
      trim.max = (preview.dry.length / sampleRate).toFixed(2);
      trim.value = clipLength(layer, preview).toFixed(2);
    }
    view.clipEditor = createClipEditor({
      name: layer.name,
      hits: layer.hits,
      clipLength: preview ? clipLength(layer, preview) : 1,
      peaks: preview?.peaks ?? null,
      length: project.length,
      looping: layer.loop,
      wrapping: renderPlan().looping && !renderPlan().crossfade,
      onChange: hits => {
        layer.hits = hits;
        remix();
      },
    });
    const placements = article.querySelector('[data-role="placements"]');
    placements.prepend(view.clipEditor.element);
  }

  const mixList = document.createElement("ul");
  article.querySelector('[data-group="mix"]').append(mixList);
  const filterList = document.createElement("ul");
  article.querySelector('[data-group="filter"]').append(filterList);
  for (const control of mixerControls) {
    const field = controlField(view, control, () => {
      scheduleRemix();
      if (control.id === "filter") {
        refreshControlStates(view);
      }
      if (layer.focus === control.id && !layer.automation[control.id]) {
        buildAutomation(view);
      }
    });
    view.fields.push(field);
    (control.id.startsWith("filter") ? filterList : mixList).append(field.item);
  }

  const focus = article.querySelector('[data-role="focus"]');
  view.focusSelect = focus;
  for (const control of automatableControls(layer)) {
    focus.append(new Option(control.label, control.id, false, control.id === layer.focus));
  }
  focus.addEventListener("change", () => {
    layer.focus = focus.value;
    buildAutomation(view);
    persist();
  });

  for (const button of article.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    if (action === "mute" || action === "solo") {
      button.setAttribute("aria-pressed", String(layer[action === "mute" ? "muted" : "solo"]));
    }
    button.addEventListener("click", () => layerAction(view, action, button));
  }

  buildAutomation(view);
  refreshControlStates(view);
  return fragment;
}

async function layerAction(view, action, button) {
  const { layer } = view;
  if (action === "mute" || action === "solo") {
    const key = action === "mute" ? "muted" : "solo";
    layer[key] = !layer[key];
    button.setAttribute("aria-pressed", String(layer[key]));
    remix();
  } else if (action === "variation") {
    layer.variation++;
    view.article.querySelector("header p").textContent = `${templateById(layer.template).description}. Variation ${layer.variation}.`;
    scheduleRender(0);
  } else if (action === "flatten") {
    delete layer.automation[layer.focus];
    delete layer.parked?.[layer.focus];
    buildAutomation(view);
    refreshControlStates(view);
    if (mixerControls.some(control => control.id === layer.focus)) {
      remix();
    } else {
      scheduleRender(0);
    }
  } else if (action === "save") {
    const name = await askName(`${templateById(layer.template).name} ${layer.variation}`);
    if (name) {
      await saveRecord("sounds", {
        name,
        template: layer.template,
        variation: layer.variation,
        values: { ...layer.values },
        automation: structuredClone(layer.automation),
        parked: structuredClone(layer.parked ?? {}),
        length: project.length,
        created: Date.now(),
      });
      setStatus(`Saved ${name} to My sounds.`);
      refreshSaved();
    }
  } else if (action === "export") {
    const name = layer.kind === "synth" ? templateById(layer.template).name : layer.name;
    button.disabled = true;
    layerStatus(layer, "Rendering at full quality…");
    try {
      const plan = renderPlan();
      const source = layer.kind === "synth" ? await renderSynthSource(layer, exportOversampling(), null) : await loadClip(layer.source);
      const solo = { ...project, layers: [{ ...layer, muted: false, solo: false }] };
      const samples = normalise(mixProject(solo, new Map([[layer.id, source]]), plan));
      const filename = `${slug(project.name)}-${slug(name)}.wav`;
      download(encodeWav(samples, sampleRate, plan.looping), filename);
      layerStatus(layer, `Exported ${filename}.`);
    } catch (error) {
      layerStatus(layer, `Export failed: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  } else if (action === "patch") {
    const patch = buildPatch(layer, renderSettings(exportOversampling()));
    download(new Blob([patch], { type: "text/plain" }), `${soundName(layer)}.ini`);
  } else if (action === "remove") {
    project.layers = project.layers.filter(candidate => candidate !== layer);
    previews.delete(layer.id);
    renderLayers();
    remix();
  }
}

function askName(suggestion) {
  const input = elements.dialog.querySelector("input");
  input.value = suggestion;
  elements.dialog.returnValue = "";
  elements.dialog.showModal();
  return new Promise(resolve => {
    elements.dialog.addEventListener("close", () => {
      resolve(elements.dialog.returnValue === "save" ? input.value.trim() || null : null);
    }, { once: true });
  });
}

function download(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

async function exportWav() {
  if (!project.layers.length) {
    setStatus("Add a sound before exporting.");
    return;
  }
  elements.exportButton.disabled = true;
  try {
    const oversampling = exportOversampling();
    const sources = new Map();
    const plan = renderPlan();
    for (const layer of project.layers) {
      if (layer.kind === "synth") {
        setStatus(`Rendering ${templateById(layer.template).name} at full quality…`);
        sources.set(layer.id, await renderSynthSource(layer, oversampling, null));
      } else {
        sources.set(layer.id, await loadClip(layer.source));
      }
    }
    const samples = normalise(mixProject(project, sources, plan));
    const filename = `${slug(project.name)}.wav`;
    download(encodeWav(samples, sampleRate, plan.looping), filename);
    const kind = !plan.looping ? "one-shot" : plan.crossfade ? "crossfaded loop with loop points" : "seamless loop with loop points";
    setStatus(`Exported ${filename}: ${project.length.toFixed(1)} s, ${kind}.`);
  } catch (error) {
    setStatus(`Export failed: ${error.message}`);
  } finally {
    elements.exportButton.disabled = false;
  }
}

function syncForm() {
  elements.name.value = project.name;
  showName();
  elements.length.value = project.length;
  elements.fadeIn.value = project.fadeIn;
  elements.fadeOut.value = project.fadeOut;
  [elements.length.min, elements.length.max] = lengthRange;
  elements.loopPlayback.checked = project.loop;
  elements.fadeIn.closest("label").hidden = project.loop;
  elements.fadeOut.closest("label").hidden = project.loop;
}

function setLength(value) {
  const [minimum, maximum] = lengthRange;
  project.length = Math.round(Math.min(maximum, Math.max(minimum, Number(value) || minimum)) * 10) / 10;
  elements.length.value = project.length;
}

function stopPlayback() {
  player.stop();
}

function openProject(saved) {
  stopPlayback();
  Object.assign(project, emptyProject(), structuredClone(saved));
  delete project.mode;
  for (const layer of project.layers) {
    layer.id = nextLayerId++;
  }
  previews.clear();
  mixed = null;
  syncForm();
  renderLayers();
  scheduleRender(0);
}

function projectSnapshot() {
  return structuredClone({
    name: project.name,
    length: project.length,
    loop: project.loop,
    fadeIn: project.fadeIn,
    fadeOut: project.fadeOut,
    layers: project.layers,
  });
}

function icon(name) {
  const symbol = document.createElement("span");
  symbol.dataset.icon = "";
  symbol.setAttribute("aria-hidden", "true");
  symbol.textContent = name;
  return symbol;
}

let previewing = null;

function stopPreview() {
  if (!previewing) {
    return;
  }
  const { button, node } = previewing;
  previewing = null;
  node?.stop();
  button.setAttribute("aria-pressed", "false");
  button.querySelector("[data-icon]").textContent = "play_arrow";
}

async function togglePreview(button, source) {
  const same = previewing?.button === button;
  stopPreview();
  if (same) {
    return;
  }
  previewing = { button };
  button.setAttribute("aria-pressed", "true");
  button.querySelector("[data-icon]").textContent = "stop";
  try {
    const clip = await loadClip(source);
    if (previewing?.button !== button) {
      return;
    }
    const context = player.ensureContext();
    await context.resume();
    const buffer = context.createBuffer(1, clip.wet.length, sampleRate);
    buffer.copyToChannel(clip.wet, 0);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(player.analyser);
    node.addEventListener("ended", () => {
      if (previewing?.node === node) {
        stopPreview();
      }
    });
    node.start();
    previewing.node = node;
  } catch (error) {
    stopPreview();
    setStatus(`Preview failed: ${error.message}`);
  }
}

function paletteItem(title, description, actions) {
  const item = document.createElement("li");
  const heading = document.createElement("h4");
  heading.textContent = title;
  item.append(heading);
  if (description) {
    const text = document.createElement("p");
    text.textContent = description;
    item.append(text);
  }
  const menu = document.createElement("menu");
  for (const [label, handler, adds, symbol] of actions) {
    const entry = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    if (symbol) {
      button.append(icon(symbol));
      button.title = label;
    } else {
      button.textContent = label;
    }
    button.setAttribute("aria-label", `${label}: ${title}`);
    if (symbol === "play_arrow") {
      button.setAttribute("aria-pressed", "false");
    }
    if (adds) {
      button.dataset.add = "";
      button.disabled = project.layers.length >= maximumLayers;
    }
    button.addEventListener("click", () => handler(button));
    entry.append(button);
    menu.append(entry);
  }
  item.append(menu);
  return item;
}

function paletteGroup(title, items, open) {
  const group = document.createElement("li");
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const list = document.createElement("ul");
  list.append(...items);
  details.append(summary, list);
  group.append(details);
  return group;
}

function buildTemplatePalette() {
  const groups = new Map();
  for (const template of templates) {
    if (!groups.has(template.group)) {
      groups.set(template.group, []);
    }
    groups.get(template.group).push(paletteItem(template.name, template.description, [["Add", () => addSynthLayer(template.id), true, "add"]]));
  }
  [...groups].forEach(([title, items], index) => elements.templateGroups.append(paletteGroup(title, items, index === 0)));
}

async function buildClipPalette() {
  try {
    const response = await fetch("../sounds/sounds.json");
    const sounds = await response.json();
    const groups = new Map();
    for (const sound of sounds) {
      if (!groups.has(sound.group)) {
        groups.set(sound.group, []);
      }
      const name = prettyName(sound.name.replace(/^clip_/, ""));
      const source = { type: "gallery", file: sound.name };
      groups.get(sound.group).push(paletteItem(name, sound.description, [
        ["Preview", button => togglePreview(button, source), false, "play_arrow"],
        ["Add", () => addClipLayer(source, name), true, "add"],
      ]));
    }
    const order = Object.keys(clipGroupTitles).concat([...groups.keys()]);
    for (const group of new Set(order)) {
      if (groups.has(group)) {
        elements.clipGroups.append(paletteGroup(clipGroupTitles[group] ?? group, groups.get(group), group === "clips"));
      }
    }
  } catch {
    const item = document.createElement("li");
    item.textContent = "Clips could not be loaded.";
    elements.clipGroups.append(item);
  }
}

async function refreshSaved() {
  try {
    const sounds = await listRecords("sounds");
    elements.savedSounds.replaceChildren(...sounds.map(record => {
      const template = templateById(record.template);
      const description = `${template?.name ?? record.template}, ${record.length.toFixed(1)} s`;
      return paletteItem(record.name, description, [
        ["Preview", button => togglePreview(button, { type: "saved", id: record.id }), false, "play_arrow"],
        ["Add as layer", () => addSynthLayer(record.template, record), true, "layers"],
        ["Add as clip", () => addClipLayer({ type: "saved", id: record.id }, record.name), true, "music_note"],
        ["Delete", async () => {
          if (confirm(`Delete ${record.name}?`)) {
            await deleteRecord("sounds", record.id);
            clipSources.delete(`saved:${record.id}`);
            refreshSaved();
          }
        }, false, "delete"],
      ]);
    }));
    if (!sounds.length) {
      const item = document.createElement("li");
      item.textContent = "Saved sounds appear here.";
      elements.savedSounds.append(item);
    }

    const projects = await listRecords("projects");
    elements.savedProjects.replaceChildren(...projects.map(record => paletteItem(
      record.name,
      `${record.project.layers.length} layers, ${record.project.length.toFixed(1)} s`,
      [
        ["Open", () => openProject(record.project), false, "folder_open"],
        ["Delete", async () => {
          if (confirm(`Delete ${record.name}?`)) {
            await deleteRecord("projects", record.id);
            refreshSaved();
          }
        }, false, "delete"],
      ],
    )));
    if (!projects.length) {
      const item = document.createElement("li");
      item.textContent = "Saved projects appear here.";
      elements.savedProjects.append(item);
    }
  } catch {
    const item = document.createElement("li");
    item.textContent = "Saving is unavailable in this browser.";
    elements.savedSounds.replaceChildren(item);
  }
}

function frame() {
  const playing = player.playing;
  drawSpectrum(elements.spectrum, playing ? player.analyser : null, colours);
  drawWaveform(elements.waveform, playing ? player.analyser : null, colours);
  const position = playing && player.buffer ? player.position / player.buffer.duration : 0;
  elements.body.style.setProperty("--position", position);
  elements.position.textContent = `${(position * project.length).toFixed(1)} / ${project.length.toFixed(1)} s`;
  if (playing) {
    const time = automationTime();
    for (const view of views.values()) {
      for (const field of view.fields) {
        const nodes = view.layer.automation[field.control.id];
        if (nodes) {
          showAutomatedValue(field, nodes, time);
        }
      }
    }
  }
  elements.body.toggleAttribute("data-playing", playing);
  requestAnimationFrame(frame);
}

elements.form.addEventListener("submit", event => event.preventDefault());
function showName() {
  elements.heading.textContent = project.name;
}

function editName(editing) {
  elements.heading.hidden = editing;
  elements.rename.hidden = editing;
  elements.name.hidden = !editing;
  if (editing) {
    elements.name.value = project.name;
    elements.name.focus();
    elements.name.select();
  } else {
    elements.rename.focus();
  }
}

elements.rename.addEventListener("click", () => editName(true));
function commitName() {
  if (elements.name.hidden) {
    return;
  }
  project.name = elements.name.value.trim() || "Untitled";
  showName();
  editName(false);
  persist();
}

elements.name.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    commitName();
  } else if (event.key === "Escape") {
    elements.name.value = project.name;
    commitName();
  }
});
elements.name.addEventListener("blur", commitName);
elements.form.addEventListener("change", event => {
  const target = event.target;
  if (target === elements.length) {
    setLength(target.value);
    renderLayers();
    scheduleRender(0);
  } else if (target === elements.fadeIn || target === elements.fadeOut) {
    project.fadeIn = Math.max(0, Number(elements.fadeIn.value) || 0);
    project.fadeOut = Math.max(0, Number(elements.fadeOut.value) || 0);
    remix();
  }
});
elements.loopPlayback.addEventListener("change", () => {
  project.loop = elements.loopPlayback.checked;
  syncForm();
  renderLayers();
  scheduleRender(0);
});
elements.play.addEventListener("click", async () => {
  if (player.playing) {
    player.stop();
    return;
  }
  if (!mixed) {
    await renderPreviews();
  }
  if (mixed) {
    await player.play();
    elements.play.setAttribute("aria-pressed", "true");
    elements.play.textContent = "Stop";
  }
});
player.addEventListener("stopped", () => {
  elements.play.setAttribute("aria-pressed", "false");
  elements.play.textContent = "Play";
});
elements.exportButton.addEventListener("click", exportWav);
elements.saveProject.addEventListener("click", async () => {
  const name = await askName(project.name);
  if (name) {
    project.name = name;
    elements.name.value = name;
    showName();
    await saveRecord("projects", { name, project: projectSnapshot(), created: Date.now() });
    setStatus(`Saved ${name} to My projects.`);
    refreshSaved();
  }
});
elements.newProject.addEventListener("click", () => {
  if (!project.layers.length || confirm("Start a new project? Unsaved changes will be lost.")) {
    openProject(emptyProject());
  }
});
new ResizeObserver(() => {
  if (mixed) {
    drawOverview(elements.overviewCanvas, mixed, colours);
  }
}).observe(elements.overviewCanvas);

const restored = restoredProject();
if (restored) {
  openProject(restored);
} else {
  syncForm();
  renderLayers();
}
buildTemplatePalette();
buildClipPalette();
refreshSaved();
requestAnimationFrame(frame);
