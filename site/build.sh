#!/bin/sh
set -e

root=$(cd "$(dirname "$0")/.." && pwd)
site="$root/_site"

cmake -S "$root" -B "$root/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$root/build" -j
ctest --test-dir "$root/build" --output-on-failure

rm -rf "$site"
mkdir -p "$site/sounds"
"$root/build/fx-sounds" -p -o "$site/sounds" "$root"/presets/*.ini
cp "$root/site/index.html" "$site/"
cp "$root/LICENSE-SOUNDS" "$site/sounds/"
(cd "$site/sounds" && zip -q -X ../fx-sounds.zip ./*.wav LICENSE-SOUNDS)
