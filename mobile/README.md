# Sertum for Android

The phone client: always a client of a `sertumd` on a PC, never a host. Only
spikes exist so far. Design and results are in [docs/mobile.md](../docs/mobile.md).

```
scripts/make-icons.mjs   All Android art, generated from assets/icon-windows.svg
assets/                  Generated Play Store icon
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

With the app open on a device:

```powershell
node spikes/server.mjs                          # prints the pin; loopback only
node spikes/drive.mjs "spike.pinTest('wss://10.0.2.2:8843','<pin>','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')"
node spikes/drive.mjs "spike.run({items:1000})" --throttle=4
node spikes/drive.mjs "spike.browse('_sertum-spike._tcp.',15000)"
```

`10.0.2.2` is the host as an emulator sees it. On a real phone, run the server
with `--host <PC's Wi-Fi address>` and use that address instead. Add `--serial=X`
to `drive.mjs` when several devices are attached.
