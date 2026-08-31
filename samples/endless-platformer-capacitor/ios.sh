#!/usr/bin/env bash
set -euo pipefail

SAMPLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_DIR="$(cd -- "$SAMPLE_DIR/../.." && pwd)"
WORKSPACE="@obsidian-eclipse/sample-endless-platformer-capacitor"

DOCTOR_ERRORS=()
DOCTOR_WARNINGS=()
PHYSICAL_TARGETS=()
PHYSICAL_LABELS=()
BOOTED_SIMULATORS=()
BOOTED_LABELS=()
TARGET_ARGS=()
CAPACITOR_TARGET_TABLE=""

usage() {
  cat <<'EOF'
Usage: ./ios.sh [command] [target] [SDK-version]

Without arguments, runs the doctor, discovers devices/simulators and deploys the app.

Commands:
  doctor                   Check the complete iOS development environment
  list                     List iOS devices and simulators known to Capacitor
  simulator [name|UDID]    Boot/use an iPhone simulator and install the app
  device [name|UDID]       Build and install on a physical iOS device
  build                    Build the app for the iOS Simulator without signing
  ipa                      Build an IPA (requires Apple team and signing)
  open                     Sync and open the project in Xcode
  sync                     Rebuild the web app and run cap sync

Examples:
  ./ios.sh
  ./ios.sh doctor
  ./ios.sh simulator "iPhone 17 Pro" 26.5
  ./ios.sh device 00008120-001234560123401E
EOF
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
status_ok() { printf '  [OK] %s\n' "$*"; }
status_warn() { printf '  [WARN] %s\n' "$*"; DOCTOR_WARNINGS+=("$*"); }
status_error() { printf '  [MISSING] %s\n' "$*"; DOCTOR_ERRORS+=("$*"); }

first_available_iphone_udid() {
  xcrun simctl list devices available \
    | awk '/iPhone/ { print }' \
    | grep -Eo '[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}' \
    | sed -n '1p'
}

booted_simulator_ids() {
  xcrun simctl list devices booted \
    | grep -Eo '[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}' || true
}

ios_signing_configured() {
  grep -Eq 'DEVELOPMENT_TEAM = [A-Z0-9]+' "$SAMPLE_DIR/ios/App/App.xcodeproj/project.pbxproj"
}

discover_ios_targets() {
  local line
  local id
  local booted_ids
  PHYSICAL_TARGETS=()
  PHYSICAL_LABELS=()
  BOOTED_SIMULATORS=()
  BOOTED_LABELS=()
  booted_ids="$(booted_simulator_ids)"
  while IFS= read -r line; do
    [[ "$line" == *'Target ID'* || "$line" == '---'* || -z "$line" ]] && continue
    id="$(awk '{print $NF}' <<<"$line")"
    [[ "$id" =~ ^[0-9A-Fa-f-]{20,}$ ]] || continue
    if [[ "$line" == *'(simulator)'* ]]; then
      if grep -Fxq "$id" <<<"$booted_ids"; then BOOTED_SIMULATORS+=("$id"); BOOTED_LABELS+=("$line"); fi
    else
      PHYSICAL_TARGETS+=("$id")
      PHYSICAL_LABELS+=("$line")
    fi
  done <<<"$CAPACITOR_TARGET_TABLE"
}

doctor_ios() {
  local node_major
  local available_iphone=""
  local problem
  DOCTOR_ERRORS=()
  DOCTOR_WARNINGS=()
  CAPACITOR_TARGET_TABLE=""
  printf 'iOS development environment\n'

  if [[ "$(uname -s)" == Darwin ]]; then status_ok 'macOS'; else status_error 'macOS'; fi
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if ((node_major >= 22)); then status_ok "Node.js $(node --version)"; else status_error "Node.js 22+ (found $(node --version))"; fi
  else status_error 'Node.js 22+'; fi
  if command -v npm >/dev/null 2>&1; then status_ok "npm $(npm --version)"; else status_error 'npm 10+'; fi
  if [[ -x "$REPOSITORY_DIR/node_modules/.bin/cap" ]]; then status_ok 'Capacitor CLI dependencies installed'; else status_error "Workspace dependencies; run 'npm install'"; fi

  if command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then status_ok "Xcode developer directory ($(xcode-select -p))"; else status_error "Xcode selection; run 'sudo xcode-select --switch /Applications/Xcode.app'"; fi
  if command -v xcodebuild >/dev/null 2>&1; then
    status_ok "$(xcodebuild -version | tr '\n' ' ')"
    if xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then status_ok 'Xcode first-launch setup and license'; else status_error "Xcode setup; run 'sudo xcodebuild -runFirstLaunch'"; fi
  else status_error 'Xcode'; fi
  if command -v xcrun >/dev/null 2>&1; then status_ok 'xcrun'; else status_error 'Xcode Command Line Tools (xcrun)'; fi
  if [[ -d "$SAMPLE_DIR/ios/App/App.xcodeproj" ]]; then status_ok 'Native Xcode project'; else status_error "Native project; run 'npx cap add ios'"; fi

  if [[ "${#DOCTOR_ERRORS[@]}" -eq 0 ]]; then
    if CAPACITOR_TARGET_TABLE="$(cd "$REPOSITORY_DIR" && npm exec --workspace "$WORKSPACE" -- cap run ios --list 2>/dev/null)"; then
      status_ok 'CoreSimulator/CoreDevice services reachable'
      discover_ios_targets
      available_iphone="$(first_available_iphone_udid || true)"
      if [[ -n "$available_iphone" ]]; then status_ok 'At least one iPhone Simulator runtime'; else status_warn 'No iPhone Simulator runtime installed'; fi
      status_ok "Active targets: ${#PHYSICAL_TARGETS[@]} physical, ${#BOOTED_SIMULATORS[@]} booted simulators"
      if [[ "${#PHYSICAL_TARGETS[@]}" -eq 0 && "${#BOOTED_SIMULATORS[@]}" -eq 0 && -z "$available_iphone" ]]; then status_error 'At least one connected iOS device or installed iPhone Simulator'; fi
    else status_error 'CoreSimulator/CoreDevice services; open Xcode once and verify its components'; fi
  fi

  if ! ios_signing_configured; then status_warn 'Apple development team not configured; automatic mode will use a simulator'; else status_ok 'Apple development team configured'; fi
  status_warn 'The first native build may need network access to resolve Swift packages'

  if [[ "${#DOCTOR_WARNINGS[@]}" -gt 0 ]]; then printf '\nWarnings: %s\n' "${#DOCTOR_WARNINGS[@]}"; fi
  if [[ "${#DOCTOR_ERRORS[@]}" -gt 0 ]]; then
    printf '\nDoctor found %s blocking issue(s):\n' "${#DOCTOR_ERRORS[@]}"
    for problem in "${DOCTOR_ERRORS[@]}"; do printf '  - %s\n' "$problem"; done
    return 1
  fi
  printf '\niOS doctor: ready.\n'
}

sync_web() { cd "$REPOSITORY_DIR"; npm run sync --workspace "$WORKSPACE"; }
cap_run() { cd "$REPOSITORY_DIR"; npm exec --workspace "$WORKSPACE" -- cap run ios --no-sync "$@"; }

require_ios_signing() {
  ios_signing_configured \
    || fail 'Configure an Apple development team in Xcode before building for a device or IPA.'
}

target_arguments() {
  local requested="$1"
  local sdk_version="${2:-}"
  if [[ "$requested" =~ ^[0-9A-Fa-f-]{20,}$ ]]; then TARGET_ARGS=(--target "$requested"); else
    TARGET_ARGS=(--target-name "$requested")
    if [[ -n "$sdk_version" ]]; then TARGET_ARGS+=(--target-name-sdk-version "$sdk_version"); fi
  fi
}

choose_index() {
  local prompt="$1"
  local count="$2"
  local answer
  [[ -t 0 ]] || fail 'Multiple targets found in a non-interactive shell; specify one explicitly.'
  while true; do
    printf '%s [1-%s]: ' "$prompt" "$count" >&2
    IFS= read -r answer
    if [[ "$answer" =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= count)); then printf '%s\n' "$answer"; return; fi
  done
}

auto_run() {
  local values=()
  local labels=()
  local index
  local target
  doctor_ios || exit 1
  if ios_signing_configured; then
    for ((index = 0; index < ${#PHYSICAL_TARGETS[@]}; index += 1)); do values+=("${PHYSICAL_TARGETS[$index]}"); labels+=("Physical: ${PHYSICAL_LABELS[$index]}"); done
  fi
  for ((index = 0; index < ${#BOOTED_SIMULATORS[@]}; index += 1)); do values+=("${BOOTED_SIMULATORS[$index]}"); labels+=("Booted simulator: ${BOOTED_LABELS[$index]}"); done

  if [[ "${#values[@]}" -eq 0 ]]; then
    target="$(first_available_iphone_udid)"
    printf '\nNo active target; booting iPhone Simulator %s\n' "$target"
    xcrun simctl boot "$target" >/dev/null 2>&1 || true
    open -a Simulator
    xcrun simctl bootstatus "$target" -b
  elif [[ "${#values[@]}" -eq 1 ]]; then
    target="${values[0]}"
    printf '\nSelected automatically: %s\n' "${labels[0]}"
  else
    printf '\nAvailable active targets:\n'
    for ((index = 0; index < ${#labels[@]}; index += 1)); do printf '  %s) %s\n' "$((index + 1))" "${labels[$index]}"; done
    index="$(choose_index 'Select a target' "${#values[@]}")"
    target="${values[$((index - 1))]}"
  fi
  sync_web
  cap_run --target "$target"
}

command_name="${1:-auto}"
target="${2:-}"
sdk_version="${3:-}"
case "$command_name" in
  auto) auto_run ;;
  help|-h|--help) usage ;;
  doctor) doctor_ios ;;
  list) cd "$REPOSITORY_DIR"; npm exec --workspace "$WORKSPACE" -- cap run ios --list ;;
  sync) sync_web ;;
  open) doctor_ios || exit 1; sync_web; cd "$REPOSITORY_DIR"; npm exec --workspace "$WORKSPACE" -- cap open ios ;;
  build)
    doctor_ios || exit 1
    sync_web
    derived_data="$(mktemp -d -t endless-shark-ios-build.XXXXXX)"
    xcodebuild -project "$SAMPLE_DIR/ios/App/App.xcodeproj" -scheme App -configuration Debug \
      -sdk iphonesimulator -derivedDataPath "$derived_data" CODE_SIGNING_ALLOWED=NO build
    printf '\nSimulator app: %s\n' "$derived_data/Build/Products/Debug-iphonesimulator/App.app"
    ;;
  ipa) doctor_ios || exit 1; require_ios_signing; cd "$REPOSITORY_DIR"; npm run build:ipa --workspace "$WORKSPACE" ;;
  device)
    doctor_ios || exit 1
    require_ios_signing
    sync_web
    if [[ -n "$target" ]]; then target_arguments "$target" "$sdk_version"; cap_run "${TARGET_ARGS[@]}"; else cap_run; fi
    ;;
  simulator)
    doctor_ios || exit 1
    if [[ -z "$target" ]]; then
      target="$(first_available_iphone_udid)"
      [[ -n "$target" ]] || fail 'No iPhone Simulator is available.'
      xcrun simctl boot "$target" >/dev/null 2>&1 || true
      open -a Simulator
      xcrun simctl bootstatus "$target" -b
    fi
    target_arguments "$target" "$sdk_version"
    sync_web
    cap_run "${TARGET_ARGS[@]}"
    ;;
  *) usage >&2; exit 2 ;;
esac
