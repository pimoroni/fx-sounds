#include "patch.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <map>
#include <sstream>
#include <stdexcept>

double Envelope::period() const
{
    return times.empty() ? 0.0 : times.back();
}

bool Envelope::empty() const
{
    return values.empty();
}

bool Envelope::constant() const
{
    return values.size() <= 1;
}

double Envelope::highest() const
{
    return values.empty() ? 0.0 : *std::max_element(values.begin(), values.end());
}

double Envelope::at(double t) const
{
    if (values.empty()) {
        return 0.0;
    }
    if (values.size() == 1) {
        return values[0];
    }

    double length = period();
    double position = std::fmod(t, length);
    if (position < 0.0) {
        position += length;
    }

    auto after = std::upper_bound(times.begin(), times.end() - 1, position);
    size_t segment = after == times.begin() ? 0 : size_t(after - times.begin()) - 1;

    double start = times[segment];
    double end = times[segment + 1];
    double from = values[segment];
    double to = values[segment + 1];
    double fraction = end > start ? (position - start) / (end - start) : 1.0;

    switch (curve) {
    case Curve::Step:
        return from;
    case Curve::Linear:
        return from + (to - from) * fraction;
    case Curve::Log:
        return from * std::pow(to / from, fraction);
    case Curve::Smooth: {
        double eased = 0.5 - 0.5 * std::cos(fraction * M_PI);
        return from * std::pow(to / from, eased);
    }
    }
    return from;
}

namespace {

struct ParseError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

std::string trim(const std::string &text)
{
    size_t first = text.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return "";
    }
    size_t last = text.find_last_not_of(" \t\r\n");
    return text.substr(first, last - first + 1);
}

std::vector<std::string> split_words(const std::string &text)
{
    std::istringstream stream(text);
    std::vector<std::string> words;
    std::string word;
    while (stream >> word) {
        words.push_back(word);
    }
    return words;
}

double parse_number(const std::string &text)
{
    size_t used = 0;
    double value = 0.0;
    try {
        value = std::stod(text, &used);
    } catch (const std::exception &) {
        used = 0;
    }
    if (used != text.size() || !std::isfinite(value)) {
        throw ParseError("expected a number, got '" + text + "'");
    }
    return value;
}

std::vector<double> parse_numbers(const std::string &text, size_t count)
{
    std::vector<std::string> words = split_words(text);
    if (words.size() != count) {
        throw ParseError("expected " + std::to_string(count) + " numbers, got '" + text + "'");
    }
    std::vector<double> numbers;
    for (const std::string &word : words) {
        numbers.push_back(parse_number(word));
    }
    return numbers;
}

Envelope parse_envelope(const std::string &text, Curve default_curve)
{
    static const std::map<std::string, Curve> curves = {
        {"step", Curve::Step},
        {"linear", Curve::Linear},
        {"log", Curve::Log},
        {"smooth", Curve::Smooth},
    };

    Envelope envelope;
    envelope.curve = default_curve;
    std::vector<std::string> words = split_words(text);

    if (!words.empty() && curves.count(words[0])) {
        envelope.curve = curves.at(words[0]);
        words.erase(words.begin());
    }
    if (words.empty()) {
        throw ParseError("empty envelope");
    }

    if (words.size() == 1 && words[0].find('@') == std::string::npos) {
        envelope.times.push_back(0.0);
        envelope.values.push_back(parse_number(words[0]));
        return envelope;
    }

    for (const std::string &word : words) {
        size_t at = word.find('@');
        if (at == std::string::npos) {
            throw ParseError("expected value@time, got '" + word + "'");
        }
        double value = parse_number(word.substr(0, at));
        double time = parse_number(word.substr(at + 1));
        if (!envelope.times.empty() && time < envelope.times.back()) {
            throw ParseError("envelope times must not decrease");
        }
        envelope.values.push_back(value);
        envelope.times.push_back(time);
    }

    if (envelope.times.front() != 0.0) {
        throw ParseError("envelope must start at time 0");
    }
    if (envelope.times.size() < 2 || envelope.period() <= 0.0) {
        throw ParseError("envelope needs at least two points and a period greater than 0");
    }
    if (envelope.curve == Curve::Log || envelope.curve == Curve::Smooth) {
        for (double value : envelope.values) {
            if (value <= 0.0) {
                throw ParseError("log and smooth envelopes need values greater than 0");
            }
        }
    }
    return envelope;
}

