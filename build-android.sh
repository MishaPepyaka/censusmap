#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/mobile-app"
ANDROID_DIR="$APP_DIR/android"
APK_SRC="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
BUNDLED_JDK="$ROOT_DIR/.toolchain/jdk-21"
FILE_STORE_SRC="$ROOT_DIR/data/file-store.json"
FILE_STORE_DST="$ROOT_DIR/backend/public/file-store.json"

# Force a known-good JDK for Android/Gradle builds in this repo.
if [[ -d "$BUNDLED_JDK" ]]; then
  export JAVA_HOME="$BUNDLED_JDK"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
REL_DIR="$ROOT_DIR/releases/${STAMP}_norway-house_android"
APK_DST="$REL_DIR/NorwayHouseCensusMap-debug.apk"

echo "[1/5] Sync Capacitor web assets -> Android"
cd "$APP_DIR"
if [[ -f "$FILE_STORE_SRC" ]]; then
  cp "$FILE_STORE_SRC" "$FILE_STORE_DST"
fi
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "Installing npm dependencies..."
  npm install --no-fund --no-audit
fi
npx cap sync android

echo "[2/5] Build debug APK"
cd "$ANDROID_DIR"
if ! ./gradlew assembleDebug; then
  echo "Gradle build failed. If you see 'Could not determine a usable wildcard IP', run on host machine (not restricted sandbox)." >&2
  echo "If you see 'Unsupported class file major version 70', run with JDK 21 (this script auto-uses .toolchain/jdk-21 when available)." >&2
  exit 1
fi

if [[ ! -f "$APK_SRC" ]]; then
  echo "ERROR: APK not found: $APK_SRC" >&2
  exit 1
fi

echo "[3/5] Create release folder"
mkdir -p "$REL_DIR"

echo "[4/5] Copy APK"
cp "$APK_SRC" "$APK_DST"

echo "[5/5] Write checksums + build info"
cd "$REL_DIR"
sha256sum "$(basename "$APK_DST")" > SHA256SUMS.txt
cat > BUILD_INFO.txt <<EOF
App: Norway House Census Map
Package: ca.misha.cmpblocks
VersionName: 1.1.0
VersionCode: 2
BuiltAt: $(date -Iseconds)
SourceRoot: $ROOT_DIR
EOF

echo
echo "Build complete:"
echo "  APK: $APK_DST"
echo "  Release: $REL_DIR"
