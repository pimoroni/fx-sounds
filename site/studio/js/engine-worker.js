import createEngine from "../engine/fxengine.js";

const ready = createEngine();

self.addEventListener("message", async ({ data }) => {
  const engine = await ready;
  const result = engine.render(data.patch, data.oversampling);
  if (result.error) {
    self.postMessage({ id: data.id, error: result.error });
    return;
  }
  const sounds = result.sounds.map(sound => ({
    name: sound.name,
    length: sound.length,
    rate: sound.rate,
    dry: sound.dry,
    wet: sound.wet,
    warnings: sound.warnings,
  }));
  const transfers = sounds.flatMap(sound => [sound.dry.buffer, sound.wet.buffer]);
  self.postMessage({ id: data.id, sounds }, transfers);
});
