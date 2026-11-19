#pragma once

#include <cstddef>
#include <string>
#include <vector>

size_t scope_start(const std::vector<float> &samples, int rate);
void write_scope_svg(const std::string &path, const std::vector<float> &samples, size_t start, int rate);
void write_spectrogram_png(const std::string &path, const std::vector<float> &samples, int rate);
