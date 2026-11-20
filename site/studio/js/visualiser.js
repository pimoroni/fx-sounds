function prepare(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  return { context, width, height, ratio };
}

export function themeColours(element) {
  const style = getComputedStyle(element);
  return {
    trace: style.getPropertyValue("--trace").trim() || "#c8322b",
    line: style.getPropertyValue("--line").trim() || "#888888",
    muted: style.getPropertyValue("--muted").trim() || "#888888",
  };
}

const spectrumData = new Map();

export function drawSpectrum(canvas, analyser, colours) {
  const { context, width, height, ratio } = prepare(canvas);
  context.strokeStyle = colours.line;
  context.lineWidth = ratio;
  for (const frequency of [100, 1000, 10000]) {
    const x = (Math.log(frequency / 30) / Math.log(16000 / 30)) * width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  if (!analyser) {
    return;
  }
  let data = spectrumData.get(analyser);
  if (!data) {
    data = new Float32Array(analyser.frequencyBinCount);
    spectrumData.set(analyser, data);
  }
  analyser.getFloatFrequencyData(data);
  const binWidth = analyser.context.sampleRate / analyser.fftSize;
  context.beginPath();
  for (let x = 0; x <= width; x += ratio) {
    const frequency = 30 * Math.pow(16000 / 30, x / width);
    const bin = Math.min(data.length - 1, Math.round(frequency / binWidth));
    const level = Math.max(0, Math.min(1, (data[bin] + 100) / 80));
    const y = height - level * height;
    if (x === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  context.fillStyle = colours.trace;
  context.globalAlpha = 0.35;
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = colours.trace;
  context.lineWidth = 1.5 * ratio;
  context.stroke();
}

const waveformData = new Map();

export function drawWaveform(canvas, analyser, colours) {
  const { context, width, height, ratio } = prepare(canvas);
  context.strokeStyle = colours.line;
  context.lineWidth = ratio;
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
  if (!analyser) {
    return;
  }
  let data = waveformData.get(analyser);
  if (!data) {
    data = new Float32Array(analyser.fftSize);
    waveformData.set(analyser, data);
  }
  analyser.getFloatTimeDomainData(data);
  context.beginPath();
  for (let index = 0; index < data.length; index++) {
    const x = (index / (data.length - 1)) * width;
    const y = height / 2 - data[index] * (height / 2) * 0.95;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.strokeStyle = colours.trace;
  context.lineWidth = 1.5 * ratio;
  context.stroke();
}

export function drawOverview(canvas, samples, colours) {
  const { context, width, height } = prepare(canvas);
  if (!samples || samples.length === 0) {
    return;
  }
  context.fillStyle = colours.trace;
  const middle = height / 2;
  for (let x = 0; x < width; x++) {
    const start = Math.floor((x / width) * samples.length);
    const end = Math.max(start + 1, Math.floor(((x + 1) / width) * samples.length));
    let low = 0;
    let high = 0;
    for (let index = start; index < end; index++) {
      low = Math.min(low, samples[index]);
      high = Math.max(high, samples[index]);
    }
    context.fillRect(x, middle - high * middle, 1, Math.max(1, (high - low) * middle));
  }
}
