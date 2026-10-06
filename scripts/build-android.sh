#!/usr/bin/env bash
# Builds a signed Android APK (64-bit ARM) into dist-android/.
# Needs the Android toolchain and the signing key in ~/.config/quill (see docs/ANDROID.md).
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
. "$HOME/.config/quill/android-env.sh"
. "$HOME/.config/quill/android-signing.env"
set +a
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

npx tauri android build --apk --target aarch64

version=$(node -p "require('./package.json').version")
unsigned=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
tools="$ANDROID_HOME/build-tools/35.0.0"
mkdir -p dist-android
aligned=dist-android/aligned.apk
final="dist-android/Quill_${version}_android-arm64.apk"

"$tools/zipalign" -f -p 4 "$unsigned" "$aligned"
"$tools/apksigner" sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:KEY_PASS --key-pass env:KEY_PASS --out "$final" "$aligned"
rm -f "$aligned" "$final.idsig"

"$tools/apksigner" verify --verbose "$final" | head -4
echo "Built $final"
