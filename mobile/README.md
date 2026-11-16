# Sertum for Android

The Android companion is always a client of `sertumd` on a PC, never a host for
agents or sessions. It can read conversations, send messages and files, answer
approvals, and manage supported session controls. Terminals, desktop settings,
diagnostics, and repairs stay on the PC.

To pair, turn on **Settings > Phones** in the desktop app and scan the one-time
code it shows. More PCs can be added from the phone's **PCs** page. Their live
sessions share one list; sessions on connected PCs are shown by default, with
cached offline sessions available through **Show offline**. Connection and retry
details live on the **PCs** page.

The security model, supported actions, architecture, and verification results
are in [docs/mobile.md](../docs/mobile.md).

```
scripts/make-icons.mjs   All Android art, generated from assets/icon-windows.svg
assets/                  Generated Play Store icon
src/                     The app: connection, window.sertum over it, and its screens
spikes/                  Throwaway: harness, test server, CDP driver
android/                 Capacitor's Android project, plus the native plugins
```

## Setup

Capacitor needs Node 22+ and JDK 21, but desktop packaging needs Node 20, so set
them per terminal rather than globally:

```powershell
$env:PATH = "$env:LOCALAPPDATA\Author Software\nvm\installs\v26.7.0;" + $env:PATH
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\jdk-21.0.13+9"
cd mobile
npm install
npm run apk          # android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run icons` regenerates the art after the desktop icon changes.

## Running the spikes

Build with `VITE_SPIKE=1` in the environment to get the harness instead of the app.
With it open on a device:

```powershell
node spikes/server.mjs                          # prints the pin; loopback only
node spikes/drive.mjs "spike.pinTest('wss://10.0.2.2:8843','<pin>','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')"
node spikes/drive.mjs "spike.run({items:1000})" --throttle=4
node spikes/drive.mjs "spike.browse('_sertum-spike._tcp.',15000)"
```

`10.0.2.2` is the host as an emulator sees it. On a real phone, run the server
with `--host <PC's Wi-Fi address>` and use that address instead. Add `--serial=X`
to `drive.mjs` when several devices are attached.
