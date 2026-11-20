#pragma once

#include <optional>
#include <string>
#include <vector>

enum class Curve { Step, Linear, Log, Smooth };

struct Envelope {
    Curve curve = Curve::Linear;
    std::vector<double> times;
    std::vector<double> values;

    double period() const;
    double at(double t) const;
    bool empty() const;
    bool constant() const;
    double highest() const;
};

enum class NoiseColour { White, Pink, Brown };

enum class Wave { None, Sine, Square, Saw, Triangle, Pulse };

struct Voice {
    std::string name;
    Wave wave = Wave::Square;
    double pulse_width = 0.5;
    Envelope pitch;
    double pitch_scale = 1.0;
    double glide = 0.0;
    double vibrato_depth = 0.0;
    double vibrato_rate = 0.0;
    Envelope gate;
    double sequence_rate = 0.0;
    double sequence_low = 0.0;
    double sequence_high = 0.0;
    double sequence_duty = 1.0;
    double gate_slew = 0.003;
    Envelope level;
    Envelope noise;
    NoiseColour noise_colour = NoiseColour::White;
    double noise_mod = 0.0;
    double crackle_density = 0.0;
    double crackle_level = 0.0;
    double crackle_decay = 0.0;
    double blip_density = 0.0;
    double blip_level = 0.0;
    double blip_low = 0.0;
    double blip_high = 0.0;
    double blip_decay = 0.0;
    double blip_chirp = 0.0;
    double engine_rpm = 0.0;
    int engine_cylinders = 0;
    double engine_roughness = 0.0;
    double engine_rasp = 0.0;
    Envelope rpm;
    Envelope roughness;
    Envelope density;
    double babble_rate = 0.0;
    double babble_level = 0.0;
    double drive = 0.0;
    Envelope highpass;
    Envelope lowpass;
    Envelope bandpass;
    Envelope bandpass_q;
    double peak_freq = 0.0;
    double peak_gain_db = 0.0;
    double peak_q = 1.0;
};

struct ReverbSettings {
    double time = 1.6;
    double width = 16.0;
    double damping = 5000.0;
    double tone = 6000.0;
    double flutter = 0.5;
    double wet_db = -3.0;
    double dry_db = 0.0;
};

struct Sound {
    std::string name;
    std::string description;
    double length = 0.0;
    int rate = 44100;
    int oversampling = 8;
    double peak_db = -1.0;
    std::optional<double> loudness_db;
    ReverbSettings reverb;
    std::vector<Voice> voices;
};

std::vector<Sound> parse_patches(const std::string &text, const std::string &source);
std::vector<Sound> load_patches(const std::string &path);
