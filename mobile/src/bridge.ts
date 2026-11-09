import type { ChatAttachment, PendingApproval, SertumApi, SessionSnapshot } from '@desktop/shared/types';
import { device } from './connection';
import type { Fleet, Member } from './fleet';

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
 *
 * With several PCs paired, a call about a session goes to the PC that owns it, a
 * list is gathered from every PC that answers, and a file goes to the PC of the
 * session on screen, since that is the agent it is for.
 */
export function makeBridge(fleet: Fleet): {
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
  const forSession = <T>(id: string, method: string, params: unknown) => fleet.callFor<T>(id, method, params);
  const focused = (): Member => {
    const member = fleet.focusedPc();
    if (!member) throw new Error('Open a session first, so this phone knows which PC it is for.');
    return member;
  };
  /** Every PC that answers; one switched off does not fail the rest. */
  async function gather<T>(method: string): Promise<T[]> {
    const answers = await Promise.allSettled(fleet.list()
      .filter((m) => m.connection.state.kind === 'connected')
      .map((m) => m.connection.call<T[]>(method)));
    return answers.flatMap((a) => a.status === 'fulfilled' ? a.value : []);
  }

  async function upload(member: Member, file: File): Promise<ChatAttachment> {
    const call = <T>(method: string, params?: unknown) => member.connection.call<T>(method, params);
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
    createSession: (spec) => fleet.createSession(focused().pc.id, spec),
    listSessions: () => gather<SessionSnapshot>('session/list'),
    removeSession: (id) => forSession(id, 'session/remove', id),
    agentCapabilities: () => focused().connection.call('agent/capabilities'),
    interruptTurn: (id) => forSession(id, 'session/interrupt-turn', id),
    setPermissionMode: (id, mode) => forSession(id, 'session/permission-mode', { id, mode }),
    sessionModels: (id) => forSession(id, 'session/models', id),
    setSessionModel: (id, model) => forSession(id, 'session/model', { id, model }),
    sessionEfforts: (id) => forSession(id, 'session/efforts', id),
    setSessionEffort: (id, effort) => forSession(id, 'session/effort', { id, effort }),
    readConversation: (id, request) => forSession(id, 'conversation/read', { ...request, id }),
    readConversationPage: (id, request) => forSession(id, 'conversation/page', { ...request, id }),
    readConversationItem: (id, request) => forSession(id, 'conversation/item', { ...request, id }),
    readLocalImage: async (cwd, src) => {
      const member = fleet.pcForCwd(cwd);
      return member ? member.connection.call<string | null>('image/read-local', { cwd, src }) : null;
    },
    submitChatMessage: (id, text, attachments) => forSession(id, 'chat/submit', { id, text, attachments }),
    removeQueuedMessage: (id, messageId) => forSession(id, 'chat/queue-remove', { id, messageId }),
    pendingApprovals: () => gather<PendingApproval>('approval/pending'),
    answerApproval: async (request, answer) => {
      await forSession(request.sessionId, 'approval/answer', { ...request, answer });
    },
    pickChatAttachments: async () => {
      const member = focused();
      const files = await pickFiles();
      const uploaded: ChatAttachment[] = [];
      for (const file of files) uploaded.push(await upload(member, file));
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
