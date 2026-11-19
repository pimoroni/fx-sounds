#include "patch.h"
#include "preview.h"
#include "synth.h"
#include "wav.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

int usage()
{
    std::fprintf(stderr,
                 "usage: fx-sounds [-o outdir] [-s sound]... [-p] patches.ini...\n"
                 "  -o outdir  output directory (default: out)\n"
                 "  -s sound   only render the named sound, may be repeated\n"
                 "  -p         also write preview images and sounds.json\n");
    return 2;
}

std::string json_string(const std::string &text)
{
    std::string out = "\"";
    for (char c : text) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (static_cast<unsigned char>(c) < 0x20) {
            char escaped[8];
            std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
            out += escaped;
        } else {
            out += c;
        }
    }
    return out + "\"";
}

std::string manifest_entry(const Sound &sound, const std::string &group, double length)
{
    std::ostringstream entry;
    entry << "  {\"name\": " << json_string(sound.name)
          << ", \"group\": " << json_string(group)
          << ", \"description\": " << json_string(sound.description)
          << ", \"length\": " << length
          << ", \"rate\": " << sound.rate
          << ", \"dry\": " << json_string(sound.name + "_dry.wav")
          << ", \"wet\": " << json_string(sound.name + "_wet.wav")
          << ", \"dry_scope\": " << json_string(sound.name + "_dry.svg")
          << ", \"wet_scope\": " << json_string(sound.name + "_wet.svg")
          << ", \"spectrogram\": " << json_string(sound.name + "_spectrogram.png") << "}";
    return entry.str();
}

int main(int argc, char **argv)
{
    fs::path output_dir = "out";
    std::set<std::string> only;
    std::vector<std::string> patch_files;
    bool previews = false;

    for (int i = 1; i < argc; i++) {
        std::string argument = argv[i];
        if ((argument == "-o" || argument == "-s") && i + 1 < argc) {
            if (argument == "-o") {
                output_dir = argv[++i];
            } else {
                only.insert(argv[++i]);
            }
        } else if (argument == "-p") {
            previews = true;
        } else if (argument == "-h" || argument == "--help" || argument.front() == '-') {
            return usage();
        } else {
            patch_files.push_back(argument);
        }
    }
    if (patch_files.empty()) {
        return usage();
    }

    try {
        fs::create_directories(output_dir);
        std::vector<std::string> manifest;
        for (const std::string &patch_file : patch_files) {
            std::string group = fs::path(patch_file).stem().string();
            for (const Sound &sound : load_patches(patch_file)) {
                if (!only.empty() && !only.count(sound.name)) {
                    continue;
                }
                Rendered rendered = render(sound);
                for (const std::string &warning : rendered.warnings) {
                    std::fprintf(stderr, "warning: %s: %s\n", sound.name.c_str(), warning.c_str());
                }
                fs::path base = output_dir / sound.name;
                write_looping_wav(base.string() + "_dry.wav", rendered.dry, sound.rate);
                write_looping_wav(base.string() + "_wet.wav", rendered.wet, sound.rate);
                if (previews) {
                    size_t start = scope_start(rendered.dry, sound.rate);
                    write_scope_svg(base.string() + "_dry.svg", rendered.dry, start, sound.rate);
                    write_scope_svg(base.string() + "_wet.svg", rendered.wet, start, sound.rate);
                    write_spectrogram_png(base.string() + "_spectrogram.png", rendered.dry, sound.rate);
                }
                manifest.push_back(manifest_entry(sound, group, rendered.length));
                std::printf("%-28s %6.3fs  %7zu samples\n", sound.name.c_str(), rendered.length, rendered.dry.size());
            }
        }
        if (!only.empty() && manifest.empty()) {
            std::fprintf(stderr, "no matching sounds\n");
            return 1;
        }
        if (previews) {
            std::ofstream json(output_dir / "sounds.json");
            json << "[\n";
            for (size_t i = 0; i < manifest.size(); i++) {
                json << manifest[i] << (i + 1 < manifest.size() ? ",\n" : "\n");
            }
            json << "]\n";
            if (!json) {
                throw std::runtime_error("cannot write sounds.json");
            }
        }
    } catch (const std::exception &error) {
        std::fprintf(stderr, "error: %s\n", error.what());
        return 1;
    }
    return 0;
}
