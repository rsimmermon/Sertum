import type {
  AgentCapabilities,
  AgentKind,
  ResumableSession,
  SessionSnapshot,
} from '../shared/types';
import { agentIcon } from './agent-icon';
import { agentName } from './chips';

const api = window.sertum;
const RECENTS_KEY = 'sertum.recentFolders';

export interface ResumeSessionOptions {
  startCwd: string;
  /** Declared adapter answers, used to know which agents can resume at all. */
  capabilities: Record<AgentKind, AgentCapabilities> | null;
}

/**
 * Resume a previous conversation — whichever agent still has one on record.
 *
 * A past session is not a running process, so unlike C18's adopt dialog
 * there is nothing to scan for on the process table: this reads each agent's
 * own history instead (Claude's transcript directory, Codex's own
 * `thread/list`) and lists one folder at a time, exactly like starting a new
 * session does — the agent's project config lives there too. Picking a row
 * performs the resume itself and reports a failure inline, the same
 * convention `new-session-dialog.ts` uses for a failed spawn.
 */
export function openResumeDialog(
  opts: ResumeSessionOptions,
): Promise<SessionSnapshot | null> {
  const { capabilities } = opts;
  const resumableAgents = (
    ['claude', 'codex', 'grok', 'shell'] as AgentKind[]
  ).filter((a) => capabilities?.[a]['session-resume'].ok === true);

  return new Promise((resolve) => {
    let cwd = opts.startCwd;
    let sessions: ResumableSession[] = [];
    let resuming = false;
    // Folder changes race their own lookups; only the latest one may render.
    let loadToken = 0;

    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog wide');
    overlay.append(dlg);

    const title = el('h3', '');
    title.textContent = 'Resume a previous session';
    const sub = el('p', 'dialog-sub');
    sub.textContent = 'Pick up an earlier conversation exactly where it left off.';

    // --- folder ------------------------------------------------------------
    const folderInput = document.createElement('input');
    folderInput.type = 'text';
    folderInput.className = 'field';
    folderInput.spellcheck = false;
    folderInput.value = cwd;

    const browse = btn('Browse…', '', async () => {
      const picked = await api.pickDirectory(cwd);
      if (picked) {
        folderInput.value = picked;
        void refresh();
      }
    });
    const folderRow = el('div', 'row');
    folderRow.append(folderInput, browse);

    const recents = loadRecents();
    const recentsWrap = el('div', 'recents');
    if (recents.length) {
      recentsWrap.append(labelEl('RECENT FOLDERS'));
      const chips = el('div', 'chip-row');
      for (const r of recents.slice(0, 6)) {
        const c = el('button', 'pathchip');
        c.textContent = basename(r);
        c.title = r;
        c.onclick = () => {
          folderInput.value = r;
          void refresh();
        };
        chips.append(c);
      }
      recentsWrap.append(chips);
    }

    const list = el('div', 'adopt-list');
    const note = el('div', 'note');
    const footer = el('div', 'dialog-footer');
    footer.append(btn('Cancel', 'ghost', () => finish()));

    dlg.append(
      title,
      sub,
      labelEl('WORKING FOLDER'),
      folderRow,
      recentsWrap,
      labelEl('PAST SESSIONS'),
      list,
      note,
      footer,
    );

    function setNote(kind: '' | 'ok' | 'warn' | 'error', text: string): void {
      note.className = kind ? `note ${kind}` : 'note';
      note.textContent = text;
    }

    function setBusy(busy: boolean): void {
      list
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach((b) => b.toggleAttribute('disabled', busy));
    }

    function render(): void {
      list.replaceChildren();
      if (resumableAgents.length === 0) {
        const empty = el('div', 'adopt-empty');
        empty.textContent =
          'Neither Claude nor Codex is available to resume a past session.';
        list.append(empty);
        return;
      }
      if (sessions.length === 0) {
        const empty = el('div', 'adopt-empty');
        empty.textContent = 'No past sessions found in this folder.';
        list.append(empty);
        return;
      }

      for (const r of sessions) {
        const row = el('div', 'adopt-row');
        row.append(agentIcon(r.agent));

        const body = el('div', 'adopt-body');
        const head = el('div', 'adopt-head');
        head.append(span(r.name || agentName(r.agent), 'adopt-name'));
        if (r.name) head.append(chip(agentName(r.agent), 'agent'));
        body.append(head);
        if (r.preview) body.append(span(r.preview, 'adopt-summary'));
        row.append(body);

        row.append(btn('Resume', 'primary small', () => void pick(r)));
        list.append(row);
      }
    }

    async function refresh(): Promise<void> {
      const value = folderInput.value.trim();
      cwd = value;
      if (!value || resumableAgents.length === 0) {
        sessions = [];
        render();
        return;
      }
      const token = ++loadToken;
      setNote('', 'Looking…');
      const lists = await Promise.all(
        resumableAgents.map((a) =>
          api.listResumableSessions(a, value).catch(() => []),
        ),
      );
      // A later folder change already superseded this lookup.
      if (token !== loadToken) return;
      sessions = lists
        .flat()
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      setNote('', '');
      render();
    }

    async function pick(r: ResumableSession): Promise<void> {
      if (resuming) return;
      resuming = true;
      setBusy(true);
      setNote('', `Resuming ${agentName(r.agent)}…`);
      try {
        const label =
          r.name?.trim() ||
          `${basename(r.cwd) || agentName(r.agent)} · ${agentName(r.agent)} (resumed)`;
        const snapshot = await api.resumeSession(r, label);
        overlay.remove();
        saveRecents(cwd);
        resolve(snapshot);
      } catch (err) {
        resuming = false;
        setBusy(false);
        setNote('error', `Could not resume: ${errorMessage(err)}`);
      }
    }

    // Neither a backdrop click nor Escape is an answer: every route out of a
    // modal goes through one of its own buttons. See "Modals answer, they do
    // not vanish" in AGENTS.md.
    function finish(): void {
      overlay.remove();
      resolve(null);
    }

    folderInput.addEventListener('change', () => void refresh());
    folderInput.addEventListener('blur', () => void refresh());

    document.body.append(overlay);
    void refresh();
    folderInput.focus();
    folderInput.select();
  });
}

// ------------------------------------------------------------------ helpers

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function labelEl(text: string): HTMLElement {
  const e = el('div', 'field-label');
  e.textContent = text;
  return e;
}
function span(text: string, cls: string): HTMLElement {
  const e = el('span', cls);
  e.textContent = text;
  return e;
}
function chip(text: string, tone: string): HTMLElement {
  const e = el('span', `minichip ${tone}`);
  e.textContent = text;
  return e;
}
function btn(text: string, cls: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.className = `btn ${cls}`.trim();
  b.textContent = text;
  b.onclick = onClick;
  return b;
}
function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function saveRecents(dir: string): void {
  const next = [dir, ...loadRecents().filter((r) => r !== dir)].slice(0, 8);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}
