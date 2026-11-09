// The phone app. Always a client of a sertumd on a PC (or several); it hosts nothing itself.
import '@desktop/index.css';
import './shell.css';
import type { SertumApi } from '@desktop/shared/types';
import { Fleet } from './fleet';
import { makeBridge } from './bridge';

const globals = window as unknown as Record<string, unknown>;

if (import.meta.env.VITE_SPIKE) {
  // The rendering and transport spikes, for `VITE_SPIKE=1 npm run apk`.
  await import('../spikes/harness');
} else {
  // The bridge has to be in place before the desktop modules load, because each
  // reads `window.sertum` as it is imported. The shell sets the fleet's other hooks.
  const fleet = new Fleet();
  const bridge = makeBridge(fleet);
  fleet.hooks.event = (_pcId, name, payload) => bridge.emit(name, payload);
  (globals as { sertum: SertumApi }).sertum = bridge.api;
  globals.sertumMenu = { on: () => () => undefined, setState: () => undefined };
  const { startShell } = await import('./shell');
  startShell(document.getElementById('host') as HTMLElement, fleet, bridge.api);
}
