const range = (low, high) => value => low + (high - low) * value;
const exponential = (low, high) => value => low * Math.pow(high / low, value);

const percent = value => `${Math.round(value * 100)}%`;
const decibels = map => value => `${map(value).toFixed(0)} dB`;
const hertz = map => value => {
  const frequency = map(value);
  return frequency >= 1000 ? `${(frequency / 1000).toFixed(1)} kHz` : `${Math.round(frequency)} Hz`;
};
const seconds = map => value => `${map(value).toFixed(1)} s`;

function fittedPeriod(period, length) {
  return length / Math.max(1, Math.round(length / period));
}

function time(seconds) {
  return Number(seconds.toFixed(4));
}

function fittedCycles(length, periodAt) {
  const cycles = [];
  let start = 0;
  while (start < length - 1e-6) {
    const seconds = Math.max(0.02, periodAt(start));
    cycles.push([start, seconds]);
    start += seconds;
  }
  const [lastStart, lastSeconds] = cycles[cycles.length - 1];
  if (cycles.length > 1 && length - lastStart < lastSeconds / 2) {
    cycles.pop();
  }
  const total = cycles.reduce((sum, [, seconds]) => sum + seconds, 0);
  const scale = length / total;
  return cycles.map(([cycleStart, seconds]) => [cycleStart * scale, seconds * scale]);
}

function periodic(curve, points, period) {
  return context => {
    if (typeof period === "number" || !context.automated(period.control)) {
      const seconds = typeof period === "number" ? period : period.map(context.values[period.control]);
      const fitted = fittedPeriod(seconds, context.length);
      return `${curve} ` + points.map(([value, position]) => `${value}@${time(position * fitted)}`).join(" ");
    }
    const parts = [];
    for (const [start, seconds] of fittedCycles(context.length, at => period.map(context.valueAt(period.control, at)))) {
      for (const [value, position] of points.slice(0, -1)) {
        parts.push(`${value}@${time(start + position * seconds)}`);
      }
    }
    parts.push(`${points[0][0]}@${time(context.length)}`);
    return `${curve} ${parts.join(" ")}`;
  };
}

function cricketGate(pulses, period) {
  return context => {
    const fitted = fittedPeriod(period, context.length);
    const scale = fitted / period;
    const points = pulses.map(([value, time]) => `${value}@${(time * scale).toFixed(4)}`);
    return `step ${points.join(" ")} 0@${fitted.toFixed(4)}`;
  };
}

