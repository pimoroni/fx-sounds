#pragma once

#include "patch.h"

#include <array>
#include <cstddef>
#include <vector>

class DelayLine {
public:
    explicit DelayLine(size_t length = 1);
    double read() const;
    void write(double sample);
    size_t length() const;

private:
    std::vector<double> buffer;
    size_t position = 0;
};

class OnePoleLowpass {
public:
    OnePoleLowpass() = default;
    OnePoleLowpass(double cutoff, int rate);
    double process(double sample);

private:
    double coefficient = 1.0;
    double state = 0.0;
};

class Reverb {
public:
    Reverb(const ReverbSettings &settings, int rate);
    double process(double sample);
    size_t tail_samples() const;

private:
    static constexpr size_t line_count = 8;

    double flutter_feedback;
    size_t tail;
    OnePoleLowpass tone;
    DelayLine predelay;
    DelayLine flutter;
    OnePoleLowpass flutter_damping;
    std::array<DelayLine, 3> diffusers;
    std::array<DelayLine, line_count> lines;
    std::array<OnePoleLowpass, line_count> line_damping;
    std::array<double, line_count> line_gain{};
};
