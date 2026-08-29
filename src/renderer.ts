import './index.css';
import '@xterm/xterm/css/xterm.css';
import { App } from './renderer/app';
import type { SertumApi } from './shared/types';

declare global {
  interface Window {
    sertum: SertumApi;
    sertumMenu: {
      on(channel: string, cb: () => void): () => void;
      setState(state: import('./shared/types').MenuState): void;
    };
  }
}

const app = new App();
// Dev-only handle so scripts/drive.js can inspect and drive the running app.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sertum = app;
}
void app.start();
