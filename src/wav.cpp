#include "wav.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <stdexcept>

namespace {

void put_u16(std::vector<uint8_t> &out, uint16_t value)
{
    out.push_back(value & 0xff);
    out.push_back(value >> 8);
}

void put_u32(std::vector<uint8_t> &out, uint32_t value)
{
    for (int shift = 0; shift < 32; shift += 8) {
        out.push_back((value >> shift) & 0xff);
    }
}

void put_tag(std::vector<uint8_t> &out, const char *tag)
{
    out.insert(out.end(), tag, tag + 4);
}

}

void write_looping_wav(const std::string &path, const std::vector<float> &samples, int rate)
{
    const uint32_t channels = 1;
    const uint32_t bytes_per_sample = 2;
    uint32_t data_size = uint32_t(samples.size()) * bytes_per_sample * channels;
    const uint32_t fmt_size = 16;
    const uint32_t smpl_size = 36 + 24;

    std::vector<uint8_t> out;
    put_tag(out, "RIFF");
    put_u32(out, 4 + (8 + fmt_size) + (8 + data_size) + (8 + smpl_size));
    put_tag(out, "WAVE");

    put_tag(out, "fmt ");
    put_u32(out, fmt_size);
    put_u16(out, 1);
    put_u16(out, channels);
    put_u32(out, rate);
    put_u32(out, rate * channels * bytes_per_sample);
    put_u16(out, channels * bytes_per_sample);
    put_u16(out, bytes_per_sample * 8);

    put_tag(out, "data");
    put_u32(out, data_size);
    for (float sample : samples) {
        long value = std::lround(std::clamp(sample, -1.0f, 1.0f) * 32767.0f);
        put_u16(out, uint16_t(int16_t(value)));
    }

    put_tag(out, "smpl");
    put_u32(out, smpl_size);
    put_u32(out, 0);
    put_u32(out, 0);
    put_u32(out, uint32_t(1e9 / rate));
    put_u32(out, 60);
    put_u32(out, 0);
    put_u32(out, 0);
    put_u32(out, 0);
    put_u32(out, 1);
    put_u32(out, 0);
    put_u32(out, 0);
    put_u32(out, 0);
    put_u32(out, 0);
    put_u32(out, uint32_t(samples.size()) - 1);
    put_u32(out, 0);
    put_u32(out, 0);

    std::ofstream file(path, std::ios::binary);
    if (!file.write(reinterpret_cast<const char *>(out.data()), out.size())) {
        throw std::runtime_error("cannot write " + path);
    }
}
