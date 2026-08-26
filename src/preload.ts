import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentStationApi,
  PtyDataEvent,
  PtyExitEvent,
  PtySize,
  SessionSnapshot,
  SessionSpec,
} from './shared/types';

/** Subscribe helper that returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: AgentStationApi = {
  createSession: (spec: Partial<SessionSpec>) =>
    ipcRenderer.invoke('session:create', spec),
  listSessions: () => ipcRenderer.invoke('session:list'),
  killSession: (id: string) => ipcRenderer.invoke('session:kill', id),
  removeSession: (id: string) => ipcRenderer.invoke('session:remove', id),
  pickDirectory: (startIn?: string) =>
    ipcRenderer.invoke('dialog:pick-directory', startIn),
  defaultCwd: () => ipcRenderer.invoke('workspace:default-cwd'),
  inspectDirectory: (dir: string) =>
    ipcRenderer.invoke('workspace:inspect', dir),
  adapterStatus: () => ipcRenderer.invoke('adapters:status'),
  write: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, size: PtySize) =>
    ipcRenderer.send('pty:resize', { id, ...size }),
  onData: (cb) => on<PtyDataEvent>('pty:data', cb),
  onExit: (cb) => on<PtyExitEvent>('pty:exit', cb),
  onSessionUpdated: (cb) => on<SessionSnapshot>('session:updated', cb),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('agentStation', api);

/** Menu commands arrive as fire-and-forget signals. */
contextBridge.exposeInMainWorld('agentStationMenu', {
  on: (channel: string, cb: () => void) => on(`menu:${channel}`, cb),
});
