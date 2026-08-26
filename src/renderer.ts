import './index.css';
import '@xterm/xterm/css/xterm.css';
import { App } from './renderer/app';
import type { AgentStationApi } from './shared/types';

declare global {
  interface Window {
    agentStation: AgentStationApi;
    agentStationMenu: { on(channel: string, cb: () => void): () => void };
  }
}

const app = new App();
// Dev-only handle so scripts/drive.js can inspect and drive the running app.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__agentStation = app;
}
void app.start();
