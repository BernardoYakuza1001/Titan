# Titan POS — Android client (terminal app)

The on-device half of Project Titan: a hardened-launcher POS **client skeleton**
that runs on Android 11+ (minSdk 30). It shows the real terminal flow — kiosk
launcher → admin login → 101.x profile selection → a transaction that streams the
actual saga states — driven by an on-device simulation that mirrors the verified
backend (`apps/backend`).

## Scope (read this)

This is a **client skeleton**, not a production payment terminal:
- The transaction flow is **simulated locally** (`TitanFlow.kt`) — it reproduces
  the backend state machine, the blocking compliance/risk gates, and the
  irreversible "bright line", but **reads no card, moves no money, sends no
  crypto**.
- Admin login uses a demo PIN; production authenticates the `TERMINAL_ADMIN`
  role against the backend Auth service over mTLS.
- EMV/NFC hardware, attestation, OTA, and the live payment/exchange/custody
  integrations from the blueprint are **not** wired here.

It is a real, installable APK that demonstrates the terminal UX and flow shape.

This module is **framework-only Java** — no Kotlin, no AndroidX, no Gradle
dependency. That keeps it buildable by the raw Android toolchain alone (handy in
locked-down environments where Gradle's daemon can't start).

### Option A — Gradle-free (raw toolchain)
Needs only a JDK 17 + the Android SDK build-tools 34 + `platform-34`
(`android.jar`). The pipeline is `aapt2 compile → aapt2 link → javac → d8 →
zipalign → apksigner`; see `build-apk.ps1` at the repo toolchain dir for a
working Windows script. Output: `pos-app/build/outputs/apk/debug/pos-app-debug.apk`.

### Option B — GitHub Actions (no local toolchain needed)
Push the repo and run the **“Build Titan POS APK”** workflow
(`.github/workflows/android.yml`, Actions tab → Run workflow). It builds on a
runner with the Android SDK and uploads `titan-pos-debug-apk` as a downloadable
artifact.

### Option C — Gradle / Android Studio
Requires JDK 17 + Android SDK (platform-34, build-tools 34.0.0). Open
`apps/android` in Android Studio and Run, or:
```bash
cd apps/android
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
./gradlew :pos-app:assembleDebug
```

## Install on a device

```bash
adb install -r pos-app/build/outputs/apk/debug/pos-app-debug.apk
```
Or copy the `.apk` to the device and tap it (enable **Install unknown apps** for
your file manager). It's a **debug-signed** APK — fine for testing, not for Play
Store distribution (sign with a release keystore for that).

## Project layout
```
apps/android/
├─ settings.gradle.kts · build.gradle.kts · gradle.properties   # npm-independent Gradle build
└─ pos-app/
   ├─ build.gradle.kts                                          # AGP 8.5.2 · Kotlin 1.9.24 · compileSdk 34
   └─ src/main/
      ├─ AndroidManifest.xml                                    # kiosk HOME launcher + activities
      ├─ java/io/titan/pos/
      │  ├─ LauncherActivity.kt                                 # kiosk home + admin login
      │  ├─ ProfileActivity.kt                                  # 101.x selector + run transaction
      │  ├─ TitanFlow.kt                                        # local saga simulation (mirrors backend)
      │  └─ profile/ProfileVerifier.kt                          # signed-profile verifier (Phase 2/3)
      └─ res/                                                    # layouts, theme, vector launcher icon
```
