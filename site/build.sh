#!/bin/sh
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
site="$root/_site"

if ! command -v emcmake >/dev/null; then
  echo "emcmake not found: install and activate emsdk (source emsdk_env.sh) to build the studio engine" >&2
  exit 1
fi

cmake -S "$root" -B "$root/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$root/build" -j
ctest --test-dir "$root/build" --output-on-failure

emcmake cmake -S "$root" -B "$root/build-wasm" -DCMAKE_BUILD_TYPE=Release
cmake --build "$root/build-wasm" -j

rm -rf "$site"
mkdir -p "$site/sounds" "$site/studio/engine"
"$root/build/fx-sounds" -p -o "$site/sounds" "$root"/presets/*.ini
cp "$root/site/index.html" "$site/"
cp -R "$root/site/studio/." "$site/studio/"
cp "$root/build-wasm/fxengine.js" "$root/build-wasm/fxengine.wasm" "$site/studio/engine/"
cp "$root/LICENSE-SOUNDS" "$site/sounds/"
(cd "$site/sounds" && zip -q -X ../fx-sounds.zip ./*.wav LICENSE-SOUNDS)
