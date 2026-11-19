#include "synth.h"
#include "reverb.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iterator>
#include <optional>
#include <random>
#include <sstream>

namespace {

using Processor = std::function<double(double)>;

constexpr int oversampling = 8;
constexpr double butterworth_q[] = {0.5098, 0.6013, 0.9000, 2.5629};

double db_to_gain(double db)
{
    return std::pow(10.0, db / 20.0);
}

class Biquad {
public:
    static Biquad lowpass(double frequency, int rate, double q = M_SQRT1_2)
    {
        return pass_filter(frequency, rate, q, false);
    }

    static Biquad highpass(double frequency, int rate)
    {
        return pass_filter(frequency, rate, M_SQRT1_2, true);
    }

    static Biquad peaking(double frequency, double gain_db, double q, int rate)
    {
        double amplitude = std::pow(10.0, gain_db / 40.0);
        double omega = 2.0 * M_PI * frequency / rate;
        double alpha = std::sin(omega) / (2.0 * q);
        double cosine = std::cos(omega);
        return Biquad(1.0 + alpha * amplitude, -2.0 * cosine, 1.0 - alpha * amplitude,
                      1.0 + alpha / amplitude, -2.0 * cosine, 1.0 - alpha / amplitude);
    }

    double process(double input)
    {
        double output = b0 * input + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = input;
        y2 = y1;
        y1 = output;
        return output;
    }

private:
    Biquad(double nb0, double nb1, double nb2, double na0, double na1, double na2)
        : b0(nb0 / na0), b1(nb1 / na0), b2(nb2 / na0), a1(na1 / na0), a2(na2 / na0)
    {
    }

    static Biquad pass_filter(double frequency, int rate, double q, bool high)
    {
        double omega = 2.0 * M_PI * frequency / rate;
        double alpha = std::sin(omega) / (2.0 * q);
        double cosine = std::cos(omega);
        double edge = high ? (1.0 + cosine) / 2.0 : (1.0 - cosine) / 2.0;
        double middle = high ? -(1.0 + cosine) : 1.0 - cosine;
        return Biquad(edge, middle, edge, 1.0 + alpha, -2.0 * cosine, 1.0 - alpha);
    }

    double b0, b1, b2, a1, a2;
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
};

std::vector<double> steady_state(const std::vector<double> &loop, size_t warmup, const Processor &process)
{
    size_t samples = loop.size();
    size_t warmup_loops = (warmup + samples - 1) / samples;
    for (size_t i = 0; i < warmup_loops * samples; i++) {
        process(loop[i % samples]);
    }
    std::vector<double> output(samples + 1);
    for (size_t i = 0; i <= samples; i++) {
        output[i] = process(loop[i % samples]);
    }
    return output;
}

std::vector<double> slew(const std::vector<double> &target, double seconds, int rate)
{
    if (seconds <= 0.0) {
        return target;
    }
    double coefficient = 1.0 - std::exp(-1.0 / (seconds * rate));
    double state = target.back();
    std::vector<double> output = steady_state(target, size_t(seconds * rate * 12.0), [&](double sample) {
        state += coefficient * (sample - state);
        return state;
    });
    output.pop_back();
    return output;
}

class Resonator {
public:
    void tune(double frequency, double q, int rate)
    {
        double g = std::tan(M_PI * std::min(frequency, rate * 0.49) / rate);
        damping = 1.0 / q;
        a1 = 1.0 / (1.0 + g * (g + damping));
        a2 = g * a1;
        a3 = g * a2;
    }