export const templates = [
  {
    id: "stream",
    name: "Stream",
    group: "Water",
    description: "Flowing water with bubbles and gurgles",
    sound: { reverb_wet: -10, reverb_flutter: 0.2 },
    voices: [
      { name: "main", keys: { wave: "none", noise: -16, noise_colour: "pink", highpass: 300, lowpass: 3000, peak_eq: "1800 3 0.8" } },
      { name: "low", keys: { wave: "none", noise: -16, noise_colour: "brown", highpass: 60, lowpass: 500, level: -10 } },
      {
        name: "moving",
        keys: {
          wave: "none", noise: -16, noise_colour: "pink", bandpass_q: 2, lowpass: 3500, level: -12,
          bandpass: periodic("smooth", [[1200, 0], [2200, 0.26], [1500, 0.58], [2600, 0.79], [1200, 1]], 8),
        },
      },
      { name: "bubbles", keys: { wave: "none", blips: "25 -15 600 2600 0.006 0.8", highpass: 400, lowpass: 4000 } },
      { name: "gurgle", keys: { wave: "none", blips: "6 -11 250 700 0.02 1.0", highpass: 150, lowpass: 2000 } },
    ],
    controls: [
      {
        id: "flow", label: "Flow", value: 0.5, format: decibels(range(-24, -8)),
        targets: ["main", "low", "moving"].map(voice => ({ voice, key: "noise", map: range(-24, -8) })),
      },
      {
        id: "bubbles", label: "Bubbles", value: 0.5, format: percent,
        targets: ["bubbles", "gurgle"].map(voice => ({ voice, key: "density", map: range(0, 2) })),
      },
      {
        id: "brightness", label: "Brightness", value: 0.4, format: hertz(exponential(1500, 7000)),
        targets: [
          { voice: "main", key: "lowpass", map: exponential(1500, 7000) },
          { voice: "moving", key: "lowpass", map: exponential(1800, 8000) },
        ],
      },
    ],
  },
  {
    id: "waterfall",
    name: "Waterfall",
    group: "Water",
    description: "Roaring falls with spray and splashes",
    sound: { reverb_time: 2.5, reverb_wet: -4 },
    voices: [
      { name: "main", keys: { wave: "none", noise: -4, noise_colour: "brown", lowpass: 1200 } },
      { name: "spray", keys: { wave: "none", noise: -14, noise_colour: "pink", highpass: 1500, lowpass: 9000 } },
      { name: "splash", keys: { wave: "none", blips: "200 -16 300 1200 0.008 1.0", highpass: 250 } },
    ],
    controls: [
      { id: "power", label: "Power", value: 0.8, format: decibels(range(-18, -2)), targets: [{ voice: "main", key: "noise", map: range(-18, -2) }] },
      { id: "spray", label: "Spray", value: 0.6, format: decibels(range(-30, -8)), targets: [{ voice: "spray", key: "noise", map: range(-30, -8) }] },
      { id: "splash", label: "Splash", value: 0.5, format: percent, targets: [{ voice: "splash", key: "density", map: range(0, 2) }] },
      {
        id: "brightness", label: "Brightness", value: 0.5, format: hertz(exponential(3000, 12000)),
        targets: [{ voice: "spray", key: "lowpass", map: exponential(3000, 12000) }],
      },
    ],
  },
  {
    id: "rain",
    name: "Rain",
    group: "Water",
    description: "Rainfall from drizzle to downpour",
    sound: { reverb_wet: -6 },
    voices: [
      { name: "main", keys: { wave: "none", noise: -10, noise_colour: "pink", highpass: 300, lowpass: 9000 } },
      { name: "drops", keys: { wave: "none", crackle: "250 -6 0.0004", highpass: 1500 } },
      { name: "patter", keys: { wave: "none", blips: "40 -14 1800 4500 0.004 0.8", highpass: 800 } },
    ],
    controls: [
      {
        id: "intensity", label: "Intensity", value: 0.5, format: percent,
        targets: [
          { voice: "drops", key: "density", map: range(0.1, 2.5) },
          { voice: "main", key: "noise", map: range(-26, -6) },
        ],
      },
      { id: "patter", label: "Patter", value: 0.4, format: percent, targets: [{ voice: "patter", key: "density", map: range(0, 2.5) }] },
      {
        id: "brightness", label: "Brightness", value: 0.6, format: hertz(exponential(2500, 12000)),
        targets: [{ voice: "main", key: "lowpass", map: exponential(2500, 12000) }],
      },
    ],
  },
  {
    id: "sea",
    name: "Sea",
    group: "Water",
    description: "Waves breaking and receding on a beach",
    sound: { reverb_wet: -10, reverb_flutter: 0.1 },
    voices: [
      {
        name: "main",
        keys: {
          wave: "none", noise: -4, noise_colour: "pink", bandpass_q: 0.7,
          gate: periodic("linear", [[0.15, 0], [1, 0.325], [0.4, 0.5625], [0.15, 1]], { control: "waves", map: range(4, 12) }),
          bandpass: periodic("smooth", [[400, 0], [2500, 0.325], [800, 0.625], [400, 1]], { control: "waves", map: range(4, 12) }),
        },
      },
      {
        name: "rumble",
        keys: {
          wave: "none", noise: -4, noise_colour: "brown", lowpass: 300, level: -4,
          gate: periodic("linear", [[0.3, 0], [0.4, 0.275], [1, 0.3625], [0.4, 0.6875], [0.3, 1]], { control: "waves", map: range(4, 12) }),
        },
      },
      {
        name: "foam",
        keys: {
          wave: "none", crackle: "300 -20 0.0004", highpass: 3000,
          gate: periodic("linear", [[0, 0], [0, 0.325], [1, 0.4], [0, 0.75], [0, 1]], { control: "waves", map: range(4, 12) }),
        },
      },
    ],
    controls: [
      { id: "waves", label: "Wave length", value: 0.5, format: seconds(range(4, 12)), targets: [] },
      { id: "surf", label: "Surf", value: 0.5, format: percent, targets: [{ voice: "foam", key: "density", map: range(0, 2.5) }] },
      { id: "rumble", label: "Rumble", value: 0.6, format: decibels(range(-24, 0)), targets: [{ voice: "rumble", key: "level", map: range(-24, 0) }] },
    ],
  },
  {
    id: "wind",
    name: "Wind",
    group: "Air",
    description: "Gusting, whistling wind with blown sand",
    sound: { reverb_wet: -12, reverb_flutter: 0.1 },
    voices: [
      {
        name: "main",
        keys: {
          wave: "none", noise: -2, noise_colour: "pink",
          bandpass: periodic("smooth", [[320, 0], [650, 0.26], [420, 0.44], [900, 0.71], [320, 1]], { control: "gusts", map: exponential(20, 5) }),
          gate: periodic("linear", [[0.4, 0], [0.9, 0.26], [0.6, 0.44], [1, 0.71], [0.4, 1]], { control: "gusts", map: exponential(20, 5) }),
        },
      },
      {
        name: "rumble",
        keys: {
          wave: "none", noise: -4, noise_colour: "brown", lowpass: 250,
          gate: periodic("linear", [[0.7, 0], [1, 0.35], [0.8, 0.65], [0.7, 1]], { control: "gusts", map: exponential(20, 5) }),
        },
      },
      { name: "sand", keys: { wave: "none", crackle: "400 -24 0.0003", highpass: 4000 } },
    ],
    controls: [
      {
        id: "strength", label: "Strength", value: 0.7, format: percent,
        targets: [
          { voice: "main", key: "level", map: range(-14, 0) },
          { voice: "rumble", key: "level", map: range(-24, -6) },
        ],
      },
      { id: "whistle", label: "Whistle", value: 0.7, format: percent, targets: [{ voice: "main", key: "bandpass_q", map: exponential(1.5, 20) }] },
      { id: "gusts", label: "Gust speed", value: 0.5, format: percent, targets: [] },
      { id: "sand", label: "Sand", value: 0.4, format: percent, targets: [{ voice: "sand", key: "density", map: range(0, 2.5) }] },
    ],
  },
  {
    id: "atmosphere",
    name: "Atmosphere",
    group: "Air",
    description: "Underground facility drone with vents and distant clanks",
    sound: { reverb_time: 3.5, reverb_width: 40, reverb_wet: -1 },
    voices: [
      {
        name: "main",
        keys: {
          wave: "saw", pitch: 41.2, bandpass_q: 2.5, level: -2,
          bandpass: periodic("smooth", [[180, 0], [520, 0.5], [180, 1]], { control: "sweep", map: exponential(16, 3) }),
        },
      },
      {
        name: "beat",
        keys: {
          wave: "saw", pitch: 41.2, pitch_scale: 1.0052, bandpass_q: 2.5, level: -2,
          bandpass: periodic("smooth", [[180, 0], [520, 0.5], [180, 1]], { control: "sweep", map: exponential(16, 3) }),
        },
      },
      { name: "hum", keys: { wave: "saw", pitch: 60, lowpass: 300, level: -14 } },
      { name: "vent", keys: { wave: "none", noise: -12, noise_colour: "pink", bandpass: 900, bandpass_q: 1.2, level: -14 } },
      { name: "clanks", keys: { wave: "none", blips: "0.6 -2 70 160 0.35 -0.4", lowpass: 1500 } },
      { name: "pings", keys: { wave: "none", blips: "0.4 -12 900 2400 0.7 0" } },
    ],
    controls: [
      {
        id: "drone", label: "Drone", value: 0.8, format: decibels(range(-20, 0)),
        targets: ["main", "beat"].map(voice => ({ voice, key: "level", map: range(-20, 0) })),
      },
      {
        id: "pitch", label: "Pitch", value: 0.4, format: hertz(exponential(30, 65)),
        targets: ["main", "beat"].map(voice => ({ voice, key: "pitch", map: exponential(30, 65) })),
      },
      { id: "vents", label: "Vents", value: 0.6, format: decibels(range(-30, -4)), targets: [{ voice: "vent", key: "level", map: range(-30, -4) }] },
      {
        id: "clanks", label: "Clanks", value: 0.3, format: percent,
        targets: ["clanks", "pings"].map(voice => ({ voice, key: "density", map: range(0, 3) })),
      },
      { id: "sweep", label: "Sweep speed", value: 0.4, format: percent, targets: [] },
    ],
  },
  {
    id: "space",
    name: "Spaceship",
    group: "Air",
    description: "Starship engine drone",
    sound: { reverb_time: 2.5 },
    voices: [
      { name: "main", keys: { wave: "saw", pitch: 55, lowpass: 400, level: -2 } },
      { name: "detuned", keys: { wave: "saw", pitch: 55, pitch_scale: 1.0035, lowpass: 400, level: -2 } },
      { name: "hum", keys: { wave: "sine", pitch: 110, vibrato: "0.1 0.25", level: -8 } },
      { name: "air", keys: { wave: "none", noise: -16, noise_colour: "pink", highpass: 300, lowpass: 2500 } },
    ],
    controls: [
      {
        id: "pitch", label: "Pitch", value: 0.45, format: hertz(exponential(35, 90)),
        targets: [
          { voice: "main", key: "pitch", map: exponential(35, 90) },
          { voice: "detuned", key: "pitch", map: exponential(35, 90) },
          { voice: "hum", key: "pitch", map: exponential(70, 180) },
        ],
      },
      { id: "air", label: "Air", value: 0.5, format: decibels(range(-30, 0)), targets: [{ voice: "air", key: "level", map: range(-30, 0) }] },
      {
        id: "brightness", label: "Brightness", value: 0.35, format: hertz(exponential(200, 2000)),
        targets: ["main", "detuned"].map(voice => ({ voice, key: "lowpass", map: exponential(200, 2000) })),
      },
    ],
  },
  {
    id: "traffic",
    name: "Traffic",
    group: "Places",
    description: "Distant city traffic with passing cars and the odd horn",
    sound: { reverb_width: 20, reverb_time: 1.6, reverb_wet: -3 },
    voices: [
      { name: "main", keys: { wave: "none", noise: -4, noise_colour: "brown", lowpass: 400 } },
      {
        name: "cars",
        keys: {
          wave: "none", noise: -4, noise_colour: "pink", bandpass_q: 1.5,
          gate: periodic("linear", [[0.1, 0], [1, 0.1667], [0.1, 0.3333], [0.1, 1]], { control: "passes", map: exponential(24, 6) }),
          bandpass: periodic("linear", [[1000, 0], [1000, 0.15], [550, 0.1917], [550, 0.9917], [1000, 1]], { control: "passes", map: exponential(24, 6) }),
        },
      },
      {
        name: "cars2",
        keys: {
          wave: "none", noise: -4, noise_colour: "pink", bandpass_q: 1.5,
          gate: periodic("linear", [[0.1, 0], [0.1, 0.5], [1, 0.7083], [0.1, 0.875], [0.1, 1]], { control: "passes", map: exponential(24, 6) }),
          bandpass: periodic("linear", [[850, 0], [850, 0.6917], [480, 0.7333], [480, 0.9917], [850, 1]], { control: "passes", map: exponential(24, 6) }),
        },
      },
      {
        name: "horn",
        keys: {
          wave: "square", pitch: 420, highpass: 300, lowpass: 2500,
          gate: periodic("step", [[0, 0], [1, 0.625], [0, 0.65], [0, 1]], 12),
        },
      },
      {
        name: "horn2",
        keys: {
          wave: "square", pitch: 525, highpass: 300, lowpass: 2500,
          gate: periodic("step", [[0, 0], [1, 0.625], [0, 0.65], [0, 1]], 12),
        },
      },
    ],
    controls: [
      { id: "rumble", label: "Rumble", value: 0.8, format: decibels(range(-18, 0)), targets: [{ voice: "main", key: "level", map: range(-18, 0) }] },
      {
        id: "cars", label: "Cars", value: 0.8, format: percent,
        targets: [
          { voice: "cars", key: "level", map: range(-26, 0) },
          { voice: "cars2", key: "level", map: range(-28, -2) },
        ],
      },
      { id: "passes", label: "Pass rate", value: 0.5, format: percent, targets: [] },
      {
        id: "horns", label: "Horns", value: 0.4, format: percent,
        targets: ["horn", "horn2"].map(voice => ({ voice, key: "level", map: range(-60, -12) })),
      },
    ],
  },
  {
    id: "cafe",
    name: "Cafe",
    group: "Places",
    description: "Unintelligible chatter, cups and a busy room",
    sound: { reverb_time: 0.9, reverb_width: 8, reverb_flutter: 0.2, reverb_wet: -2 },
    voices: [
      { name: "main", keys: { wave: "none", babble: "28 0", highpass: 120, lowpass: 3500 } },
      { name: "clinks", keys: { wave: "none", blips: "0.75 -16 2600 5200 0.09 0", highpass: 1500 } },
      { name: "room", keys: { wave: "none", noise: -32, noise_colour: "pink", lowpass: 1200 } },
    ],
    controls: [
      { id: "chatter", label: "Chatter", value: 0.5, format: percent, targets: [{ voice: "main", key: "density", map: range(0.2, 2.5) }] },
      { id: "clinks", label: "Clinks", value: 0.3, format: percent, targets: [{ voice: "clinks", key: "density", map: range(0, 4) }] },
      { id: "room", label: "Room noise", value: 0.5, format: decibels(range(-44, -20)), targets: [{ voice: "room", key: "noise", map: range(-44, -20) }] },
      {
        id: "muffle", label: "Muffle", value: 0.3, format: hertz(exponential(5000, 1000)),
        targets: [{ voice: "main", key: "lowpass", map: exponential(5000, 1000) }],
      },
    ],
  },
  {
    id: "crickets",
    name: "Crickets",
    group: "Nature",
    description: "Night time crickets with a light breeze",
    sound: { reverb_wet: -10, reverb_flutter: 0.1 },
    voices: [
      {
        name: "main",
        keys: {
          wave: "none", noise: -10, noise_colour: "pink", bandpass_q: 3,
          gate: periodic("linear", [[0.5, 0], [1, 0.5], [0.5, 1]], 6),
          bandpass: periodic("smooth", [[300, 0], [500, 0.5], [300, 1]], 6),
        },
      },
      { name: "chorus", keys: { wave: "none", blips: "40 -30 4200 4900 0.008 0", highpass: 3000 } },
      {
        name: "cricket",
        keys: {
          wave: "none", noise: -12, gate_slew: 0.004, bandpass: 4550, bandpass_q: 25,
          gate: cricketGate([[1, 0], [0, 0.02], [1, 0.04], [0, 0.06], [1, 0.08], [0, 0.1]], 0.6),
        },
      },
      {
        name: "cricket2",
        keys: {
          wave: "none", noise: -12, gate_slew: 0.004, bandpass: 4250, bandpass_q: 25,
          gate: cricketGate([[0, 0], [1, 0.3], [0, 0.318], [1, 0.336], [0, 0.354]], 0.75),
        },
      },
    ],
    controls: [
      {
        id: "crickets", label: "Crickets", value: 0.5, format: percent,
        targets: [
          { voice: "chorus", key: "density", map: range(0, 3) },
          { voice: "cricket", key: "level", map: range(-40, -10) },
          { voice: "cricket2", key: "level", map: range(-46, -16) },
        ],
      },
      { id: "breeze", label: "Breeze", value: 0.7, format: decibels(range(-30, 0)), targets: [{ voice: "main", key: "level", map: range(-30, 0) }] },
    ],
  },
  {
    id: "birdsong",
    name: "Birdsong",
    group: "Nature",
    description: "Forest birdsong over rustling leaves",
    sound: { reverb_width: 30, reverb_time: 1.8, reverb_wet: -6 },
    voices: [
      { name: "main", keys: { wave: "none", noise: -20, noise_colour: "pink", highpass: 800, lowpass: 6000 } },
      { name: "chirps", keys: { wave: "none", blips: "3 -6 2500 5500 0.03 1.5", highpass: 1500 } },
      { name: "calls", keys: { wave: "none", blips: "2 -8 1800 3500 0.05 -1", highpass: 1200 } },
    ],
    controls: [
      {
        id: "birds", label: "Birds", value: 0.5, format: percent,
        targets: ["chirps", "calls"].map(voice => ({ voice, key: "density", map: range(0, 3) })),
      },
      { id: "leaves", label: "Leaves", value: 0.5, format: decibels(range(-40, -10)), targets: [{ voice: "main", key: "noise", map: range(-40, -10) }] },
    ],
  },
  {
    id: "fire",
    name: "Fire",
    group: "Nature",
    description: "Crackling fire from campfire to blaze",
    sound: { reverb_wet: -9 },
    voices: [
      { name: "main", keys: { wave: "none", crackle: "45 0 0.0012", drive: 1.5, highpass: 900, lowpass: 9000 } },
      { name: "pops", keys: { wave: "none", crackle: "6 0 0.004", highpass: 250, lowpass: 5000, level: -3 } },
      { name: "hiss", keys: { wave: "none", noise: -30, noise_colour: "pink", highpass: 2000, lowpass: 7000 } },
      { name: "roar", keys: { wave: "none", noise: -4, noise_colour: "brown", lowpass: 350, drive: 1.5 } },
    ],
    controls: [
      { id: "crackle", label: "Crackle", value: 0.5, format: percent, targets: [{ voice: "main", key: "density", map: range(0.2, 2.5) }] },
      { id: "pops", label: "Pops", value: 0.4, format: percent, targets: [{ voice: "pops", key: "density", map: range(0, 3) }] },
      { id: "roar", label: "Roar", value: 0.3, format: decibels(range(-40, 0)), targets: [{ voice: "roar", key: "level", map: range(-40, 0) }] },
      { id: "hiss", label: "Hiss", value: 0.5, format: decibels(range(-44, -18)), targets: [{ voice: "hiss", key: "noise", map: range(-44, -18) }] },
    ],
  },
  {
    id: "engine",
    name: "Engine",
    group: "Machines",
    description: "Combustion engine, idle to full revs",
    sound: { reverb_wet: -8 },
    voices: [
      {
        name: "main",
        keys: {
          wave: "none", drive: 1.5, highpass: 30, lowpass: 1800, peak_eq: "110 6 1.5",
          engine: context => `1500 ${context.values.cylinders} ${context.values.roughness.toFixed(2)} -8`,
        },
      },
      {
        name: "clatter",
        keys: {
          wave: "none", highpass: 2500,
          engine: context => `1500 ${context.values.cylinders} ${context.values.roughness.toFixed(2)} 6`,
        },
      },
    ],
    controls: [
      {
        id: "rpm", label: "RPM", value: 0.3, format: value => `${Math.round(exponential(600, 4500)(value))} rpm`,
        targets: ["main", "clatter"].map(voice => ({ voice, key: "rpm", map: exponential(600, 4500) })),
      },
      { id: "clatter", label: "Clatter", value: 0.4, format: decibels(range(-40, -6)), targets: [{ voice: "clatter", key: "level", map: range(-40, -6) }] },
      {
        id: "muffler", label: "Muffler", value: 0.4, format: hertz(exponential(4000, 500)),
        targets: [{ voice: "main", key: "lowpass", map: exponential(4000, 500) }],
      },
      {
        id: "cylinders", label: "Cylinders", kind: "choice", value: 6,
        options: [[1, "Single"], [2, "Twin"], [4, "Four"], [6, "Six"], [8, "Eight"]],
        targets: [],
      },
      {
        id: "roughness", label: "Roughness", value: 0.5, format: percent,
        targets: ["main", "clatter"].map(voice => ({ voice, key: "roughness", map: range(0, 1) })),
      },
    ],
  },
  {
    id: "electric",
    name: "Electric",
    group: "Machines",
    description: "High voltage buzz, hum and crackle",
    sound: { reverb_wet: -6 },
    voices: [
      {
        name: "main",
        keys: {
          wave: "none", noise: -2, noise_mod: 1, crackle: "30 -6 0.0008", drive: 3, highpass: 150, lowpass: 8000,
          pitch: context => context.values.mains * 2,
        },
      },
      { name: "hum", keys: { wave: "saw", drive: 1, highpass: 60, lowpass: 600, pitch: context => context.values.mains * 2 } },
    ],
    controls: [
      { id: "buzz", label: "Buzz", value: 0.8, format: decibels(range(-24, 0)), targets: [{ voice: "main", key: "noise", map: range(-24, 0) }] },
      { id: "crackle", label: "Crackle", value: 0.4, format: percent, targets: [{ voice: "main", key: "density", map: range(0, 3) }] },
      { id: "hum", label: "Hum", value: 0.5, format: decibels(range(-40, -4)), targets: [{ voice: "hum", key: "level", map: range(-40, -4) }] },
      { id: "mains", label: "Mains", kind: "choice", value: 50, options: [[50, "50 Hz (UK)"], [60, "60 Hz (US)"]], targets: [] },
    ],
  },
  {
    id: "siren",
    name: "Siren",
    group: "Machines",
    description: "Electronic siren with adjustable sweep",
    sound: {},
    voices: [
      {
        name: "main",
        keys: {
          wave: "square", drive: 1.5, highpass: 350, peak_eq: "1800 5 1.0",
          pitch: context => {
            const period = at => exponential(4, 0.08)(context.valueAt("sweep", at));
            const low = at => exponential(300, 900)(context.valueAt("low", at)).toFixed(1);
            const high = at => exponential(900, 2000)(context.valueAt("high", at)).toFixed(1);
            if (!["sweep", "low", "high"].some(context.automated)) {
              const fitted = fittedPeriod(period(0), context.length);
              return `smooth ${low(0)}@0 ${high(0)}@${time(fitted / 2)} ${low(0)}@${time(fitted)}`;
            }
            const parts = [];
            for (const [start, seconds] of fittedCycles(context.length, period)) {
              parts.push(`${low(start)}@${time(start)}`, `${high(start + seconds / 2)}@${time(start + seconds / 2)}`);
            }
            parts.push(`${low(0)}@${time(context.length)}`);
            return `smooth ${parts.join(" ")}`;
          },
        },
      },
    ],
    controls: [
      { id: "sweep", label: "Sweep speed", value: 0, format: value => `${exponential(4, 0.08)(value).toFixed(2)} s`, targets: [] },
      { id: "low", label: "Low pitch", value: 0.6, format: hertz(exponential(300, 900)), targets: [] },
      { id: "high", label: "High pitch", value: 0.5, format: hertz(exponential(900, 2000)), targets: [] },
      {
        id: "brightness", label: "Brightness", value: 0.5, format: hertz(exponential(1500, 8000)),
        targets: [{ voice: "main", key: "lowpass", map: exponential(1500, 8000) }],
      },
    ],
  },
];

export const mixerControls = [
  { id: "volume", label: "Volume", value: 40 / 46, format: value => `${(value * 46 - 40).toFixed(1)} dB` },
  { id: "reverb", label: "Reverb", value: 0.5, format: percent },
];

export function volumeToGain(value) {
  return Math.pow(10, (value * 46 - 40) / 20);
}

export function templateById(id) {
  return templates.find(template => template.id === id);
}
