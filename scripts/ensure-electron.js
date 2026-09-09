#!/usr/bin/env node
/**
 * Make sure the Electron binary is on disk before anything needs it.
 *
 * Electron 42 dropped the `postinstall` script that used to download the
 * binary during `npm install` (electron/electron#49328, a response to the npm
 * supply-chain attacks that used install scripts as their vector). The package
 * now fetches itself the first time `require('electron')` is asked for the
 * executable's path -- which is what `electron-forge start` does -- so on
 * Windows and Linux a fresh checkout simply downloads at the first `npm start`.
 *
 * macOS is different because dev-app-name.js brands the dev bundle from
 * `postinstall`, before anything has asked, and expects
 * node_modules/electron/dist to exist. On a fresh install it did not, and
 * `npm install` failed with ENOENT on that directory. Asking here, first, is
 * what Electron's own postinstall used to guarantee.
 *
 * `require('electron')` is used rather than install.js directly because it
 * goes by path.txt: a dev bundle already renamed to Sertum.app is left alone,
 * where install.js's own check would see an unexpected path and fetch again.
 */
const fs = require('node:fs');
const path = require('node:path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const hadBinary = fs.existsSync(path.join(electronDir, 'path.txt'));

try {
  const executable = require(electronDir);
  if (!hadBinary) {
    const { version } = require(path.join(electronDir, 'package.json'));
    console.log(`[ensure-electron] Electron ${version} installed: ${executable}`);
  }
} catch (err) {
  console.error(`[ensure-electron] ${err.message}`);
  process.exit(1);
}
