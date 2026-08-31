#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPOSITORY_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE="@obsidian-eclipse/sample-endless-platformer-capacitor"
ANDROID_DIR="$SCRIPT_DIR/android"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
JAVA21_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
SERIAL="${ANDROID_SERIAL:-}"

usage() {
  cat <<'EOF'
Usage: ./android.sh [--serial=<id>]

Build, install and launch the debug APK on a connected Android device or
running emulator. With multiple targets, an interactive prompt selects one.

Options:
  --serial=<id>  Select an adb target explicitly (or set ANDROID_SERIAL)
  -h, --help     Show this help
EOF
}

for argument in "$@"; do
  case "$argument" in
    --serial=*) SERIAL="${argument#--serial=}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Error: unknown argument %s\n\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -x "$JAVA21_HOME/bin/java" ]]; then
  printf 'Error: JDK 21 not found at %s\n' "$JAVA21_HOME" >&2
  printf 'Install it with: brew install openjdk@21\n' >&2
  exit 1
fi
export JAVA_HOME="$JAVA21_HOME"

if command -v adb >/dev/null 2>&1; then
  ADB="$(command -v adb)"
elif [[ -x "${ANDROID_HOME:-}/platform-tools/adb" ]]; then
  ADB="$ANDROID_HOME/platform-tools/adb"
elif [[ -x "${ANDROID_SDK_ROOT:-}/platform-tools/adb" ]]; then
  ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
else
  printf 'Error: adb not found. Add Android SDK platform-tools to PATH.\n' >&2
  exit 1
fi

if [[ ! -x "$ANDROID_DIR/gradlew" ]]; then
  printf 'Error: Android Gradle project not found at %s\n' "$ANDROID_DIR" >&2
  exit 1
fi

printf '=== Connected Android devices / emulators ===\n\n'
"$ADB" devices -l
printf '\n'

SERIALS=()
LABELS=()
while IFS= read -r line; do
  serial="$(sed -E 's/[[:space:]]+device[[:space:]].*$//' <<<"$line")"
  model="$(grep -oE 'model:[^ ]+' <<<"$line" | sed 's/model://' || true)"
  [[ -n "$serial" ]] || continue
  SERIALS+=("$serial")
  LABELS+=("${serial}${model:+ ($model)}")
done < <("$ADB" devices -l | grep -v '^List' | grep -v '^$' | grep '[[:space:]]device ' || true)

count="${#SERIALS[@]}"
if ((count == 0)); then
  printf 'Error: no device found. Connect a device or start an emulator.\n' >&2
  exit 1
elif [[ -n "$SERIAL" ]]; then
  TARGET=""
  for index in "${!SERIALS[@]}"; do
    if [[ "${SERIALS[$index]}" == "$SERIAL" ]]; then
      TARGET="$SERIAL"
      printf 'Selected (--serial/ANDROID_SERIAL): %s\n' "${LABELS[$index]}"
      break
    fi
  done
  if [[ -z "$TARGET" ]]; then
    printf "Error: serial '%s' is not connected. Available targets:\n" "$SERIAL" >&2
    printf '  %s\n' "${SERIALS[@]}" >&2
    exit 1
  fi
elif ((count == 1)); then
  TARGET="${SERIALS[0]}"
  printf 'Auto-selected: %s\n' "${LABELS[0]}"
elif [[ ! -t 0 ]]; then
  printf 'Error: %s targets connected and no TTY available for selection.\n' "$count" >&2
  printf 'Pass --serial=<id> or set ANDROID_SERIAL. Available targets:\n' >&2
  printf '  %s\n' "${SERIALS[@]}" >&2
  exit 1
else
  printf 'Select target:\n'
  for index in "${!LABELS[@]}"; do
    printf '  %s) %s\n' "$((index + 1))" "${LABELS[$index]}"
  done
  printf '\n'
  read -rp "Choice [1-$count]: " choice
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || ((choice < 1 || choice > count)); then
    printf "Error: invalid choice '%s'.\n" "$choice" >&2
    exit 1
  fi
  TARGET="${SERIALS[$((choice - 1))]}"
fi

printf 'Target: %s\n\n' "$TARGET"

printf '=== Building web bundle and syncing Android ===\n'
cd "$REPOSITORY_DIR"
npm run sync --workspace "$WORKSPACE"

printf '=== Building debug APK with JDK 21 ===\n'
cd "$ANDROID_DIR"
./gradlew assembleDebug

if [[ ! -f "$APK" ]]; then
  printf 'Error: APK not found at %s\n' "$APK" >&2
  exit 1
fi

APP_ID="$(grep -oE 'applicationId "[^"]+"' "$ANDROID_DIR/app/build.gradle" | head -n 1 | sed -E 's/applicationId "([^"]+)"/\1/')"
NAMESPACE="$(grep -oE 'namespace = "[^"]+"' "$ANDROID_DIR/app/build.gradle" | head -n 1 | sed -E 's/namespace = "([^"]+)"/\1/')"
if [[ -z "$APP_ID" || -z "$NAMESPACE" ]]; then
  printf 'Error: could not read applicationId or namespace from android/app/build.gradle.\n' >&2
  exit 1
fi

printf '=== Installing on %s ===\n' "$TARGET"
"$ADB" -s "$TARGET" install -r "$APK"

printf '=== Launching %s ===\n' "$APP_ID"
"$ADB" -s "$TARGET" shell am force-stop "$APP_ID"
"$ADB" -s "$TARGET" shell am start -n "$APP_ID/$NAMESPACE.MainActivity"

printf '\nDone. App running on %s.\n' "$TARGET"
