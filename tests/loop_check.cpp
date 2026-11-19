#include "patch.h"
#include "synth.h"

#include <cmath>
#include <cstdio>
#include <string>

int main(int argc, char **argv)
{
    const double seam_limit = 1e-3;
    int failures = 0;
    int checked = 0;

    for (int i = 1; i < argc; i++) {
        try {
            for (const Sound &sound : load_patches(argv[i])) {
                Rendered rendered = render(sound);
                checked++;
                bool finite = true;
                float peak = 0.0f;
                for (const auto *signal : {&rendered.dry, &rendered.wet}) {
                    for (float sample : *signal) {
                        finite = finite && std::isfinite(sample);
                        peak = std::fmax(peak, std::fabs(sample));
                    }
                }
                bool ok = finite && peak > 0.0f && peak <= 1.0f && rendered.warnings.empty() &&
                          rendered.dry_seam < seam_limit && rendered.wet_seam < seam_limit;
                std::printf("%s %-28s dry seam %.2e  wet seam %.2e\n", ok ? "ok  " : "FAIL", sound.name.c_str(),
                            rendered.dry_seam, rendered.wet_seam);
                for (const std::string &warning : rendered.warnings) {
                    std::printf("     %s\n", warning.c_str());
                }
                failures += ok ? 0 : 1;
            }
        } catch (const std::exception &error) {
            std::printf("FAIL %s\n", error.what());
            failures++;
        }
    }

    std::printf("%d sounds checked, %d failed\n", checked, failures);
    return failures == 0 && checked > 0 ? 0 : 1;
}
