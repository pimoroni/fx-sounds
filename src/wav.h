#pragma once

#include <string>
#include <vector>

void write_looping_wav(const std::string &path, const std::vector<float> &samples, int rate);
