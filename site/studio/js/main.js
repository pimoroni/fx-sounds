import { templates, templateById, mixerControls } from "./templates.js";
import { buildPatch, controlValues, soundName, automationAt, loopsCleanly, nodeCount } from "./patch.js";
import { renderPatch } from "./engine.js";
import { mixProject, sampleRate, limit, normalise } from "./mixer.js";
import { Player } from "./player.js";
import { drawSpectrum, drawWaveform, drawOverview, themeColours } from "./visualiser.js";
import { createAutomationEditor, createClipEditor } from "./timeline.js";
import { saveRecord, listRecords, getRecord, deleteRecord } from "./store.js";
import { encodeWav } from "./wav.js";

const maximumLayers = 4;
const lengthLimits = { loop: [0.5, 30], evolve: [5, 120] };
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
  return { name: "Untitled", mode: "loop", length: 8, loop: true, fadeIn: 0, fadeOut: 0, layers: [] };
}

function evolving() {
  return project.mode === "evolve";
}

function previewOversampling() {
  return project.length <= 30 ? 2 : 1;
}

function exportOversampling() {
  return project.length <= 30 ? 8 : project.length <= 60 ? 4 : 2;
}

function renderPlan() {
  const timeline = project.length;
  if (!evolving()) {
    return { evolving: false, looping: true, timeline, length: timeline, crossfade: 0 };
  }
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
    ? "evolving one-shot"
    : plan.crossfade
      ? `evolving loop, crossfaded over ${plan.crossfade.toFixed(1)} s because some curves end differently from how they start`
      : plan.evolving ? "evolving seamless loop" : "seamless loop";
  setStatus(`${count} ${count === 1 ? "layer" : "layers"}, ${project.length.toFixed(1)} s ${mode}.`);
}

function mixerDefaults() {
  return Object.fromEntries(mixerControls.map(control => [control.id, control.value]));
}

function automatableControls(layer) {
  const own = layer.kind === "synth"
    ? templateById(layer.template).controls.filter(control => control.automatable !== false)
    : [];
  return [...own, ...mixerControls];
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

async function fetchClip(source) {
  if (source.type === "gallery") {
    const [dry, wet] = await Promise.all(["dry", "wet"].map(async mix => {
      const response = await fetch(`../sounds/${source.file}_${mix}.wav`);
      if (!response.ok) {
        throw new Error(`Could not load ${source.file}`);
      }
      return player.decode(await response.arrayBuffer());
    }));
    return { dry, wet };
  }
  const record = await getRecord("sounds", source.id);
  if (!record) {
    throw new Error("That saved sound no longer exists");
  }
  const patch = buildPatch(layerFromRecord(record), { length: record.length, oversampling: 4, evolving: record.mode === "evolve" });
  const [sound] = await renderPatch(patch);
  return { dry: sound.dry, wet: sound.wet };
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
  const clipLength = clip.dry.length / sampleRate;
  views.get(layer.id)?.clipEditor?.update({ clipLength, length: project.length });
  layerStatus(layer, `${clipLength.toFixed(2)} s clip`);
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
  mixed = limit(mixProject(project, previews, plan));
  player.setSamples(mixed, plan.looping);
  drawOverview(elements.overviewCanvas, mixed, colours);
  idleStatus();
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
    toggle.textContent = "Automate";
    toggle.dataset.evolve = "";
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
  if (layer.automation[control.id]) {
    delete layer.automation[control.id];
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
    const nodes = evolving() ? view.layer.automation[field.control.id] : null;
    field.input.disabled = Boolean(nodes);
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
    view.clipEditor = createClipEditor({
      name: layer.name,
      hits: layer.hits,
      clipLength: preview ? preview.dry.length / sampleRate : 1,
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
  for (const control of mixerControls) {
    const field = controlField(view, control, () => {
      scheduleRemix();
      if (layer.focus === control.id && !layer.automation[control.id]) {
        buildAutomation(view);
      }
    });
    view.fields.push(field);
    mixList.append(field.item);
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
        mode: project.mode,
        length: project.length,
        created: Date.now(),
      });
      setStatus(`Saved ${name} to My sounds.`);
      refreshSaved();
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
  elements.length.value = project.length;
  elements.fadeIn.value = project.fadeIn;
  elements.fadeOut.value = project.fadeOut;
  const [minimum, maximum] = lengthLimits[project.mode];
  elements.length.min = minimum;
  elements.length.max = maximum;
  elements.form.elements.mode.value = project.mode;
  elements.loopPlayback.checked = project.loop;
  elements.fadeIn.disabled = project.loop;
  elements.fadeOut.disabled = project.loop;
  elements.body.dataset.mode = project.mode;
}

function setLength(value) {
  const [minimum, maximum] = lengthLimits[project.mode];
  project.length = Math.round(Math.min(maximum, Math.max(minimum, Number(value) || minimum)) * 10) / 10;
  elements.length.value = project.length;
}

function stopPlayback() {
  player.stop();
}

function openProject(saved) {
  stopPlayback();
  Object.assign(project, emptyProject(), structuredClone(saved));
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
    mode: project.mode,
    length: project.length,
    loop: project.loop,
    fadeIn: project.fadeIn,
    fadeOut: project.fadeOut,
    layers: project.layers,
  });
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
  for (const [label, handler, adds] of actions) {
    const entry = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", `${label}: ${title}`);
    if (adds) {
      button.dataset.add = "";
      button.disabled = project.layers.length >= maximumLayers;
    }
    button.addEventListener("click", handler);
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
    groups.get(template.group).push(paletteItem(template.name, template.description, [["Add", () => addSynthLayer(template.id), true]]));
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
      groups.get(sound.group).push(paletteItem(name, sound.description, [
        ["Add", () => addClipLayer({ type: "gallery", file: sound.name }, name), true],
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
      const description = `${template?.name ?? record.template}, ${record.mode === "evolve" ? "evolving" : "loop"}, ${record.length.toFixed(1)} s`;
      return paletteItem(record.name, description, [
        ["Add as layer", () => addSynthLayer(record.template, record), true],
        ["Add as clip", () => addClipLayer({ type: "saved", id: record.id }, record.name), true],
        ["Delete", async () => {
          if (confirm(`Delete ${record.name}?`)) {
            await deleteRecord("sounds", record.id);
            clipSources.delete(`saved:${record.id}`);
            refreshSaved();
          }
        }],
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
        ["Open", () => openProject(record.project)],
        ["Delete", async () => {
          if (confirm(`Delete ${record.name}?`)) {
            await deleteRecord("projects", record.id);
            refreshSaved();
          }
        }],
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
  if (evolving() && playing) {
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
elements.name.addEventListener("input", () => {
  project.name = elements.name.value;
  persist();
});
elements.form.addEventListener("change", event => {
  const target = event.target;
  if (target.name === "mode") {
    project.mode = target.value;
    syncForm();
    setLength(project.length);
    renderLayers();
    scheduleRender(0);
  } else if (target === elements.length) {
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
