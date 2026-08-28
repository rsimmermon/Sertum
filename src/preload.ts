import { contextBridge, ipcRenderer } from 'electron';
import type {
  SertumApi,
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

const api: SertumApi = {
  createSession: (spec: Partial<SessionSpec>) =>
    ipcRenderer.invoke('session:create', spec),
  listSessions: () => ipcRenderer.invoke('session:list'),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  listWorktrees: (cwd: string) => ipcRenderer.invoke('worktree:list', cwd),
  removeWorktree: (root: string, path: string, force: boolean) =>
    ipcRenderer.invoke('worktree:remove', { root, path, force }),
  provisionWorktree: (cwd: string, branch: string, copyIncludes: boolean) =>
    ipcRenderer.invoke('worktree:provision', { cwd, branch, copyIncludes }),
  revealPath: (target: string) => ipcRenderer.invoke('shell:reveal', target),
  killSession: (id: string) => ipcRenderer.invoke('session:kill', id),
  renameSession: (id: string, label: string) =>
    ipcRenderer.invoke('session:rename', { id, label }),
  removeSession: (id: string) => ipcRenderer.invoke('session:remove', id),
  pickDirectory: (startIn?: string) =>
    ipcRenderer.invoke('dialog:pick-directory', startIn),
  pickFile: (startIn?: string) => ipcRenderer.invoke('dialog:pick-file', startIn),
  detectAgentBinary: (agent: 'claude' | 'codex') =>
    ipcRenderer.invoke('agent:detect', agent),
  defaultCwd: () => ipcRenderer.invoke('workspace:default-cwd'),
  inspectDirectory: (dir: string) =>
    ipcRenderer.invoke('workspace:inspect', dir),
  adapterStatus: () => ipcRenderer.invoke('adapters:status'),
  discoverSessions: () => ipcRenderer.invoke('discovery:list'),
  attachSession: (d) => ipcRenderer.invoke('discovery:attach', d),
  monitorSession: (d) => ipcRenderer.invoke('discovery:monitor', d),
  focusExternal: (pid: number) => ipcRenderer.invoke('discovery:focus', pid),
  openAutomationSettings: () =>
    ipcRenderer.invoke('shell:automation-settings'),
  write: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, size: PtySize) =>
    ipcRenderer.send('pty:resize', { id, ...size }),
  onData: (cb) => on<PtyDataEvent>('pty:data', cb),
  onExit: (cb) => on<PtyExitEvent>('pty:exit', cb),
  onSessionUpdated: (cb) => on<SessionSnapshot>('session:updated', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('sertum', api);

/** Menu commands arrive as fire-and-forget signals. */
contextBridge.exposeInMainWorld('sertumMenu', {
  on: (channel: string, cb: () => void) => on(`menu:${channel}`, cb),
});
