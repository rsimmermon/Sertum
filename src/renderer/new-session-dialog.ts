import type { AgentKind, DirectoryInfo } from '../shared/types';

const api = window.sertum;
const RECENTS_KEY = 'sertum.recentFolders';
const LAST_AGENT_KEY = 'sertum.lastAgent';

export interface NewSessionResult {
  agent: AgentKind;
  cwd: string;
  label: string;
}

const AGENT_LABELS: Array<{ id: AgentKind; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'shell', label: 'Shell' },
];

/**
 * Wireframe C1. Resolves with the chosen session, or null if cancelled.
 *
 * The working folder is the point of this dialog: an agent spawned with the
 * right cwd picks up that project's own CLAUDE.md / AGENTS.md, settings and
 * MCP config for free, which is why we never silently default to $HOME.
 */
/**
 * `presetLabel` seeds the name field and counts as user-edited, so the
 * folder-derived suggestion does not overwrite it. The palette uses it to act
 * on "start a session named 'x'" without making the user retype the name.
 */
export function openNewSessionDialog(
  startCwd: string,
  presetLabel?: string,
): Promise<NewSessionResult | null> {
  return new Promise((resolve) => {
    let agent: AgentKind =
      (localStorage.getItem(LAST_AGENT_KEY) as AgentKind | null) ?? 'claude';
    let cwd = startCwd;
    let info: DirectoryInfo | null = null;
    let labelEdited = Boolean(presetLabel);

    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog');
    overlay.append(dlg);

    const title = el('h3', '');
    title.textContent = 'New session';
    const sub = el('p', 'dialog-sub');
    sub.textContent =
      'The agent runs in this folder, so the project’s own config applies.';

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

    const folderNote = el('div', 'note');

    // --- recents -----------------------------------------------------------
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

    // --- agent -------------------------------------------------------------
    const seg = el('div', 'segmented');
    const segButtons = AGENT_LABELS.map(({ id, label }) => {
      const b = el('button', 'seg' + (id === agent ? ' on' : ''));
      b.textContent = label;
      b.onclick = () => {
        agent = id;
        segButtons.forEach((x, i) =>
          x.classList.toggle('on', AGENT_LABELS[i].id === agent),
        );
        if (!labelEdited) labelInput.value = suggestLabel();
      };
      seg.append(b);
      return b;
    });

    // --- label -------------------------------------------------------------
    const labelInput = document.createElement('input');
    if (presetLabel) labelInput.value = presetLabel;
    labelInput.type = 'text';
    labelInput.className = 'field';
    labelInput.spellcheck = false;
    labelInput.oninput = () => {
      labelEdited = true;
    };

    // --- footer ------------------------------------------------------------
    const create = btn('Create session', 'primary', () => done());
    const cancel = btn('Cancel', 'ghost', () => done(true));
    const footer = el('div', 'dialog-footer');
    footer.append(cancel, create);

    dlg.append(
      title,
      sub,
      labelEl('WORKING FOLDER'),
      folderRow,
      folderNote,
      recentsWrap,
      labelEl('AGENT'),
      seg,
      labelEl('TAB LABEL'),
      labelInput,
      footer,
    );

    function suggestLabel(): string {
      const base = basename(folderInput.value.trim());
      const short = agent === 'claude' ? 'claude' : agent;
      return base ? `${base} · ${short}` : short;
    }

    async function refresh(): Promise<void> {
      const value = folderInput.value.trim();
      cwd = value;
      if (!labelEdited) labelInput.value = suggestLabel();
      if (!value) {
        info = null;
        setNote('error', 'Choose a working folder.');
        create.toggleAttribute('disabled', true);
        return;
      }
      info = await api.inspectDirectory(value);
      if (!info.exists) {
        setNote('error', 'That folder does not exist.');
        create.toggleAttribute('disabled', true);
        return;
      }
      if (!info.isDirectory) {
        setNote('error', 'That path is a file, not a folder.');
        create.toggleAttribute('disabled', true);
        return;
      }
      create.toggleAttribute('disabled', false);
      if (info.isGitRepo) {
        const kind = info.isWorktree ? 'git worktree' : 'git repository';
        setNote('ok', `${kind} · branch ${info.branch ?? 'unknown'}`);
      } else {
        setNote('warn', 'Not a git repository — worktree actions stay disabled.');
      }
    }

    function setNote(kind: 'ok' | 'warn' | 'error', text: string): void {
      folderNote.className = `note ${kind}`;
      folderNote.textContent = text;
    }

    function done(cancelled = false): void {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (cancelled || !info?.isDirectory) return resolve(null);
      const chosen = info.path;
      saveRecents(chosen);
      localStorage.setItem(LAST_AGENT_KEY, agent);
      resolve({
        agent,
        cwd: chosen,
        label: labelInput.value.trim() || suggestLabel(),
      });
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Enter' && !create.hasAttribute('disabled')) {
        e.preventDefault();
        done();
      }
    }

    folderInput.addEventListener('change', () => void refresh());
    folderInput.addEventListener('blur', () => void refresh());
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) done(true);
    });
    document.addEventListener('keydown', onKey, true);

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
