import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import {
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';

/**
 * Modules that must ship as real files rather than bundled code.
 *
 * The Vite build marks node-pty external because it is a native module, so the
 * built main.js require()s it at runtime. The Vite plugin's default packaging
 * rule keeps only `/.vite` and drops node_modules entirely, which leaves that
 * require unsatisfiable — the packaged app then dies the moment a session
 * spawns, while `npm start` works fine because it resolves from the source
 * tree. Supplying our own `ignore` opts out of that default (the plugin skips
 * its own when one is already set).
 */
const RUNTIME_MODULES = ['node-pty', 'node-addon-api'];

function shipInPackage(file: string): boolean {
  // Packager paths always start with '/'; '' is the root being walked.
  if (!file) return true;
  if (file.startsWith('/.vite')) return true;
  // Electron's tray needs a real cross-platform bitmap at runtime. The
  // executable/bundle icon alone cannot be loaded portably on all desktops.
  if (file === '/assets' || file === '/assets/icon.png') return true;
  if (file === '/package.json') return true;
  // Keep the directory itself, or packager never descends into it.
  if (file === '/node_modules') return true;
  return RUNTIME_MODULES.some(
    (m) => file === `/node_modules/${m}` || file.startsWith(`/node_modules/${m}/`),
  );
}

const run = promisify(execFile);

/** Every node-pty spawn-helper the packaged bundle actually ships. */
async function ptyHelpers(resources: string): Promise<string[]> {
  const prebuilds = path.join(
    resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds',
  );
  const found: string[] = [];
  for (const slice of await fs.readdir(prebuilds)) {
    const helper = path.join(prebuilds, slice, 'spawn-helper');
    // Only the darwin slices carry one; win32 has ConPTY instead.
    if (await fs.stat(helper).then(() => true, () => false)) found.push(helper);
  }
  return found;
}

/**
 * The path node-pty will ask the kernel for, which is not the one on disk.
 *
 * lib/unixTerminal.js rewrites `app.asar` to `app.asar.unpacked` in the
 * helper path unconditionally, which is correct when the module was loaded
 * from inside the archive by Electron's asar-aware require. sertumd is not
 * that: it runs under ELECTRON_RUN_AS_NODE, which has no asar support, so it
 * resolves node-pty on the real filesystem inside app.asar.unpacked already
 * -- and the rewrite lands on `app.asar.unpacked.unpacked`, which exists
 * nowhere. Reproduced verbatim in this repo's own copy of node-pty by moving
 * it between two paths differing only in that substring.
 */
function ptyRuntimeHelper(helper: string): string {
  return helper
    .replace('app.asar', 'app.asar.unpacked')
    .replace('node_modules.asar', 'node_modules.asar.unpacked');
}

/**
 * Makes the helper node-pty asks for on macOS both present and executable.
 *
 * Two upstream facts, each of which alone stops every PTY session dead, and
 * each of which surfaces as one flat sentence with no errno and no path in it
 * -- `posix_spawnp failed.` -- because that is all the addon throws:
 *
 *  - node-pty 1.1.0 publishes `prebuilds/darwin-<arch>/spawn-helper` mode
 *    0644, and npm, packager and asar's unpack all faithfully carry that
 *    along. macOS `posix_spawn`s it as argv[0], so it has to be executable.
 *    scripts/ensure-pty-helper.js does the same for the source tree, which
 *    `npm start` runs from.
 *  - the asar rewrite above sends it to a directory that does not exist. A
 *    symlink beside the real one answers that path without moving the module,
 *    patching it, or teaching pty-manager.ts a packaged-only require path.
 *
 * Both run before the re-sign below, since each changes the bundle and the
 * signature has to seal it as shipped. docs/terminal.md carries the evidence.
 */
async function fixDarwinPtyHelper(outputPaths: string[]): Promise<void> {
  for (const dir of outputPaths) {
    const resources = path.join(dir, 'Sertum.app', 'Contents', 'Resources');
    for (const helper of await ptyHelpers(resources)) {
      const { mode } = await fs.stat(helper);
      // Mirror read to execute, so the bit lands for whoever can already read.
      await fs.chmod(helper, mode | ((mode & 0o444) >> 2));
    }
    const shim = path.join(resources, 'app.asar.unpacked.unpacked');
    await fs.rm(shim, { recursive: true, force: true });
    await fs.symlink('app.asar.unpacked', shim);
  }
}

/**
 * Re-signs the packaged macOS bundle ad-hoc, after everything else has
 * finished writing to it.
 *
 * Two things go wrong on their own, both of which cost us TCC:
 *
 *  - Packager writes Info.plist (our `extendInfo` keys, ElectronAsarIntegrity)
 *    *after* the fuses plugin's `packageAfterCopy` re-sign, so the shipped
 *    bundle fails `codesign --verify` outright -- and macOS will not hold an
 *    Automation grant for a bundle whose signature does not check out.
 *  - That fuses re-sign passes `--preserve-metadata`, which carries Electron's
 *    own signing identifier (com.github.Electron) forward even though our
 *    Info.plist says dev.sertum.app. TCC keys the grant on the signing
 *    identifier, so left alone Sertum would share one TCC identity with every
 *    other ad-hoc-signed Electron app on the machine.
 *
 * A plain deep re-sign fixes both: each nested bundle takes its identifier
 * from its own CFBundleIdentifier, and the seal covers the final plist.
 *
 * The signature is ad-hoc, so its designated requirement pins the cdhash --
 * every rebuild is a new identity, and any Automation grant given to the
 * previous build has to be given again.
 */
async function resignDarwinBundle(outputPaths: string[]): Promise<void> {
  for (const dir of outputPaths) {
    const bundles = (await fs.readdir(dir)).filter((e) => e.endsWith('.app'));
    for (const bundle of bundles) {
      await run('codesign', [
        '--force',
        '--sign',
        '-',
        '--deep',
        path.join(dir, bundle),
      ]);
    }
  }
}

/**
 * Fails packaging if a piece the app cannot run without was lost: the two that
 * make sertumd launchable, and on macOS the executable bit on node-pty's
 * spawn-helper. Every one of these otherwise produces a perfectly
 * healthy-looking installer and only surfaces after launch -- when the GUI
 * tries to start its session fabric, or when the first PTY session refuses to
 * spawn.
 */
async function verifyPackagedDaemon(
  platform: string,
  outputPaths: string[],
): Promise<void> {
  for (const dir of outputPaths) {
    const resources = platform === 'darwin'
      ? path.join(dir, 'Sertum.app', 'Contents', 'Resources')
      : path.join(dir, 'resources');
    const executable = platform === 'darwin'
      ? path.join(dir, 'Sertum.app')
      // Packager names the Linux executable after productName, not name.
      : path.join(dir, platform === 'win32' ? 'Sertum.exe' : 'Sertum');
    const daemon = path.join(
      resources,
      'app.asar.unpacked',
      '.vite',
      'build',
      'sertumd.js',
    );
    await fs.access(daemon);

    if (platform === 'darwin') {
      // Checked at the path node-pty will really use, so the symlink and the
      // executable bit are both proven by one stat that follows the link.
      // Every slice present is checked rather than the one matching `arch`,
      // since a universal build has no `darwin-universal` slice to name.
      const helpers = await ptyHelpers(resources);
      if (helpers.length === 0) {
        throw new Error(
          'packaged Sertum ships no node-pty spawn-helper; no PTY session can start',
        );
      }
      for (const helper of helpers) {
        const runtime = ptyRuntimeHelper(helper);
        let mode: number;
        try {
          ({ mode } = await fs.stat(runtime));
        } catch {
          throw new Error(
            `packaged Sertum resolves its PTY helper to ${runtime}, which is not there`,
          );
        }
        if (!(mode & 0o111)) {
          throw new Error(
            `packaged Sertum has a non-executable ${runtime}; no PTY session can start`,
          );
        }
      }
    }

    const fuses = await getCurrentFuseWire(executable);
    // FuseState.ENABLE is the byte value for ASCII "1". Avoid importing the
    // package-private constants module just for this assertion.
    if (fuses[FuseV1Options.RunAsNode] !== 49) {
      throw new Error(
        'packaged Sertum has RunAsNode disabled; sertumd cannot start',
      );
    }
  }
}

/**
 * Shared by the deb and rpm makers. Both installers default `bin` to
 * package.json's lowercase name, but Packager named the executable after
 * productName, so without it each fails looking for a `sertum` that is not
 * there.
 */
const linuxPackageOptions = {
  bin: 'Sertum',
  icon: 'assets/icon.png',
  categories: ['Development' as const],
  genericName: 'Coding agent manager',
};

const config: ForgeConfig = {
  packagerConfig: {
    // node-pty also ships plain executables it exec()s — spawn-helper on
    // macOS/Linux, OpenConsole/winpty-agent on Windows — and a binary inside
    // an asar cannot be exec'd (posix_spawnp fails). The auto-unpack plugin
    // only covers *.node, so the whole module is unpacked; the plugin unions
    // its pattern with this one rather than replacing it.
    // sertumd.js is unpacked too: it runs under plain Node, which cannot
    // read from inside an asar. postPackage verifies both this file and the
    // RunAsNode fuse before Forge is allowed to produce an artifact.
    // `unpack` is matched against absolute filenames with matchBase enabled:
    // a basename reaches sertumd through `.vite`, while a path glob does not.
    // Keep node-pty as a directory rule because its helper executables matter
    // just as much as its native addon.
    asar: { unpack: 'sertumd.js', unpackDir: 'node_modules/node-pty' },
    name: 'Sertum',
    executableName: 'Sertum',
    appBundleId: 'dev.sertum.app',
    // Extension-less: packager picks .icns on macOS and .ico on Windows.
    icon: 'assets/icon',
    // Raising another terminal's exact tab is an Apple event, and macOS
    // refuses to send one -- silently, with error -1743 -- unless the bundle
    // says why it wants to. Worse, without this key the app never appears
    // under Privacy & Security > Automation at all, so there is nothing for
    // the user to switch on. Keep this string in step with the one in
    // scripts/dev-app-name.js, which puts it on the dev bundle.
    //
    // Signing with the hardened runtime would additionally need a
    // com.apple.security.automation.apple-events entitlement; we ship
    // ad-hoc signed, so the usage string is the whole requirement today.
    extendInfo: {
      NSAppleEventsUsageDescription:
        'Sertum sends Apple events to your terminal so it can bring the '
        + 'window and tab of an agent session running there to the front.',
    },
    ignore: (file) => !shipInPackage(file),
  },
  rebuildConfig: {
    // node-pty ships its own prebuilt N-API binaries (fetched by its own
    // `install` script — see node_modules/node-pty/scripts/prebuild.js) and
    // N-API is ABI-stable across Node/Electron, so no per-Electron-version
    // rebuild is actually needed. Forge's rebuild step doesn't know about
    // that bespoke prebuild convention, so left alone it always falls
    // through to a from-source `node-gyp rebuild` — dragging in a full
    // native toolchain (MSVC/Xcode/build-essential) just to reproduce a
    // binary node-pty already ships. Skip it and use that binary as-is.
    ignoreModules: ['node-pty'],
  },
  makers: [
    // Without `loadingGif`, electron-winstaller falls back to its own
    // placeholder -- a mint-green rectangle with two stray marks in the
    // corner, which is the first thing anyone sees of Sertum. Ours is
    // generated from the same vector as the icon by scripts/make-loading-gif.js
    // and keeps the placeholder's dimensions, since Squirrel sizes its window
    // to this image.
    new MakerSquirrel({
      setupIcon: 'assets/icon.ico',
      loadingGif: 'assets/install-spinner.gif',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({ options: linuxPackageOptions }),
    new MakerDeb({ options: linuxPackageOptions }),
  ],
  hooks: {
    postPackage: async (_forgeConfig, { platform, outputPaths }) => {
      if (platform === 'darwin') {
        await fixDarwinPtyHelper(outputPaths);
        await resignDarwinBundle(outputPaths);
      }
      await verifyPackagedDaemon(platform, outputPaths);
    },
  },
  plugins: [
    // node-pty ships a .node binary, and native modules cannot be loaded from
    // inside an asar. Without this the packaged app throws the moment a
    // session spawns, while `npm start` works fine.
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // sertumd, the session broker. A
          // plain Node bundle: the GUI runs it under its own executable with
          // ELECTRON_RUN_AS_NODE, so there is no second runtime to ship.
          entry: 'src/sertumd.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      // On: the GUI launches sertumd by running its own executable as Node
      // (ELECTRON_RUN_AS_NODE), which this fuse gates in packaged builds.
      // The cost is that anyone who can set that variable can use the app
      // binary as a Node interpreter — the standard price of hosting a
      // daemon this way, and the same trade VS Code ships with.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