NoiseColour parse_noise_colour(const std::string &text)
{
    static const std::map<std::string, NoiseColour> colours = {
        {"white", NoiseColour::White},
        {"pink", NoiseColour::Pink},
        {"brown", NoiseColour::Brown},
    };
    auto found = colours.find(text);
    if (found == colours.end()) {
        throw ParseError("unknown noise colour '" + text + "'");
    }
    return found->second;
}

Wave parse_wave(const std::string &text)
{
    static const std::map<std::string, Wave> waves = {
        {"none", Wave::None},
        {"sine", Wave::Sine},
        {"square", Wave::Square},
        {"saw", Wave::Saw},
        {"triangle", Wave::Triangle},
        {"pulse", Wave::Pulse},
    };
    auto found = waves.find(text);
    if (found == waves.end()) {
        throw ParseError("unknown wave '" + text + "'");
    }
    return found->second;
}

bool apply_sound_key(Sound &sound, const std::string &key, const std::string &value)
{
    ReverbSettings &reverb = sound.reverb;
    if (key == "description") {
        sound.description = value;
    } else if (key == "length") {
        sound.length = parse_number(value);
    } else if (key == "oversampling") {
        sound.oversampling = int(parse_number(value));
    } else if (key == "rate") {
        sound.rate = int(parse_number(value));
    } else if (key == "loudness") {
        sound.loudness_db = parse_number(value);
    } else if (key == "peak") {
        sound.peak_db = parse_number(value);
    } else if (key == "reverb_time") {
        reverb.time = parse_number(value);
    } else if (key == "reverb_width") {
        reverb.width = parse_number(value);
    } else if (key == "reverb_damping") {
        reverb.damping = parse_number(value);
    } else if (key == "reverb_tone") {
        reverb.tone = parse_number(value);
    } else if (key == "reverb_flutter") {
        reverb.flutter = parse_number(value);
    } else if (key == "reverb_wet") {
        reverb.wet_db = parse_number(value);
    } else if (key == "reverb_dry") {
        reverb.dry_db = parse_number(value);
    } else {
        return false;
    }
    return true;
}

