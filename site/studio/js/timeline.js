import { nodeCount } from "./patch.js";

const svgNamespace = "http://www.w3.org/2000/svg";

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function observeSize(svg, draw) {
  const observer = new ResizeObserver(() => draw());
  observer.observe(svg);
  return observer;
}

function formatTime(seconds) {
  return `${seconds.toFixed(1)} s`;
}

export function createAutomationEditor({ label, nodes, baseline, length, format, onInput, onCommit }) {
  const svg = svgElement("svg", { role: "group", "aria-label": `${label} over time` });
  const grid = svgElement("g", { "aria-hidden": "true" });
  const area = svgElement("path", { "aria-hidden": "true", "data-part": "area" });
  const line = svgElement("path", { "aria-hidden": "true", "data-part": "line" });
  const wrap = svgElement("path", { "aria-hidden": "true", "data-part": "wrap" });
  svg.append(grid, area, line, wrap);

  let values = nodes ? nodes.slice() : Array(nodeCount).fill(baseline);
  let size = { width: 1, height: 1 };
  const padding = 10;
  const handles = values.map((_, index) => {
    const handle = svgElement("circle", {
      r: 6,
      tabindex: 0,
      role: "slider",
      "aria-valuemin": 0,
      "aria-valuemax": 100,
    });
    handle.addEventListener("keydown", event => {
      const steps = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 };
      if (event.key in steps) {
        setValue(index, values[index] + steps[event.key]);
      } else if (event.key === "Home") {
        setValue(index, 0);
      } else if (event.key === "End") {
        setValue(index, 1);
      } else {
        return;
      }
      event.preventDefault();
      onCommit(values.slice());
    });
    svg.append(handle);
    return handle;
  });

  const xFor = index => (index / nodeCount) * size.width;
  const yFor = value => padding + (1 - value) * (size.height - padding * 2);

  function draw() {
    size = { width: svg.clientWidth || 1, height: svg.clientHeight || 1 };
    svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    grid.replaceChildren();
    for (let index = 0; index <= nodeCount; index += 4) {
      grid.append(svgElement("line", { x1: xFor(index), x2: xFor(index), y1: 0, y2: size.height }));
    }
    const points = values.map((value, index) => `${xFor(index)},${yFor(value)}`);
    line.setAttribute("d", `M${points.join(" L")}`);
    const last = yFor(values[values.length - 1]);
    area.setAttribute("d", `M0,${size.height} L${points.join(" L")} L${size.width},${last} L${size.width},${size.height} Z`);
    wrap.setAttribute("d", `M${points[points.length - 1]} L${size.width},${last}`);
    handles.forEach((handle, index) => {
      handle.setAttribute("cx", xFor(index));
      handle.setAttribute("cy", yFor(values[index]));
      const time = (index * length) / nodeCount;
      handle.setAttribute("aria-label", `${label} at ${formatTime(time)}`);
      handle.setAttribute("aria-valuenow", Math.round(values[index] * 100));
      handle.setAttribute("aria-valuetext", format(values[index]));
    });
  }

  function setValue(index, value) {
    values[index] = Math.max(0, Math.min(1, value));
    draw();
    onInput(values.slice());
  }

  let dragging = false;
  const valueFromPointer = event => {
    const bounds = svg.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const index = Math.max(0, Math.min(nodeCount - 1, Math.round((x / bounds.width) * nodeCount)));
    const value = 1 - (y - padding) / (bounds.height - padding * 2);
    setValue(index, value);
    handles[index].focus({ preventScroll: true });
  };
  svg.addEventListener("pointerdown", event => {
    dragging = true;
    svg.setPointerCapture(event.pointerId);
    valueFromPointer(event);
    event.preventDefault();
  });
  svg.addEventListener("pointermove", event => {
    if (dragging) {
      valueFromPointer(event);
    }
  });
  const finish = () => {
    if (dragging) {
      dragging = false;
      onCommit(values.slice());
    }
  };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", finish);

  observeSize(svg, draw);
  return svg;
}

export function createClipEditor({ name, hits, clipLength, length, looping, wrapping, onChange }) {
  const svg = svgElement("svg", { role: "group", "aria-label": `${name} placements` });
  let placements = hits.slice();
  let size = { width: 1, height: 1 };
  let drag = null;

  const snap = time => Math.max(0, Math.min(length - 0.05, Math.round(time * 20) / 20));
  const timeFromPointer = event => {
    const bounds = svg.getBoundingClientRect();
    return snap(((event.clientX - bounds.left) / bounds.width) * length);
  };

  function draw() {
    size = { width: svg.clientWidth || 1, height: svg.clientHeight || 1 };
    svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    svg.replaceChildren();
    const width = Math.max(4, (clipLength / length) * size.width);
    const starts = looping && placements.length ? [] : placements;
    if (looping && placements.length) {
      const first = placements[0];
      for (let start = first; start < length; start += clipLength) {
        starts.push(start);
      }
      if (wrapping) {
        for (let start = first - clipLength; start + clipLength > 0; start -= clipLength) {
          starts.push(start);
        }
      }
    }
    starts.forEach((start, order) => {
      const primary = !looping || order === 0;
      const x = (start / length) * size.width;
      const block = svgElement("rect", { x, y: 6, width, height: size.height - 12, rx: 4 });
      if (wrapping && x + width > size.width) {
        svg.append(svgElement("rect", { x: x - size.width, y: 6, width, height: size.height - 12, rx: 4, "aria-hidden": "true" }));
      }
      if (!primary) {
        block.setAttribute("aria-hidden", "true");
        block.setAttribute("data-part", "repeat");
        svg.append(block);
        return;
      }
      const index = placements.indexOf(start);
      block.setAttribute("tabindex", 0);
      block.setAttribute("data-index", index);
      block.setAttribute("role", "button");
      block.setAttribute("aria-label", `${name} at ${formatTime(start)}. Arrow keys move, Delete removes.`);
      block.addEventListener("pointerdown", event => {
        event.stopPropagation();
        drag = { index, offset: timeFromPointer(event) - placements[index] };
        svg.setPointerCapture(event.pointerId);
      });
      block.addEventListener("dblclick", () => remove(index));
      block.addEventListener("keydown", event => {
        const moves = { ArrowLeft: -0.1, ArrowRight: 0.1 };
        if (event.key in moves) {
          const moved = snap(placements[index] + moves[event.key] * (event.shiftKey ? 10 : 1));
          placements[index] = moved;
          changed();
          svg.querySelector(`rect[data-index="${placements.indexOf(moved)}"]`)?.focus();
        } else if (event.key === "Delete" || event.key === "Backspace") {
          remove(index);
        } else {
          return;
        }
        event.preventDefault();
      });
      svg.append(block);
    });
  }

  function changed() {
    placements.sort((first, second) => first - second);
    draw();
    onChange(placements.slice());
  }

  function remove(index) {
    placements.splice(index, 1);
    changed();
  }

  svg.addEventListener("pointerdown", event => {
    if (event.target !== svg) {
      return;
    }
    if (looping && placements.length) {
      placements = [timeFromPointer(event)];
    } else {
      placements.push(timeFromPointer(event));
    }
    changed();
  });
  svg.addEventListener("pointermove", event => {
    if (drag) {
      placements[drag.index] = snap(timeFromPointer(event) - drag.offset);
      draw();
    }
  });
  svg.addEventListener("pointerup", () => {
    if (drag) {
      drag = null;
      changed();
    }
  });

  observeSize(svg, draw);
  return {
    element: svg,
    update(options) {
      clipLength = options.clipLength ?? clipLength;
      length = options.length ?? length;
      draw();
    },
  };
}
