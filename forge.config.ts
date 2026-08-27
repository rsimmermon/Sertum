import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

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
  if (file === '/package.json') return true;
  // Keep the directory itself, or packager never descends into it.
  if (file === '/node_modules') return true;
  return RUNTIME_MODULES.some(
    (m) => file === `/node_modules/${m}` || file.startsWith(`/node_modules/${m}/`),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    // node-pty also ships plain executables it exec()s — spawn-helper on
    // macOS/Linux, OpenConsole/winpty-agent on Windows — and a binary inside
    // an asar cannot be exec'd (posix_spawnp fails). The auto-unpack plugin
    // only covers *.node, so the whole module is unpacked; the plugin unions
    // its pattern with this one rather than replacing it.
    asar: { unpack: '**/node_modules/node-pty/**/*' },
    name: 'Sertum',
    executableName: 'Sertum',
    appBundleId: 'dev.sertum.app',
    // Extension-less: packager picks .icns on macOS and .ico on Windows.
    icon: 'assets/icon',
    ignore: (file) => !shipInPackage(file),
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ setupIcon: 'assets/icon.ico' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({ options: { icon: 'assets/icon.png' } }),
    new MakerDeb({ options: { icon: 'assets/icon.png' } }),
  ],
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
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
