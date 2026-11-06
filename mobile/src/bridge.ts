import type { ChatAttachment, PendingApproval, SertumApi } from '@desktop/shared/types';
import { device, type Connection } from './connection';

/** Below the daemon's 2MB limit for one chunk. */
const CHUNK_BYTES = 1536 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

type Listener = (payload: never) => void;

function readAs(blob: Blob, how: 'dataUrl'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'));
    reader.onload = () => resolve(String(reader.result));
    if (how === 'dataUrl') reader.readAsDataURL(blob);
  });
}

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/**
 * `window.sertum` over the gateway, which is the whole reason the desktop's chat
 * pane runs here unchanged. What only a window on the PC can do answers as nothing,
 * through the proxy at the bottom, rather than each being written out.
 */
export function makeBridge(connection: Connection): {
  api: SertumApi;
  emit(name: string, payload: unknown): void;
} {
  const listeners = new Map<string, Set<Listener>>();
  const previews = new Map<string, string>();
  const on = (name: string) => (fn: Listener) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, set = new Set());
    set.add(fn);
    return () => { set.delete(fn); };
  };
  const call = <T>(method: string, params?: unknown) => connection.call<T>(method, params);

  async function upload(file: File): Promise<ChatAttachment> {
    const { uploadId } = await call<{ uploadId: string }>('upload/begin', { name: file.name, size: file.size });
    try {
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        const url = await readAs(file.slice(offset, offset + CHUNK_BYTES), 'dataUrl');
        await call('upload/chunk', { uploadId, offset, data: url.slice(url.indexOf(',') + 1) });
      }
      const attachment = await call<ChatAttachment>('upload/finish', { uploadId });
      // The daemon's thumbnails need Electron, but this phone still has the picture.
      if (attachment.kind === 'image' && file.size <= MAX_PREVIEW_BYTES) {
        previews.set(attachment.path, await readAs(file, 'dataUrl'));
      }
      return attachment;
    } catch (err) {
      await call('upload/abort', { uploadId }).catch(() => undefined);
      throw err;
    }
  }

  const implemented: Partial<SertumApi> = {
    platform: 'linux',
    createSession: (spec) => call('session/create', spec),
    listSessions: () => call('session/list'),
    removeSession: (id) => call('session/remove', id),
    agentCapabilities: () => call('agent/capabilities'),
    interruptTurn: (id) => call('session/interrupt-turn', id),
    setPermissionMode: (id, mode) => call('session/permission-mode', { id, mode }),
    sessionModels: (id) => call('session/models', id),
    setSessionModel: (id, model) => call('session/model', { id, model }),
    sessionEfforts: (id) => call('session/efforts', id),
    setSessionEffort: (id, effort) => call('session/effort', { id, effort }),
    readConversation: (id, request) => call('conversation/read', { ...request, id }),
    readConversationPage: (id, request) => call('conversation/page', { ...request, id }),
    readConversationItem: (id, request) => call('conversation/item', { ...request, id }),
    readLocalImage: (cwd, src) => call('image/read-local', { cwd, src }),
    submitChatMessage: (id, text, attachments) => call('chat/submit', { id, text, attachments }),
    removeQueuedMessage: (id, messageId) => call('chat/queue-remove', { id, messageId }),
    pendingApprovals: () => call<PendingApproval[]>('approval/pending'),
    answerApproval: async (request, answer) => {
      await call('approval/answer', { ...request, answer });
    },
    pickChatAttachments: async () => {
      const files = await pickFiles();
      const uploaded: ChatAttachment[] = [];
      for (const file of files) uploaded.push(await upload(file));
      return uploaded;
    },
    readChatAttachmentPreview: (attachment) => Promise.resolve(previews.get(attachment.path) ?? null),
    readClipboard: async () => {
      const { text } = await device.readClipboard();
      return text ? { kind: 'text', text } : { kind: 'empty' };
    },
    openExternal: (url) => {
      window.open(url, '_blank');
      return Promise.resolve(true);
    },
    onSessionUpdated: on('session:updated') as SertumApi['onSessionUpdated'],
    onSessionRemoved: on('session:removed') as SertumApi['onSessionRemoved'],
    onConversationChanged: on('conversation:changed') as SertumApi['onConversationChanged'],
    onChatDelivered: on('chat:delivered') as SertumApi['onChatDelivered'],
    onApprovalNeeded: on('approval:needed') as SertumApi['onApprovalNeeded'],
    onApprovalGone: on('approval:gone') as SertumApi['onApprovalGone'],
  };

  const api = new Proxy(implemented, {
    get(target, property: string) {
      if (property in target) return target[property as keyof SertumApi];
      if (property.startsWith('on')) return () => () => undefined;
      return () => Promise.resolve(null);
    },
  }) as SertumApi;

  return {
    api,
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) (fn as (p: unknown) => void)(payload);
    },
  };
}
