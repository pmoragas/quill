# Quill on Android

The Android app is the same code as the desktop app, built with Tauri 2. It keeps its notes in a folder private to the app and fills it through [sync](SYNC-SPEC.md), so there is no folder to choose.

## Install

1. Download `Quill_<version>_android-arm64.apk` from the [latest release](https://github.com/pmoragas/quill/releases/latest) on the phone.
2. Open it. Android asks to allow installs from this source (your browser or file manager); allow it for this install.
3. Open Quill, tap **Sync settings…**, paste this phone's token (the server address is built in), tick **Sync this folder**, and save. The first sync shows what it will copy and waits for your confirmation.

The APK is for 64-bit ARM phones, which is almost every phone made since 2017. Updating means installing a newer APK over the old one; notes are kept.

## Using it

- Tap the small handle at the top of the screen to show the bar: note list (☰), title, Read/Write, and all actions (?).
- Choosing a note closes the list.
- No folder picker and no PDF export on the phone; export from the desktop.

## Build it yourself

Needs JDK 17, the Android SDK with platform 35 or 36, build-tools 35.0.0 and NDK 27 (Android Studio is not required), and the Rust target:

```sh
rustup target add aarch64-linux-android
```

Put the paths in `~/.config/quill/android-env.sh`:

```sh
export JAVA_HOME="$HOME/jdk"
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

Android only installs signed apps, and updates must use the same key. Create the key once and keep it safe; **if it is lost, installed copies can only be replaced by uninstalling first** (notes are in the cloud, so nothing is lost, but the app must be set up again):

```sh
keytool -genkeypair -keystore ~/.config/quill/quill-release.keystore -alias quill \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Quill"
```

Write the key's location and password in `~/.config/quill/android-signing.env` (readable only by you):

```sh
KEYSTORE=/home/you/.config/quill/quill-release.keystore
KEY_ALIAS=quill
KEY_PASS=<the password>
```

Then:

```sh
./scripts/build-android.sh      # writes dist-android/Quill_<version>_android-arm64.apk
```

CI builds an unsigned APK on every push to catch breakage; the signed release APK is built locally and attached to the release.

## How it differs from the desktop app

- HTTPS uses `rustls` with bundled root certificates instead of the system TLS library (see `src-tauri/Cargo.toml`).
- No window controls, folder picker, PDF export, or keyboard shortcuts; the interface switches on the Android user agent (`src/platform.ts`).
- The notes folder is `<app data>/Quill`, created on first start.
