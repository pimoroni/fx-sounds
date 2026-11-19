#include "preview.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <iterator>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <zlib.h>

namespace {

constexpr int image_width = 640;
constexpr int spectrogram_height = 160;
constexpr int scope_height = 80;
constexpr double scope_seconds = 0.02;
constexpr size_t frame_size = 2048;
constexpr double lowest_frequency = 40.0;
constexpr double highest_frequency = 16000.0;
constexpr double floor_db = 80.0;

void write_file(const std::string &path, const std::string &data)
{
    std::ofstream file(path, std::ios::binary);
    if (!file.write(data.data(), data.size())) {
        throw std::runtime_error("cannot write " + path);
    }
}

void fft(std::vector<std::complex<double>> &values)
{
    size_t count = values.size();
    for (size_t i = 1, j = 0; i < count; i++) {
        size_t bit = count >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            std::swap(values[i], values[j]);
        }
    }
    for (size_t span = 2; span <= count; span <<= 1) {
        std::complex<double> step = std::polar(1.0, -2.0 * M_PI / span);
        for (size_t block = 0; block < count; block += span) {
            std::complex<double> twiddle = 1.0;
            for (size_t i = 0; i < span / 2; i++) {
                std::complex<double> even = values[block + i];
                std::complex<double> odd = values[block + i + span / 2] * twiddle;
                values[block + i] = even + odd;
                values[block + i + span / 2] = even - odd;
                twiddle *= step;
            }
        }
    }
}

std::array<uint8_t, 3> colour_for(double level)
{
    static const double stops[][4] = {
        {0.00, 0, 0, 4},
        {0.25, 80, 18, 123},
        {0.50, 183, 55, 121},
        {0.75, 252, 137, 97},
        {1.00, 252, 253, 191},
    };
    for (size_t i = 0; i + 1 < std::size(stops); i++) {
        if (level <= stops[i + 1][0]) {
            double fraction = (level - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
            std::array<uint8_t, 3> colour;
            for (int channel = 0; channel < 3; channel++) {
                double from = stops[i][channel + 1];
                double to = stops[i + 1][channel + 1];
                colour[channel] = uint8_t(std::lround(from + (to - from) * fraction));
            }
            return colour;
        }
    }
    return {252, 253, 191};
}

void put_u32_be(std::string &out, uint32_t value)
{
    for (int shift = 24; shift >= 0; shift -= 8) {
        out.push_back(char((value >> shift) & 0xff));
    }
}

void put_chunk(std::string &out, const char *type, const std::string &data)
{
    put_u32_be(out, uint32_t(data.size()));
    std::string body = std::string(type, 4) + data;
    out += body;
    put_u32_be(out, uint32_t(crc32(0, reinterpret_cast<const Bytef *>(body.data()), uInt(body.size()))));
}

std::string encode_indexed_png(const std::vector<uint8_t> &pixels, int width, int height)
{
    std::string header;
    put_u32_be(header, width);
    put_u32_be(header, height);
    header += std::string("\x08\x03\x00\x00\x00", 5);

    std::string palette;
    for (int i = 0; i < 256; i++) {
        for (uint8_t channel : colour_for(i / 255.0)) {
            palette.push_back(char(channel));
        }
    }

    std::vector<uint8_t> raw;
    for (int y = 0; y < height; y++) {
        raw.push_back(0);
        raw.insert(raw.end(), pixels.begin() + y * width, pixels.begin() + (y + 1) * width);
    }
    uLongf compressed_size = compressBound(uLong(raw.size()));
    std::string compressed(compressed_size, '\0');
    if (compress2(reinterpret_cast<Bytef *>(compressed.data()), &compressed_size, raw.data(), uLong(raw.size()), 9) != Z_OK) {
        throw std::runtime_error("png compression failed");
    }
    compressed.resize(compressed_size);

    std::string png("\x89PNG\r\n\x1a\n", 8);
    put_chunk(png, "IHDR", header);
    put_chunk(png, "PLTE", palette);
    put_chunk(png, "IDAT", compressed);
    put_chunk(png, "IEND", "");
    return png;
}

}

