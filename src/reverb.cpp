#include "reverb.h"

#include <algorithm>
#include <cmath>

namespace {

constexpr double speed_of_sound = 343.0;
constexpr double reference_width = 16.0;
constexpr double line_ms[] = {31.7, 37.3, 41.9, 47.3, 53.1, 61.7, 67.9, 79.3};
constexpr double diffuser_ms[] = {4.7, 3.1, 1.7};
constexpr double diffuser_gain = 0.6;

size_t to_samples(double seconds, int rate)
{
    return std::max<size_t>(1, size_t(std::lround(seconds * rate)));
}

void hadamard(std::array<double, 8> &values)
{
    for (size_t span = 1; span < values.size(); span *= 2) {
        for (size_t block = 0; block < values.size(); block += span * 2) {
            for (size_t i = block; i < block + span; i++) {
                double a = values[i];
                double b = values[i + span];
                values[i] = a + b;
                values[i + span] = a - b;
            }
        }
    }
    for (double &value : values) {
        value *= 1.0 / std::sqrt(8.0);
    }
}

}

DelayLine::DelayLine(size_t length) : buffer(std::max<size_t>(1, length), 0.0) {}

double DelayLine::read() const
{
    return buffer[position];
}

void DelayLine::write(double sample)
{
    buffer[position] = sample;
    position = (position + 1) % buffer.size();
}

size_t DelayLine::length() const
{
    return buffer.size();
}

OnePoleLowpass::OnePoleLowpass(double cutoff, int rate)
{
    double nyquist = rate * 0.5;
    coefficient = cutoff <= 0.0 || cutoff >= nyquist ? 1.0 : 1.0 - std::exp(-2.0 * M_PI * cutoff / rate);
}

double OnePoleLowpass::process(double sample)
{
    state += coefficient * (sample - state);
    return state;
}

Reverb::Reverb(const ReverbSettings &settings, int rate)
    : flutter_feedback(settings.flutter),
      tone(settings.tone, rate),
      predelay(to_samples(settings.width * 0.5 / speed_of_sound, rate)),
      flutter(to_samples(settings.width / speed_of_sound, rate)),
      flutter_damping(settings.damping, rate)
{
    double scale = settings.width / reference_width;

    for (size_t i = 0; i < diffusers.size(); i++) {
        diffusers[i] = DelayLine(to_samples(diffuser_ms[i] * 0.001, rate));
    }

    size_t longest = 0;
    for (size_t i = 0; i < line_count; i++) {
        lines[i] = DelayLine(to_samples(line_ms[i] * 0.001 * scale, rate));
        line_damping[i] = OnePoleLowpass(settings.damping, rate);
        double seconds = double(lines[i].length()) / rate;
        line_gain[i] = std::pow(10.0, -3.0 * seconds / settings.time);
        longest = std::max(longest, lines[i].length());
    }

    double late_decay = settings.time * 96.0 / 60.0;
    double flutter_decay = 0.0;
    if (flutter_feedback > 0.0) {
        double round_trips = std::log(1e-5) / std::log(flutter_feedback);
        flutter_decay = round_trips * flutter.length() / rate;
    }
    tail = predelay.length() + longest + to_samples(std::max(late_decay, flutter_decay), rate);
}

double Reverb::process(double sample)
{
    double input = tone.process(sample);

    double reflection = predelay.read();
    predelay.write(input);

    double flutter_out = flutter.read();
    flutter.write(reflection + flutter_feedback * flutter_damping.process(flutter_out));
    double early = 0.6 * reflection + 0.6 * flutter_out;

    double diffused = reflection;
    for (DelayLine &diffuser : diffusers) {
        double delayed = diffuser.read();
        double stored = diffused + diffuser_gain * delayed;
        diffuser.write(stored);
        diffused = delayed - diffuser_gain * stored;
    }

    std::array<double, line_count> feedback;
    double late = 0.0;
    for (size_t i = 0; i < line_count; i++) {
        double out = lines[i].read();
        late += (i % 2 ? -out : out);
        feedback[i] = line_damping[i].process(out) * line_gain[i];
    }
    hadamard(feedback);
    for (size_t i = 0; i < line_count; i++) {
        double sign = (i % 3 == 0) ? -1.0 : 1.0;
        lines[i].write(feedback[i] + sign * 0.35 * diffused);
    }

    return early + late / std::sqrt(double(line_count));
}

size_t Reverb::tail_samples() const
{
    return tail;
}