void apply_voice_key(Voice &voice, const std::string &key, const std::string &value)
{
    if (key == "wave") {
        voice.wave = parse_wave(value);
    } else if (key == "pulse_width") {
        voice.pulse_width = parse_number(value);
    } else if (key == "pitch") {
        voice.pitch = parse_envelope(value, Curve::Log);
    } else if (key == "pitch_scale") {
        voice.pitch_scale = parse_number(value);
    } else if (key == "detune") {
        voice.pitch_scale *= std::pow(2.0, parse_number(value) / 1200.0);
    } else if (key == "glide") {
        voice.glide = parse_number(value);
    } else if (key == "vibrato") {
        std::vector<double> numbers = parse_numbers(value, 2);
        voice.vibrato_depth = numbers[0];
        voice.vibrato_rate = numbers[1];
    } else if (key == "gate") {
        voice.gate = parse_envelope(value, Curve::Step);
    } else if (key == "sequence" && value == "off") {
        voice.sequence_rate = 0.0;
    } else if (key == "sequence") {
        std::vector<double> numbers = parse_numbers(value, 4);
        voice.sequence_rate = numbers[0];
        voice.sequence_low = numbers[1];
        voice.sequence_high = numbers[2];
        voice.sequence_duty = numbers[3];
    } else if (key == "gate_slew") {
        voice.gate_slew = parse_number(value);
    } else if (key == "level") {
        voice.level = parse_envelope(value, Curve::Linear);
    } else if (key == "noise") {
        voice.noise = value == "off" ? Envelope() : parse_envelope(value, Curve::Linear);
    } else if (key == "density") {
        voice.density = parse_envelope(value, Curve::Linear);
    } else if (key == "rpm") {
        voice.rpm = value == "off" ? Envelope() : parse_envelope(value, Curve::Log);
    } else if (key == "noise_colour") {
        voice.noise_colour = parse_noise_colour(value);
    } else if (key == "blips" && value == "off") {
        voice.blip_density = 0.0;
    } else if (key == "blips") {
        std::vector<double> numbers = parse_numbers(value, 6);
        voice.blip_density = numbers[0];
        voice.blip_level = std::pow(10.0, numbers[1] / 20.0);
        voice.blip_low = numbers[2];
        voice.blip_high = numbers[3];
        voice.blip_decay = numbers[4];
        voice.blip_chirp = numbers[5];
    } else if (key == "engine" && value == "off") {
        voice.engine_rpm = 0.0;
    } else if (key == "engine") {
        std::vector<double> numbers = parse_numbers(value, 4);
        voice.engine_rpm = numbers[0];
        voice.engine_cylinders = int(numbers[1]);
        voice.engine_roughness = numbers[2];
        voice.engine_rasp = std::pow(10.0, numbers[3] / 20.0);
    } else if (key == "babble" && value == "off") {
        voice.babble_rate = 0.0;
    } else if (key == "babble") {
        std::vector<double> numbers = parse_numbers(value, 2);
        voice.babble_rate = numbers[0];
        voice.babble_level = std::pow(10.0, numbers[1] / 20.0);
    } else if (key == "bandpass" && value == "off") {
        voice.bandpass = Envelope();
    } else if (key == "bandpass") {
        voice.bandpass = parse_envelope(value, Curve::Log);
    } else if (key == "bandpass_q") {
        voice.bandpass_q = parse_envelope(value, Curve::Log);
    } else if (key == "roughness") {
        voice.roughness = value == "off" ? Envelope() : parse_envelope(value, Curve::Linear);
    } else if (key == "noise_mod") {
        voice.noise_mod = parse_number(value);
    } else if (key == "crackle" && value == "off") {
        voice.crackle_density = 0.0;
    } else if (key == "crackle") {
        std::vector<double> numbers = parse_numbers(value, 3);
        voice.crackle_density = numbers[0];
        voice.crackle_level = std::pow(10.0, numbers[1] / 20.0);
        voice.crackle_decay = numbers[2];
    } else if (key == "drive") {
        voice.drive = parse_number(value);
    } else if (key == "highpass") {
        voice.highpass = parse_envelope(value, Curve::Log);
    } else if (key == "lowpass") {
        voice.lowpass = parse_envelope(value, Curve::Log);
    } else if (key == "peak_eq") {
        std::vector<double> numbers = parse_numbers(value, 3);
        voice.peak_freq = numbers[0];
        voice.peak_gain_db = numbers[1];
        voice.peak_q = numbers[2];
    } else {
        throw ParseError("unknown key '" + key + "'");
    }
}

void validate(const Sound &sound)
{
    if (sound.rate < 8000 || sound.rate > 192000) {
        throw ParseError(sound.name + ": rate must be 8000 to 192000");
    }
    if (sound.length < 0.0 || sound.length > 600.0) {
        throw ParseError(sound.name + ": length must be 0 to 600 seconds");
    }
    if (sound.oversampling < 1 || sound.oversampling > 16) {
        throw ParseError(sound.name + ": oversampling must be 1 to 16");
    }
    if (sound.reverb.time <= 0.0 || sound.reverb.width <= 0.0) {
        throw ParseError(sound.name + ": reverb_time and reverb_width must be greater than 0");
    }
    if (sound.reverb.flutter < 0.0 || sound.reverb.flutter >= 1.0) {
        throw ParseError(sound.name + ": reverb_flutter must be 0 to less than 1");
    }
    for (const Voice &voice : sound.voices) {
        if (voice.sequence_rate > 0.0 && (voice.sequence_low <= 0.0 || voice.sequence_high < voice.sequence_low ||
                                          voice.sequence_duty <= 0.0 || voice.sequence_duty > 1.0)) {
            throw ParseError(sound.name + "." + voice.name + ": sequence needs 0 < low <= high and duty 0 to 1");
        }
        if (voice.pitch.values.empty() && voice.wave != Wave::None && voice.sequence_rate <= 0.0) {
            throw ParseError(sound.name + "." + voice.name + ": missing pitch");
        }
        if (voice.pulse_width <= 0.0 || voice.pulse_width >= 1.0) {
            throw ParseError(sound.name + "." + voice.name + ": pulse_width must be between 0 and 1");
        }
        if (voice.noise_mod < 0.0 || voice.noise_mod > 1.0) {
            throw ParseError(sound.name + "." + voice.name + ": noise_mod must be 0 to 1");
        }
        if (voice.crackle_density < 0.0 || (voice.crackle_density > 0.0 && voice.crackle_decay <= 0.0)) {
            throw ParseError(sound.name + "." + voice.name + ": crackle needs density >= 0 and decay > 0");
        }
        if (voice.blip_density > 0.0 &&
            (voice.blip_low <= 0.0 || voice.blip_high < voice.blip_low || voice.blip_decay <= 0.0)) {
            throw ParseError(sound.name + "." + voice.name + ": blips need 0 < low <= high and decay > 0");
        }
        if (voice.engine_rpm > 0.0 && (voice.engine_cylinders < 1 || voice.engine_cylinders > 16 ||
                                       voice.engine_roughness < 0.0 || voice.engine_roughness > 1.0)) {
            throw ParseError(sound.name + "." + voice.name + ": engine needs 1 to 16 cylinders and roughness 0 to 1");
        }
        if (voice.babble_rate < 0.0) {
            throw ParseError(sound.name + "." + voice.name + ": babble rate must be >= 0");
        }
        for (double q : voice.bandpass_q.values) {
            if (q <= 0.0) {
                throw ParseError(sound.name + "." + voice.name + ": bandpass_q must be greater than 0");
            }
        }
        for (double roughness : voice.roughness.values) {
            if (roughness < 0.0 || roughness > 1.0) {
                throw ParseError(sound.name + "." + voice.name + ": roughness must be 0 to 1");
            }
        }
        for (double frequency : voice.bandpass.values) {
            if (frequency <= 0.0) {
                throw ParseError(sound.name + "." + voice.name + ": bandpass frequencies must be greater than 0");
            }
        }
        for (double multiplier : voice.density.values) {
            if (multiplier < 0.0) {
                throw ParseError(sound.name + "." + voice.name + ": density must not be negative");
            }
        }
        for (const Envelope *envelope : {&voice.rpm, &voice.highpass, &voice.lowpass}) {
            if (!envelope->constant() && *std::min_element(envelope->values.begin(), envelope->values.end()) <= 0.0) {
                throw ParseError(sound.name + "." + voice.name + ": rpm and filter envelopes must stay above 0");
            }
        }
    }
}

}

