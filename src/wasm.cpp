#include "patch.h"
#include "synth.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

using emscripten::val;

namespace {

val copy_samples(const std::vector<float> &samples)
{
    return val(emscripten::typed_memory_view(samples.size(), samples.data())).call<val>("slice");
}

val render_text(const std::string &text, int oversampling)
{
    val result = val::object();
    try {
        val sounds = val::array();
        for (Sound sound : parse_patches(text, "patch")) {
            if (oversampling > 0) {
                sound.oversampling = oversampling;
            }
            Rendered rendered = render(sound);
            val entry = val::object();
            entry.set("name", sound.name);
            entry.set("length", rendered.length);
            entry.set("rate", sound.rate);
            entry.set("dry", copy_samples(rendered.dry));
            entry.set("wet", copy_samples(rendered.wet));
            val warnings = val::array();
            for (const std::string &warning : rendered.warnings) {
                warnings.call<void>("push", warning);
            }
            entry.set("warnings", warnings);
            sounds.call<void>("push", entry);
        }
        result.set("sounds", sounds);
    } catch (const std::exception &error) {
        result.set("error", std::string(error.what()));
    }
    return result;
}

}

EMSCRIPTEN_BINDINGS(fxengine)
{
    emscripten::function("render", &render_text);
}
