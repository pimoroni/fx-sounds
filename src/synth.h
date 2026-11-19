#pragma once

#include "patch.h"

#include <string>
#include <vector>

struct Rendered {
    std::vector<float> dry;
    std::vector<float> wet;
    double dry_seam = 0.0;
    double wet_seam = 0.0;
    double length = 0.0;
    std::vector<std::string> warnings;
};

Rendered render(const Sound &sound);