std::vector<Sound> load_patches(const std::string &path)
{
    std::ifstream file(path);
    if (!file) {
        throw std::runtime_error("cannot open " + path);
    }
    std::ostringstream text;
    text << file.rdbuf();
    return parse_patches(text.str(), path);
}

std::vector<Sound> parse_patches(const std::string &text, const std::string &path)
{
    std::istringstream file(text);
    std::vector<Sound> sounds;
    Voice *voice = nullptr;
    std::string line;
    int line_number = 0;

    try {
        while (std::getline(file, line)) {
            line_number++;
            size_t comment = line.find_first_of("#;");
            if (comment != std::string::npos) {
                line.erase(comment);
            }
            line = trim(line);
            if (line.empty()) {
                continue;
            }

            if (line.front() == '[') {
                if (line.back() != ']') {
                    throw ParseError("unterminated section");
                }
                std::string section = trim(line.substr(1, line.size() - 2));
                size_t dot = section.find('.');
                if (dot == std::string::npos) {
                    Sound sound;
                    sound.name = section;
                    sound.voices.emplace_back();
                    sound.voices.back().name = "main";
                    sounds.push_back(sound);
                } else {
                    std::string owner = section.substr(0, dot);
                    if (sounds.empty() || sounds.back().name != owner) {
                        throw ParseError("voice section [" + section + "] must follow [" + owner + "]");
                    }
                    Voice extra = sounds.back().voices.front();
                    extra.name = section.substr(dot + 1);
                    sounds.back().voices.push_back(extra);
                }
                voice = &sounds.back().voices.back();
                continue;
            }

            size_t equals = line.find('=');
            if (equals == std::string::npos) {
                throw ParseError("expected key = value");
            }
            if (!voice) {
                throw ParseError("key outside of a section");
            }
            std::string key = trim(line.substr(0, equals));
            std::string value = trim(line.substr(equals + 1));
            bool in_sound_section = &sounds.back().voices.front() == voice;
            if (in_sound_section && apply_sound_key(sounds.back(), key, value)) {
                continue;
            }
            apply_voice_key(*voice, key, value);
        }
    } catch (const ParseError &error) {
        throw std::runtime_error(path + ":" + std::to_string(line_number) + ": " + error.what());
    }

    try {
        for (const Sound &sound : sounds) {
            validate(sound);
        }
    } catch (const ParseError &error) {
        throw std::runtime_error(path + ": " + error.what());
    }

    return sounds;
}