    double process(double input)
    {
        double v3 = input - ic2eq;
        double v1 = a1 * ic1eq + a2 * v3;
        double v2 = ic2eq + a2 * ic1eq + a3 * v3;
        ic1eq = 2.0 * v1 - ic1eq;
        ic2eq = 2.0 * v2 - ic2eq;
        return damping * v1;
    }

private:
    double damping = 1.0, a1 = 0.0, a2 = 0.0, a3 = 0.0;
    double ic1eq = 0.0, ic2eq = 0.0;
};

double poly_blep(double phase, double step)
{
    if (phase < step) {
        double t = phase / step;
        return t + t - t * t - 1.0;
    }
    if (phase > 1.0 - step) {
        double t = (phase - 1.0) / step;
        return t * t + t + t + 1.0;
    }
    return 0.0;
}

double oscillator(Wave wave, double phase, double step, double pulse_width)
{
    switch (wave) {
    case Wave::None:
        return 0.0;
    case Wave::Sine:
        return std::sin(2.0 * M_PI * phase);
    case Wave::Triangle:
        return 4.0 * std::fabs(phase - 0.5) - 1.0;
    case Wave::Saw:
        return 2.0 * phase - 1.0 - poly_blep(phase, step);
    case Wave::Square:
        pulse_width = 0.5;
        [[fallthrough]];
    case Wave::Pulse: {
        double value = phase < pulse_width ? 1.0 : -1.0;
        value += poly_blep(phase, step);
        value -= poly_blep(std::fmod(phase + 1.0 - pulse_width, 1.0), step);
        return value;
    }
    }
    return 0.0;
}

uint32_t seed_for(const std::string &name, size_t index)
{
    uint32_t hash = 2166136261u;
    for (char c : name) {
        hash = (hash ^ uint8_t(c)) * 16777619u;
    }
    return hash ^ uint32_t(index * 2654435761u);
}

std::vector<double> coloured_noise(NoiseColour colour, size_t samples, int rate, std::mt19937 &generator)
{
    std::uniform_real_distribution<double> noise(-1.0, 1.0);
    std::vector<double> white(samples);
    for (double &sample : white) {
        sample = noise(generator);
    }
    if (colour == NoiseColour::White) {
        return white;
    }

    std::vector<OnePoleLowpass> bands;
    std::vector<double> weights;
    if (colour == NoiseColour::Brown) {
        bands.emplace_back(20.0, rate);
        weights.push_back(1.0);
    } else {
        for (double cutoff = 20.0; cutoff < rate * 0.5; cutoff *= 2.0) {
            bands.emplace_back(cutoff, rate);
            weights.push_back(1.0 / std::sqrt(cutoff));
        }
    }
    std::vector<double> coloured = steady_state(white, size_t(rate / 2), [&](double sample) {
        double sum = 0.0;
        for (size_t band = 0; band < bands.size(); band++) {
            sum += weights[band] * bands[band].process(sample);
        }
        return sum;
    });
    coloured.pop_back();

    double power = 0.0;
    for (double sample : coloured) {
        power += sample * sample;
    }
    double gain = power > 0.0 ? std::sqrt(samples / (3.0 * power)) : 0.0;
    for (double &sample : coloured) {
        sample *= gain;
    }
    return coloured;
}

void add_blips(const Voice &voice, std::vector<double> &out, int rate, std::mt19937 &generator)
{
    std::uniform_real_distribution<double> unit(0.0, 1.0);
    size_t samples = out.size();
    double length = double(samples) / rate;
    size_t events = std::max<size_t>(1, size_t(std::lround(voice.blip_density * length)));
    for (size_t event = 0; event < events; event++) {
        size_t start = size_t(unit(generator) * samples) % samples;
        double frequency = voice.blip_low * std::pow(voice.blip_high / voice.blip_low, unit(generator));
        double amplitude = voice.blip_level * (0.3 + 0.7 * unit(generator));
        double decay = voice.blip_decay * (0.5 + unit(generator));
        size_t duration = std::min(samples, size_t(decay * 6.0 * rate) + 1);
        double phase = 0.0;
        for (size_t k = 0; k < duration; k++) {
            double t = double(k) / rate;
            double envelope = std::exp(-t / decay) * (1.0 - std::exp(-t / 0.0005));
            out[(start + k) % samples] += amplitude * envelope * std::sin(2.0 * M_PI * phase);
            phase += frequency * std::pow(2.0, voice.blip_chirp * t / (3.0 * decay)) / rate;
        }
    }
}

void add_babble(const Voice &voice, std::vector<double> &out, int rate, std::mt19937 &generator)
{
    static const double vowels[][2] = {
        {730, 1090}, {530, 1840}, {270, 2290}, {570, 840}, {300, 870}, {660, 1720}, {490, 1350},
    };
    std::uniform_real_distribution<double> unit(0.0, 1.0);
    std::uniform_real_distribution<double> noise(-1.0, 1.0);
    size_t samples = out.size();
    double length = double(samples) / rate;
    size_t syllables = std::max<size_t>(1, size_t(std::lround(voice.babble_rate * length)));

    for (size_t syllable = 0; syllable < syllables; syllable++) {
        size_t start = size_t(unit(generator) * samples) % samples;
        double duration = 0.08 + 0.2 * unit(generator);
        double pitch = unit(generator) < 0.5 ? 95.0 + 40.0 * unit(generator) : 180.0 + 70.0 * unit(generator);
        const double *vowel = vowels[size_t(unit(generator) * std::size(vowels)) % std::size(vowels)];
        double amplitude = voice.babble_level * (0.3 + 0.7 * unit(generator));
        double consonant = unit(generator) < 0.6 ? 0.4 : 0.0;

        Resonator first, second, hiss;
        first.tune(vowel[0] * (0.9 + 0.2 * unit(generator)), 6.0, rate);
        second.tune(vowel[1] * (0.9 + 0.2 * unit(generator)), 10.0, rate);
        hiss.tune(3500.0, 2.0, rate);

        size_t count = std::min(samples, size_t(duration * rate));
        double phase = 0.0;
        for (size_t k = 0; k < count; k++) {
            double t = double(k) / count;
            double frequency = pitch * (1.0 - 0.15 * t);
            double step = frequency / rate;
            double buzz = oscillator(Wave::Saw, phase, step, 0.5);
            phase += step;
            phase -= std::floor(phase);
            double envelope = std::pow(std::sin(M_PI * t), 1.5);
            double voiced = first.process(buzz) + 0.5 * second.process(buzz);
            double burst = t < 0.1 ? consonant * hiss.process(noise(generator)) * (1.0 - t / 0.1) : 0.0;
            out[(start + k) % samples] += amplitude * (envelope * voiced + burst);
        }
    }
}

void add_engine(const Voice &voice, std::vector<double> &out, int rate, std::mt19937 &generator)
{
    std::uniform_real_distribution<double> unit(0.0, 1.0);
    std::uniform_real_distribution<double> noise(-1.0, 1.0);
    size_t samples = out.size();
    double length = double(samples) / rate;
    int cylinders = voice.engine_cylinders;
    double roughness = voice.engine_roughness;

    double cycle = 120.0 / voice.engine_rpm;
    double cycles = std::max(1.0, std::round(length / cycle));
    double spacing = length / (cycles * cylinders);

    std::vector<double> cylinder_gain(cylinders), cylinder_offset(cylinders);
    for (int cylinder = 0; cylinder < cylinders; cylinder++) {
        cylinder_gain[cylinder] = 1.0 - 0.4 * roughness * unit(generator);
        cylinder_offset[cylinder] = 0.12 * roughness * (unit(generator) - 0.5);
    }

    double pulse_width = 0.35 * spacing;
    double rasp_decay = 0.0015;
    size_t pulse_samples = size_t(pulse_width * rate) + 1;
    size_t rasp_samples = size_t(rasp_decay * 7.0 * rate) + 1;
    size_t event_count = size_t(cycles) * cylinders;

    for (size_t event = 0; event < event_count; event++) {
        int cylinder = int(event % cylinders);
        double jitter = 0.05 * roughness * (unit(generator) - 0.5);
        double time = (double(event) + cylinder_offset[cylinder] + jitter) * spacing;
        long start = std::lround(time * rate);
        size_t first = size_t(((start % long(samples)) + long(samples)) % long(samples));
        double amplitude = cylinder_gain[cylinder] * (1.0 - 0.3 * roughness * unit(generator));

        for (size_t k = 0; k < std::min(samples, pulse_samples); k++) {
            double shape = std::sin(M_PI * double(k) / pulse_samples);
            out[(first + k) % samples] += amplitude * shape * shape;
        }
        for (size_t k = 0; k < std::min(samples, rasp_samples); k++) {
            double envelope = std::exp(-double(k) / (rasp_decay * rate));
            out[(first + k) % samples] += amplitude * voice.engine_rasp * envelope * noise(generator);
        }
    }
}

std::vector<double> generate_source(const Voice &voice, size_t samples, int rate, uint32_t seed)
{
    double length = double(samples) / rate;

    std::vector<double> sequence_notes;
    double step_seconds = 0.0;
    if (voice.sequence_rate > 0.0) {
        std::mt19937 sequencer(seed ^ 0x5e9u);
        double low_note = std::ceil(12.0 * std::log2(voice.sequence_low / 440.0));
        double high_note = std::floor(12.0 * std::log2(voice.sequence_high / 440.0));
        std::uniform_int_distribution<int> note(int(low_note), int(std::max(low_note, high_note)));
        size_t steps = std::max<size_t>(1, size_t(std::lround(voice.sequence_rate * length)));
        step_seconds = length / steps;
        for (size_t step = 0; step < steps; step++) {
            sequence_notes.push_back(440.0 * std::pow(2.0, note(sequencer) / 12.0));
        }
    }

    std::vector<double> log_pitch(samples);
    for (size_t i = 0; i < samples; i++) {
        double pitch = voice.pitch.values.empty() ? 100.0 : voice.pitch.at(double(i) / rate);
        if (!sequence_notes.empty()) {
            size_t step = std::min(sequence_notes.size() - 1, size_t(double(i) / rate / step_seconds));
            pitch = sequence_notes[step];
        }
        log_pitch[i] = std::log(pitch * voice.pitch_scale);
    }
    log_pitch = slew(log_pitch, voice.glide, rate);

    double vibrato_rate = 0.0;
    if (voice.vibrato_depth != 0.0 && voice.vibrato_rate > 0.0) {
        vibrato_rate = std::max(1.0, std::round(voice.vibrato_rate * length)) / length;
    }

    std::vector<double> frequency(samples);
    double cycles = 0.0;
    for (size_t i = 0; i < samples; i++) {
        double vibrato = voice.vibrato_depth / 12.0 * std::sin(2.0 * M_PI * vibrato_rate * i / rate);
        frequency[i] = std::exp(log_pitch[i]) * std::pow(2.0, vibrato);
        cycles += frequency[i] / rate;
    }
    double pitch_correction = std::max(1.0, std::round(cycles)) / cycles;

    std::vector<double> gate(samples, 1.0);
    if (!voice.gate.values.empty() || !sequence_notes.empty()) {
        for (size_t i = 0; i < samples; i++) {
            double t = double(i) / rate;
            if (!voice.gate.values.empty()) {
                gate[i] = voice.gate.at(t);
            }
            if (!sequence_notes.empty()) {
                double within_step = std::fmod(t, step_seconds) / step_seconds;
                gate[i] *= within_step < voice.sequence_duty ? 1.0 : 0.0;
            }
        }
        gate = slew(gate, voice.gate_slew, rate);
    }

    std::mt19937 generator(seed);
    std::uniform_real_distribution<double> noise(-1.0, 1.0);

    std::vector<double> noise_samples;
    if (voice.noise > 0.0) {
        noise_samples = coloured_noise(voice.noise_colour, samples, rate, generator);
    }

    std::vector<double> crackle(samples, 0.0);
    if (voice.crackle_density > 0.0) {
        std::uniform_real_distribution<double> unit(0.0, 1.0);
        size_t events = std::max<size_t>(1, size_t(std::lround(voice.crackle_density * length)));
        for (size_t event = 0; event < events; event++) {
            size_t start = size_t(unit(generator) * samples) % samples;
            double amplitude = voice.crackle_level * std::pow(unit(generator), 3.0);
            double decay = voice.crackle_decay * rate * (0.3 + 1.4 * unit(generator));
            size_t duration = std::min(samples, size_t(decay * 7.0) + 1);
            for (size_t k = 0; k < duration; k++) {
                crackle[(start + k) % samples] += amplitude * std::exp(-double(k) / decay) * noise(generator);
            }
        }
    }
    if (voice.blip_density > 0.0) {
        add_blips(voice, crackle, rate, generator);
    }
    if (voice.babble_rate > 0.0) {
        add_babble(voice, crackle, rate, generator);
    }
    if (voice.engine_rpm > 0.0) {
        add_engine(voice, crackle, rate, generator);
    }

    std::vector<double> signal(samples);
    double phase = 0.0;
    for (size_t i = 0; i < samples; i++) {
        double step = frequency[i] * pitch_correction / rate;
        double value = oscillator(voice.wave, phase, step, voice.pulse_width);
        if (voice.noise > 0.0) {
            double burst = 1.0 - voice.noise_mod + voice.noise_mod * std::exp(-6.0 * phase);
            value += voice.noise * burst * noise_samples[i];
        }
        value += crackle[i];
        if (voice.drive > 0.0) {
            value = std::tanh(voice.drive * value) / std::tanh(voice.drive);
        }
        signal[i] = value * gate[i];
        phase += step;
        phase -= std::floor(phase);
    }
    return signal;
}

std::vector<double> render_voice(const Voice &voice, size_t samples, int rate, uint32_t seed)
{
    int source_rate = rate * oversampling;
    std::vector<double> source = generate_source(voice, samples * oversampling, source_rate, seed);

    std::vector<Biquad> decimation;
    for (double q : butterworth_q) {
        decimation.push_back(Biquad::lowpass(rate * 0.45, source_rate, q));
    }
    std::vector<double> band_limited = steady_state(source, size_t(source_rate / 10), [&](double sample) {
        for (Biquad &filter : decimation) {
            sample = filter.process(sample);
        }
        return sample;
    });
    std::vector<double> signal(samples);
    for (size_t i = 0; i < samples; i++) {
        signal[i] = band_limited[i * oversampling];
    }

    std::vector<Biquad> filters;
    if (voice.highpass > 0.0) {
        filters.push_back(Biquad::highpass(voice.highpass, rate));
    }
    if (voice.lowpass > 0.0 && voice.lowpass < rate * 0.5) {
        filters.push_back(Biquad::lowpass(voice.lowpass, rate));
    }
    if (voice.peak_freq > 0.0 && voice.peak_gain_db != 0.0) {
        filters.push_back(Biquad::peaking(voice.peak_freq, voice.peak_gain_db, voice.peak_q, rate));
    }

    std::vector<double> bandpass_frequency;
    for (size_t i = 0; !voice.bandpass.values.empty() && i < samples; i++) {
        bandpass_frequency.push_back(voice.bandpass.at(double(i) / rate));
    }
    Resonator bandpass;
    size_t position = 0;

    double level = db_to_gain(voice.level_db);
    return steady_state(signal, size_t(rate / 2), [&](double sample) {
        if (!bandpass_frequency.empty()) {
            bandpass.tune(bandpass_frequency[position], voice.bandpass_q, rate);
            sample = bandpass.process(sample);
        }
        position = (position + 1) % samples;
        for (Biquad &filter : filters) {
            sample = filter.process(sample);
        }
        return sample * level;
    });
}

bool fits_loop(double period, double length)
{
    if (period <= 0.0) {
        return true;
    }
    double repeats = length / period;
    return repeats >= 0.999 && std::fabs(repeats - std::round(repeats)) < 1e-3 * repeats;
}

double default_length(const Sound &sound)
{
    double length = 0.0;
    for (const Voice &voice : sound.voices) {
        length = std::max({length, voice.pitch.period(), voice.gate.period(), voice.bandpass.period()});
    }
    return length > 0.0 ? length : 1.0;
}

double peak_of(const std::vector<double> &signal)
{
    double peak = 0.0;
    for (double sample : signal) {
        peak = std::max(peak, std::fabs(sample));
    }
    return peak;
}

double rms_of(const std::vector<double> &signal, size_t samples)
{
    double sum = 0.0;
    for (size_t i = 0; i < samples; i++) {
        sum += signal[i] * signal[i];
    }
    return std::sqrt(sum / samples);
}

std::vector<float> normalise(const std::vector<double> &signal, size_t samples, double peak_db,
                             std::optional<double> loudness_db, double &seam)
{
    double peak = peak_of(signal);
    double gain = peak > 0.0 ? db_to_gain(peak_db) / peak : 0.0;
    double rms = rms_of(signal, samples);
    if (loudness_db && rms > 0.0) {
        gain = std::min(gain, db_to_gain(*loudness_db) / rms);
    }
    std::vector<float> output(samples);
    for (size_t i = 0; i < samples; i++) {
        output[i] = float(signal[i] * gain);
    }
    seam = peak > 0.0 ? std::fabs(signal[samples] - signal[0]) / peak : 0.0;
    return output;
}

}