size_t scope_start(const std::vector<float> &samples, int rate)
{
    size_t count = samples.size();
    size_t window = std::min(count, size_t(scope_seconds * rate));
    size_t best = 0;
    double best_energy = -1.0;
    for (size_t start = 0; start + window <= count; start += std::max<size_t>(1, window / 4)) {
        double energy = 0.0;
        for (size_t i = start; i < start + window; i++) {
            energy += double(samples[i]) * samples[i];
        }
        if (energy > best_energy) {
            best_energy = energy;
            best = start;
        }
    }
    return best;
}

void write_scope_svg(const std::string &path, const std::vector<float> &samples, size_t start, int rate)
{
    size_t count = samples.size();
    size_t window = std::max<size_t>(2, std::min(count, size_t(scope_seconds * rate)));
    double middle = scope_height / 2.0;

    std::ostringstream svg;
    svg.setf(std::ios::fixed);
    svg.precision(1);
    svg << "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " << image_width << " " << scope_height
        << "\" preserveAspectRatio=\"none\"><path fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\""
        << " stroke-linejoin=\"round\" vector-effect=\"non-scaling-stroke\" d=\"";
    for (size_t i = 0; i < window; i++) {
        double x = double(i) * image_width / (window - 1);
        double y = middle - samples[(start + i) % count] * middle * 0.92;
        svg << (i == 0 ? "M" : "L") << x << " " << y;
    }
    svg << "\"/></svg>\n";
    write_file(path, svg.str());
}

void write_spectrogram_png(const std::string &path, const std::vector<float> &samples, int rate)
{
    size_t count = samples.size();
    std::vector<double> window(frame_size);
    for (size_t i = 0; i < frame_size; i++) {
        window[i] = 0.5 - 0.5 * std::cos(2.0 * M_PI * i / frame_size);
    }

    double top = std::min(highest_frequency, rate * 0.5);
    std::vector<double> row_bins(spectrogram_height);
    for (int y = 0; y < spectrogram_height; y++) {
        double frequency = top * std::pow(lowest_frequency / top, double(y) / (spectrogram_height - 1));
        row_bins[y] = frequency / rate * frame_size;
    }

    std::vector<double> levels(size_t(image_width) * spectrogram_height);
    double loudest = -1e9;
    std::vector<std::complex<double>> frame(frame_size);
    std::vector<double> magnitude_db(frame_size / 2 + 1);
    size_t wrap_offset = count * (frame_size / count + 1);
    for (int column = 0; column < image_width; column++) {
        size_t centre = column * count / image_width;
        for (size_t i = 0; i < frame_size; i++) {
            size_t index = (centre + wrap_offset - frame_size / 2 + i) % count;
            frame[i] = samples[index] * window[i];
        }
        fft(frame);
        for (size_t bin = 0; bin < magnitude_db.size(); bin++) {
            magnitude_db[bin] = 20.0 * std::log10(std::abs(frame[bin]) + 1e-12);
        }
        for (int y = 0; y < spectrogram_height; y++) {
            size_t bin = std::min(size_t(row_bins[y]), magnitude_db.size() - 2);
            double fraction = row_bins[y] - bin;
            double level = magnitude_db[bin] + (magnitude_db[bin + 1] - magnitude_db[bin]) * fraction;
            levels[size_t(y) * image_width + column] = level;
            loudest = std::max(loudest, level);
        }
    }

    std::vector<uint8_t> pixels(levels.size());
    for (size_t i = 0; i < levels.size(); i++) {
        double level = std::clamp((levels[i] - (loudest - floor_db)) / floor_db, 0.0, 1.0);
        pixels[i] = uint8_t(std::lround(level * 255.0));
    }
    write_file(path, encode_indexed_png(pixels, image_width, spectrogram_height));
}
