# Endless Shark for Capacitor

Native Android and iOS host for the browser sample in `../endless-platformer`. The web build uses
relative asset paths and is copied to `www/` before every Capacitor sync.

## First-time platform setup

From the repository root, install the workspace dependencies and generate the native projects:

```bash
npm install
npm exec --workspace @obsidian-eclipse/sample-endless-platformer-capacitor -- cap add android
npm exec --workspace @obsidian-eclipse/sample-endless-platformer-capacitor -- cap add ios
```

The generated `android/` and `ios/` projects are committed, so these two `cap add` commands are only
needed when recreating a platform from scratch.

## Build an APK

Android requires Android Studio, an installed Android SDK and Java 21. The Android launcher selects
the Homebrew JDK 21 automatically when a newer system JDK is selected by default.

```bash
npm run build:apk --workspace @obsidian-eclipse/sample-endless-platformer-capacitor
```

For signing or device deployment, open the synchronized project:

```bash
npm run open:android --workspace @obsidian-eclipse/sample-endless-platformer-capacitor
```

## Build an IPA

iOS builds require macOS, Xcode and a configured Apple development team/signing identity.

```bash
npm run build:ipa --workspace @obsidian-eclipse/sample-endless-platformer-capacitor
```

You can configure signing and archive/export options in Xcode:

```bash
npm run open:ios --workspace @obsidian-eclipse/sample-endless-platformer-capacitor
```

Both native projects support portrait and landscape orientations.

## Device deployment scripts

The sample includes executable Android and iOS deployment helpers. Both rebuild and synchronize
the web bundle before installing it:

```bash
./android.sh
./ios.sh
```

The Android script follows a scripted deployment flow: it selects the Homebrew JDK 21,
discovers connected `adb` targets, builds and syncs the web app, creates the debug APK, installs it
and launches the activity. One connected target is selected automatically; multiple targets
produce an interactive menu. For a non-interactive or explicit selection, pass its serial:

```bash
./android.sh --serial=R5CT123456A
ANDROID_SERIAL=emulator-5554 ./android.sh
```

The device or emulator must already be connected and visible in `adb devices`. The iOS helper
retains its diagnostic and explicit-target commands:

```bash
./ios.sh doctor
./ios.sh list
./ios.sh simulator [name-or-UDID] [iOS-version]
./ios.sh device [name-or-UDID]
```

The same helpers can be invoked from the repository root:

```bash
npm run android
npm run android -- --serial=R5CT123456A
npm run ios
npm run ios -- simulator "iPhone 17 Pro" 26.5
npm run ios -- device
```

Use the workspace `build:apk` command for a standalone release APK and `./ios.sh build` for an
unsigned Simulator `.app`. Creating an IPA with `./ios.sh ipa` still requires an Apple development
team and signing identity.