Rendered render(const Sound &sound)
{
    Rendered result;
    result.length = sound.length > 0.0 ? sound.length : default_length(sound);
    size_t samples = std::max<size_t>(1, size_t(std::lround(result.length * sound.rate)));

    for (const Voice &voice : sound.voices) {
        for (const Envelope *envelope : {&voice.pitch, &voice.gate, &voice.bandpass}) {
            if (!fits_loop(envelope->period(), result.length)) {
                std::ostringstream message;
                message << voice.name << ": envelope period " << envelope->period()
                        << "s does not divide loop length " << result.length << "s";
                result.warnings.push_back(message.str());
            }
        }
    }

    std::vector<double> dry(samples + 1, 0.0);
    for (size_t index = 0; index < sound.voices.size(); index++) {
        std::vector<double> voice = render_voice(sound.voices[index], samples, sound.rate, seed_for(sound.name, index));
        for (size_t i = 0; i <= samples; i++) {
            dry[i] += voice[i];
        }
    }

    std::vector<double> dry_loop(dry.begin(), dry.end() - 1);
    Reverb reverb(sound.reverb, sound.rate);
    std::vector<double> reverb_out = steady_state(dry_loop, reverb.tail_samples(), [&](double sample) {
        return reverb.process(sample);
    });

    double reverb_rms = rms_of(reverb_out, samples);
    double match = reverb_rms > 0.0 ? rms_of(dry, samples) / reverb_rms : 0.0;
    double dry_gain = db_to_gain(sound.reverb.dry_db);
    double wet_gain = db_to_gain(sound.reverb.wet_db) * match;
    std::vector<double> wet(samples + 1);
    for (size_t i = 0; i <= samples; i++) {
        wet[i] = dry[i] * dry_gain + reverb_out[i] * wet_gain;
    }

    result.dry = normalise(dry, samples, sound.peak_db, sound.loudness_db, result.dry_seam);
    result.wet = normalise(wet, samples, sound.peak_db, sound.loudness_db, result.wet_seam);
    return result;
}
