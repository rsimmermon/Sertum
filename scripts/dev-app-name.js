#!/usr/bin/env node
/**
 * Make `electron-forge start` present as "Sertum" instead of "Electron".
 *
 * In development the running bundle is node_modules/electron/dist/Electron.app,
 * and macOS reads its identity straight off that bundle before any of our JS
 * runs — so app.setName() cannot reach these surfaces. Three separate strings
 * feed three separate places:
 *
 *   menu bar   <- CFBundleName / CFBundleDisplayName
 *   Dock icon  <- Contents/Resources/electron.icns
 *   Dock label <- the bundle path, via a Dock-side cache
 *
 * That last one is the stubborn one: the Dock pins a name to the bundle path
 * and keeps serving it after the bundle is corrected, surviving `killall Dock`
 * and an lsregister refresh. Renaming the .app directory sidesteps the cache
 * entirely by presenting a path the Dock has never seen, which is cheaper and
 * far less invasive than rebuilding the LaunchServices database.
 *
 * Renaming the executable means also updating CFBundleExecutable, electron's
 * path.txt (how Forge locates the binary), and re-signing, since the ad-hoc
 * signature seals the executable name.
 *
 * The same bundle also has to declare NSAppleEventsUsageDescription, or macOS
 * refuses every Apple event we send with -1743 and never lists Sertum under
 * Privacy & Security > Automation -- leaving no toggle to grant. Electron's
 * stock Info.plist ships usage strings for camera, mic and Bluetooth but not
 * that one.
 *
 * Packaged builds need none of this: Forge writes the correct bundle from
 * packagerConfig (see `extendInfo` in forge.config.ts for the same key). This
 * only touches the throwaway dev copy, and re-applies itself after any
 * `npm install` restores the pristine bundle.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Sertum';
const BUNDLE_ID = 'dev.sertum.app';
// Keep in step with packagerConfig.extendInfo in forge.config.ts.
const APPLE_EVENTS_REASON =
  'Sertum sends Apple events to your terminal so it can bring the window '
  + 'and tab of an agent session running there to the front.';

if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'node_modules', 'electron', 'dist');
const pristineApp = path.join(distDir, 'Electron.app');
const appDir = path.join(distDir, `${APP_NAME}.app`);

if (fs.existsSync(pristineApp)) {
  // A reinstall restores Electron.app; any previously renamed copy is stale.
  if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
  fs.renameSync(pristineApp, appDir);
} else if (!fs.existsSync(appDir)) {
  // Neither the pristine name nor the current one: the app was renamed since
  // this bundle was branded. Adopt whatever single .app is in dist rather than
  // stranding the previous name, so a rename needs no manual cleanup.
  const strays = fs
    .readdirSync(distDir)
    .filter((entry) => entry.endsWith('.app'));
  if (strays.length === 1) fs.renameSync(path.join(distDir, strays[0]), appDir);
}
const plist = path.join(appDir, 'Contents', 'Info.plist');
const macOsDir = path.join(appDir, 'Contents', 'MacOS');
const bundleIcon = path.join(appDir, 'Contents', 'Resources', 'electron.icns');
const ourIcon = path.join(root, 'assets', 'icon.icns');
const pathTxt = path.join(root, 'node_modules', 'electron', 'path.txt');

if (!fs.existsSync(plist)) process.exit(0);

const get = (key) => {
  try {
    // A missing key is an expected answer here, not a problem to report, so
    // PlistBuddy's complaint about it stays off the console.
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};
const set = (key, value) => {
  // PlistBuddy parses the command as one string, so a value with spaces has
  // to arrive quoted or only its first word lands.
  const quoted = JSON.stringify(value);
  const verb = get(key) === null ? `Add :${key} string ${quoted}` : `Set :${key} ${quoted}`;
  execFileSync('/usr/libexec/PlistBuddy', ['-c', verb, plist]);
};

const changed = [];

// 1. Menu-bar name and identity.
const names = {
  CFBundleName: APP_NAME,
  CFBundleDisplayName: APP_NAME,
  CFBundleIdentifier: BUNDLE_ID,
};
if (!Object.entries(names).every(([k, v]) => get(k) === v)) {
  for (const [key, value] of Object.entries(names)) set(key, value);
  changed.push('name');
}

// 2. Permission to send Apple events at all.
if (get('NSAppleEventsUsageDescription') !== APPLE_EVENTS_REASON) {
  set('NSAppleEventsUsageDescription', APPLE_EVENTS_REASON);
  changed.push('apple events');
}

// 3. Dock icon. Overwrites the file Info.plist already points at, so the
//    CFBundleIconFile key stays valid and untouched.
if (fs.existsSync(ourIcon) && fs.existsSync(bundleIcon)
    && !fs.readFileSync(ourIcon).equals(fs.readFileSync(bundleIcon))) {
  fs.copyFileSync(ourIcon, bundleIcon);
  changed.push('icon');
}

// 4. Dock label, which follows the executable name.
const pristine = path.join(macOsDir, 'Electron');
const renamed = path.join(macOsDir, APP_NAME);
if (fs.existsSync(pristine)) {
  // A reinstall restores Electron alongside any previously renamed copy.
  if (fs.existsSync(renamed)) fs.rmSync(renamed);
  fs.renameSync(pristine, renamed);
  changed.push('executable');
} else if (!fs.existsSync(renamed)) {
  // Renamed under a previous app name; adopt it rather than leaving the plist
  // pointing at an executable that no longer exists under that name.
  const strays = fs.readdirSync(macOsDir);
  if (strays.length === 1) {
    fs.renameSync(path.join(macOsDir, strays[0]), renamed);
    changed.push('executable');
  }
}
if (get('CFBundleExecutable') !== APP_NAME) set('CFBundleExecutable', APP_NAME);

// path.txt must have no trailing newline: electron reads it verbatim as a path.
const wantPath = `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;
const havePath = fs.existsSync(pathTxt) ? fs.readFileSync(pathTxt, 'utf8') : '';
if (havePath !== wantPath) fs.writeFileSync(pathTxt, wantPath);

if (havePath !== wantPath) changed.push('bundle path');

if (!changed.length) process.exit(0);

// Renaming the executable invalidates the ad-hoc signature it was sealed with.
try {
  execFileSync('codesign', ['--force', '--sign', '-', appDir], { stdio: 'ignore' });
} catch (err) {
  console.error('[dev-app-name] re-sign failed; run `npm install` to restore:', err.message);
  process.exit(1);
}

// LaunchServices caches name and icon against the bundle path.
try {
  fs.utimesSync(appDir, new Date(), new Date());
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/'
    + 'LaunchServices.framework/Support/lsregister', ['-f', appDir], { stdio: 'ignore' });
} catch { /* cache busting is best-effort */ }

console.log(`[dev-app-name] dev bundle branded as ${APP_NAME} (${changed.join(', ')})`);
// TCC pins an ad-hoc grant to the code signature, so the re-sign above voids
// any Automation permission the previous bundle had been given.
console.log('[dev-app-name] re-signed; if Automation was already granted, run '
  + `\`tccutil reset AppleEvents ${BUNDLE_ID}\` and allow it again.`);
