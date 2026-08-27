#!/bin/bash
# Regenerates assets/icon.png and assets/icon.icns from scripts/make-icon.swift.
# macOS-only (needs swift + iconutil); the committed assets/ output is what the
# build actually consumes, so other platforms never need to run this.
set -euo pipefail
cd "$(dirname "$0")/.."

swift scripts/make-icon.swift assets/icon.png

ICONSET="$(mktemp -d)/Sertum.iconset"
mkdir -p "$ICONSET"
for spec in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
            "128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" \
            "512:512x512" "1024:512x512@2x"; do
  px="${spec%%:*}"; name="${spec##*:}"
  sips -z "$px" "$px" assets/icon.png --out "$ICONSET/icon_${name}.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o assets/icon.icns
rm -rf "$(dirname "$ICONSET")"
echo "[build-icon] wrote assets/icon.icns ($(du -h assets/icon.icns | cut -f1))"
