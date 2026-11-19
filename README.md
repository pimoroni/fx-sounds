# sirensynth

Synthesises seamless sirens, sci-fi sounders, smoke alarms, sizzling fires, spluttering engines and soothing soundscapes from simple text patches. Each sound is written as a dry and a wet (reverb) 16-bit mono WAV with a `smpl` loop chunk covering the whole file.

## Build

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build
```

## Usage

```sh
./build/sirensynth -o out presets/*.ini
./build/sirensynth -o out -s us_wail -s uk_two_tone presets/us.ini presets/uk.ini
```

Writes `out/<name>_dry.wav` and `out/<name>_wet.wav`. `-p` also writes a spectrogram PNG, 20 ms scope SVGs and `sounds.json` for the gallery.

## Gallery

`site/build.sh` builds, tests and renders everything into `_site/` with the gallery page and a zip of the whole pack. `.github/workflows/pages.yml` runs it and deploys to GitHub Pages on pushes to `main` (set Pages source to GitHub Actions). To preview locally:

```sh
./site/build.sh
python3 -m http.server -d _site
```

## Presets

| File | Sounds |
| --- | --- |
| `presets/uk.ini` | two-tone, wail, yelp, priority, hi-lo, WWII air raid alert and all clear |
| `presets/us.ini` | wail, yelp, phaser, hi-lo, rumbler, mechanical (coaster), air horn |
| `presets/civil.ini` | rotating tornado siren, rotating attack wail |
| `presets/rail.ini` | UK yodel crossing alarm, US crossing bell, US five-chime horn, UK two-tone horn |
| `presets/maritime.ini` | diaphone foghorn, ship horn |
| `presets/signals.ini` | sonar ping, heart monitor, flatline, Geiger counter, Morse SOS |
| `presets/phones.ini` | UK ring, engaged, unobtainable, dial tone, US ringback, busy, reorder |
| `presets/scifi.ini` | red alert, klaxon, dive alarm, warble, evacuate, self destruct, teleporter, tractor beam, computer |
| `presets/alarms.ini` | smoke alarm, US T3 fire horn, UK fire sounder, reversing beeper, car alarm |
| `presets/fire.ini` | campfire, blaze |
| `presets/engines.ini` | diesel idle, V8 idle, fire truck, starship, helicopter |
| `presets/ambience.ini` | rain, bubbles, stream, waterfall, desert wind, desert night, research facility, cafe, sea waves, thunderstorm, forest birds, city traffic |
| `presets/roomtone.ini` | 50 Hz and 60 Hz mains hum, fluorescent tube, server room |

Frequencies and timings are approximations of the real thing.

## Patch format

`[name]` starts a sound. `[name.voice]` adds a voice to it, copying the first voice's settings and overriding the keys given. `#` and `;` start comments.

### Sound keys

| Key | Default | |
| --- | --- | --- |
| `description` | | shown in the gallery |
| `length` | longest envelope period | loop length in seconds |
| `rate` | 44100 | sample rate |
| `peak` | -1 | output peak, dBFS |
| `loudness` | | target RMS in dBFS, for beds and ambience. Normalises by RMS instead of peak, never exceeding `peak` |
| `reverb_time` | 1.6 | RT60 of the diffuse tail, seconds |
| `reverb_width` | 16 | width of the space in metres, sets reflection timing |
| `reverb_flutter` | 0.5 | facade-to-facade echo feedback, 0 to <1 |
| `reverb_damping` | 5000 | high frequency loss in the tail, Hz |
| `reverb_tone` | 6000 | lowpass on the reverb input, Hz |
| `reverb_wet` | -3 | reverb level in dB, relative to dry RMS |
| `reverb_dry` | 0 | direct level in the wet file, dB |

### Voice keys

| Key | Example | |
| --- | --- | --- |
| `wave` | `square` | `none`, `sine`, `square`, `saw`, `triangle`, `pulse` |
| `pulse_width` | `0.25` | for `pulse` |
| `pitch` | `smooth 700@0 1550@2.5 700@5` | envelope, Hz |
| `pitch_scale` | `1.2` | multiplies pitch |
| `detune` | `6` | cents |
| `glide` | `0.02` | pitch slew time, seconds |
| `vibrato` | `3 14` | depth in semitones, rate in Hz |
| `sequence` | `10 600 2400 0.6` or `off` | random semitone notes: steps per second, low Hz, high Hz, on fraction per step. Overrides `pitch` |
| `gate` | `1@0 0@0.5 0@1` | amplitude envelope, 0 to 1 |
| `gate_slew` | `0.003` | gate slew time, seconds |
| `level` | `-6` | dB |
| `noise` | `-24` or `off` | noise level, dB |
| `noise_colour` | `pink` | `white`, `pink`, `brown` |
| `noise_mod` | `0.9` | 0 to 1, shapes noise into a burst per oscillator cycle |
| `crackle` | `45 0 0.0012` or `off` | random noise bursts: per second, peak dB, decay seconds |
| `blips` | `90 -4 350 1600 0.012 1.2` or `off` | random sine pings: per second, peak dB, low Hz, high Hz, decay seconds, chirp octaves |
| `babble` | `28 0` or `off` | random vowel syllables: per second, peak dB |
| `engine` | `1500 6 0.5 -8` or `off` | four-stroke firing pulses: rpm, cylinders, roughness 0 to 1, rasp dB |
| `drive` | `2` | tanh saturation |
| `highpass`, `lowpass` | `400` | Hz, 0 disables |
| `peak_eq` | `1600 5 1.0` | Hz, gain dB, Q |
| `bandpass` | `smooth 300@0 900@5 300@10` or `off` | resonant bandpass, envelope in Hz |
| `bandpass_q` | `4` | |

### Envelopes

`[curve] value@time value@time ...` or a single constant value. Curves: `step`, `linear`, `log`, `smooth` (`log` and `smooth` interpolate in log space and need values above 0). Pitch defaults to `log`, gate to `step`. The envelope repeats with a period equal to the last point's time, so the last point's value should match the first. The loop length must be a whole multiple of every envelope period; a warning is printed if not.

## Looping

- Each voice's pitch is scaled slightly so it completes a whole number of cycles per loop, so the oscillator phase lines up at the loop point. On very short loops this can shift pitch by a few cents.
- Vibrato rate is rounded to a whole number of cycles per loop.
- Oscillators, noise and random events run at 8x the sample rate and are band-limited down, to avoid aliasing.
- Noise and random events (crackle, blips, babble, engine pulses) are generated once per loop and tiled. Event tails wrap around the loop point. Engines fit a whole number of engine cycles to the loop.
- Filters and reverb are run over the tiled loop until settled, then one loop is captured, so the wet file's reverb tail wraps into its own start.

`ctest` renders every preset and checks that one more processed sample after the loop matches the first sample.

## Licence

Code: MIT, see `LICENSE`. Rendered sounds and previews: CC0, see `LICENSE-SOUNDS`.
