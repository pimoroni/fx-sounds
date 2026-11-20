export function encodeWav(samples, rate, looping) {
  const dataSize = samples.length * 2;
  const smplSize = looping ? 60 : 0;
  const buffer = new ArrayBuffer(12 + 24 + 8 + dataSize + (looping ? 8 + smplSize : 0));
  const view = new DataView(buffer);
  let offset = 0;
  const tag = text => {
    for (const character of text) {
      view.setUint8(offset++, character.charCodeAt(0));
    }
  };
  const u16 = value => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const u32 = value => {
    view.setUint32(offset, value, true);
    offset += 4;
  };

  tag("RIFF");
  u32(buffer.byteLength - 8);
  tag("WAVE");
  tag("fmt ");
  u32(16);
  u16(1);
  u16(1);
  u32(rate);
  u32(rate * 2);
  u16(2);
  u16(16);
  tag("data");
  u32(dataSize);
  for (const sample of samples) {
    view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
    offset += 2;
  }
  if (looping) {
    tag("smpl");
    u32(smplSize);
    for (const value of [0, 0, Math.round(1e9 / rate), 60, 0, 0, 0, 1, 0, 0, 0, 0, samples.length - 1, 0, 0]) {
      u32(value);
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}
