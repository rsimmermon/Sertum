import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApprovalAnswer,
  DiffCommitRequest,
  PendingApproval,
  PermissionRule,
  ManagedAgent,
  MenuState,
  SertumApi,
  PtyDataEvent,
  PtyExitEvent,
  PtySize,
  SessionSnapshot,
  SessionSpec,
  PermissionMode,
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
  copySelection: () => ipcRenderer.invoke('clipboard:copy-selection'),
  pasteSelection: () => ipcRenderer.invoke('clipboard:paste-selection'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  listWorktrees: (cwd: string) => ipcRenderer.invoke('worktree:list', cwd),
  removeWorktree: (root: string, path: string, force: boolean) =>
    ipcRenderer.invoke('worktree:remove', { root, path, force }),
  provisionWorktree: (cwd: string, branch: string, copyIncludes: boolean) =>
    ipcRenderer.invoke('worktree:provision', { cwd, branch, copyIncludes }),
  readDiff: (cwd: string) => ipcRenderer.invoke('diff:read', cwd),
  readDiffFile: (root: string, path: string) =>
    ipcRenderer.invoke('diff:file', { root, path }),
  discardDiff: (root: string) => ipcRenderer.invoke('diff:discard', root),
  commitDiff: (request: DiffCommitRequest) =>
    ipcRenderer.invoke('diff:commit', request),
  readPullRequest: (root: string) => ipcRenderer.invoke('pr:read', root),
  createPullRequest: (request: {
    root: string;
    title: string;
    body: string;
    draft: boolean;
  }) => ipcRenderer.invoke('pr:create', request),
  revealPath: (target: string) => ipcRenderer.invoke('shell:reveal', target),
  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', url),
  readLocalImage: (cwd: string, src: string) =>
    ipcRenderer.invoke('image:read-local', { cwd, src }),
  answerApproval: (
    request: { id: string; sessionId: string; tool: string; subject: string },
    answer: ApprovalAnswer,
  ) => ipcRenderer.invoke('approval:answer', { ...request, answer }),
  pendingApprovals: (): Promise<PendingApproval[]> =>
    ipcRenderer.invoke('approval:pending'),
  onApprovalNeeded: (fn: (request: PendingApproval) => void) => {
    const handler = (_e: unknown, request: PendingApproval) => fn(request);
    ipcRenderer.on('approval:needed', handler);
    return () => ipcRenderer.removeListener('approval:needed', handler);
  },
  onApprovalGone: (fn: (id: string) => void) => {
    const handler = (_e: unknown, id: string) => fn(id);
    ipcRenderer.on('approval:gone', handler);
    return () => ipcRenderer.removeListener('approval:gone', handler);
  },
  getKeybindings: () => ipcRenderer.invoke('keys:get'),
  setKeybinding: (id: string, accelerator: string) =>
    ipcRenderer.invoke('keys:set', { id, accelerator }),
  resetKeybindings: () => ipcRenderer.invoke('keys:reset'),
  getPermissionRules: () => ipcRenderer.invoke('rules:get'),
  addPermissionRule: (rule: Omit<PermissionRule, 'id'>) =>
    ipcRenderer.invoke('rules:add', rule),
  removePermissionRule: (id: string) => ipcRenderer.invoke('rules:remove', id),
  muteSession: (id: string, muted: boolean) =>
    ipcRenderer.invoke('session:mute', { id, muted }),
  snoozeSession: (id: string) => ipcRenderer.invoke('session:snooze', id),
  onSessionReveal: (fn: (id: string) => void) => {
    const handler = (_e: unknown, id: string) => fn(id);
    ipcRenderer.on('session:reveal', handler);
    return () => ipcRenderer.removeListener('session:reveal', handler);
  },
  killSession: (id: string) => ipcRenderer.invoke('session:kill', id),
  steerSession: (id: string, text: string) =>
    ipcRenderer.invoke('session:steer', { id, text }),
  interruptTurn: (id: string) =>
    ipcRenderer.invoke('session:interrupt-turn', id),
  setToolGate: (id: string, paused: boolean) =>
    ipcRenderer.invoke('session:tool-gate', { id, paused }),
  setPermissionMode: (id: string, mode: PermissionMode) =>
    ipcRenderer.invoke('session:permission-mode', { id, mode }),
  renameSession: (id: string, label: string) =>
    ipcRenderer.invoke('session:rename', { id, label }),
  agentCapabilities: () => ipcRenderer.invoke('agent:capabilities'),
  removeSession: (id: string) => ipcRenderer.invoke('session:remove', id),
  pickDirectory: (startIn?: string) =>
    ipcRenderer.invoke('dialog:pick-directory', startIn),
  pickFile: (startIn?: string) => ipcRenderer.invoke('dialog:pick-file', startIn),
  detectAgentBinary: (agent: ManagedAgent) =>
    ipcRenderer.invoke('agent:detect', agent),
  defaultCwd: () => ipcRenderer.invoke('workspace:default-cwd'),
  inspectDirectory: (dir: string) =>
    ipcRenderer.invoke('workspace:inspect', dir),
  readConversation: (id: string) => ipcRenderer.invoke('conversation:read', id),
  sendChatMessage: (id: string, text: string) =>
    ipcRenderer.invoke('chat:send', { id, text }),
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
  replayPty: (id: string) => ipcRenderer.invoke('pty:replay', id),
  onPtyReplay: (cb) => on<PtyDataEvent>('pty:replay', cb),
  stopDaemon: () => ipcRenderer.invoke('daemon:stop'),
  onSessionUpdated: (cb) => on<SessionSnapshot>('session:updated', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('sertum', api);

/** Menu commands arrive as fire-and-forget signals. */
contextBridge.exposeInMainWorld('sertumMenu', {
  on: (channel: string, cb: () => void) => on(`menu:${channel}`, cb),
  /** Tells main which menu items can currently do anything. */
  setState: (state: MenuState) => ipcRenderer.send('menu:state', state),
});
