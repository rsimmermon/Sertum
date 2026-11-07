// The phone app. Always a client of a sertumd on a PC; it hosts nothing itself.
import '@desktop/index.css';
import './shell.css';
import type { SertumApi } from '@desktop/shared/types';
import { Connection, type ConnectionState, type PairedPc } from './connection';
import { makeBridge } from './bridge';

const globals = window as unknown as Record<string, unknown>;

if (import.meta.env.VITE_SPIKE) {
  // The rendering and transport spikes, for `VITE_SPIKE=1 npm run apk`.
  await import('../spikes/harness');
} else {
  // Handlers set once the shell exists. The bridge has to be in place before the
  // desktop modules load, because each reads `window.sertum` as it is imported.
  const handlers = {
    state: (_s: ConnectionState): void => undefined,
    ready: (): void => undefined,
    pc: (_p: PairedPc): void => undefined,
  };
  const emit = (name: string, payload: unknown): void => bridge.emit(name, payload);
  const connection: Connection = new Connection(
    (state) => handlers.state(state),
    emit,
    () => handlers.ready(),
    (pc) => handlers.pc(pc),
  );
  const bridge = makeBridge(connection);
  (globals as { sertum: SertumApi }).sertum = bridge.api;
  globals.sertumMenu = { on: () => () => undefined, setState: () => undefined };
  const { startShell } = await import('./shell');
  startShell(document.getElementById('host') as HTMLElement, connection, bridge.api, handlers);
}
