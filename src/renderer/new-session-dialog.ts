import type { AgentKind, DirectoryInfo } from '../shared/types';

type Isolation = 'main' | 'new' | 'existing';

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

    // --- isolation (C1) ----------------------------------------------------
    // Defaults to the plain checkout. The wireframe draws New worktree
    // selected, but making every session create one silently changes what
    // "start a session here" means, so it is opt-in until asked for.
    let isolation: Isolation = 'main';
    let branchEdited = false;

    const isoSeg = el('div', 'seg-group');
    const ISO: Array<{ id: Isolation; label: string }> = [
      { id: 'new', label: 'New worktree' },
      { id: 'existing', label: 'Existing worktree' },
      { id: 'main', label: 'Main checkout' },
    ];
    const isoButtons = ISO.map(({ id, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg' + (id === isolation ? ' on' : '');
      b.textContent = label;
      b.onclick = () => {
        isolation = id;
        isoButtons.forEach((x, i) => x.classList.toggle('on', ISO[i].id === isolation));
        void syncIsolation();
      };
      isoSeg.append(b);
      return b;
    });

    const branchWrap = el('div', 'iso-row');
    const branchLabel = labelEl('BRANCH');
    const branchInput = document.createElement('input');
    branchInput.type = 'text';
    branchInput.className = 'field';
    branchInput.spellcheck = false;
    branchInput.oninput = () => {
      branchEdited = true;
    };
    branchWrap.append(branchLabel, branchInput);

    const existingWrap = el('div', 'iso-row');
    const existingSelect = document.createElement('select');
    existingSelect.className = 'field';
    existingWrap.append(labelEl('WORKTREE'), existingSelect);

    const includeWrap = el('label', 'iso-check');
    const includeBox = document.createElement('input');
    includeBox.type = 'checkbox';
    includeBox.checked = true;
    const includeText = document.createElement('span');
    includeText.textContent =
      'Copy .env and gitignored files via .worktreeinclude';
    includeWrap.append(includeBox, includeText);

    const isoNote = el('div', 'note');

    // --- footer ------------------------------------------------------------
    const create = btn('Create session', 'primary', () => void done());
    const cancel = btn('Cancel', 'ghost', () => void done(true));
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
      labelEl('ISOLATION'),
      isoSeg,
      branchWrap,
      existingWrap,
      includeWrap,
      isoNote,
      labelEl('TAB LABEL'),
      labelInput,
      footer,
    );

    /** Branch names come from the session label, as C1 specifies. */
    function suggestBranch(): string {
      const base = (labelInput.value || suggestLabel())
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return base || 'work';
    }

    async function syncIsolation(): Promise<void> {
      const isRepo = Boolean(info?.isGitRepo);
      // Worktrees are a git feature; without a repository there is only the
      // folder itself, and pretending otherwise would fail at create time.
      isoButtons.forEach((b, i) => {
        b.disabled = ISO[i].id !== 'main' && !isRepo;
      });
      if (!isRepo && isolation !== 'main') {
        isolation = 'main';
        isoButtons.forEach((x, i) => x.classList.toggle('on', ISO[i].id === 'main'));
      }

      branchWrap.hidden = isolation !== 'new';
      existingWrap.hidden = isolation !== 'existing';
      includeWrap.hidden = isolation !== 'new';
      if (isolation === 'new' && !branchEdited) branchInput.value = suggestBranch();

      if (isolation === 'existing') {
        existingSelect.replaceChildren();
        const inv = await api.listWorktrees(cwd).catch(() => null);
        const options = (inv?.worktrees ?? []).filter((w) => !w.isMain);
        for (const w of options) {
          const o = document.createElement('option');
          o.value = w.path;
          o.textContent = `${w.name} · ${w.branch ?? 'detached'}`;
          existingSelect.append(o);
        }
        setIsoNote(
          options.length ? '' : 'warn',
          options.length ? '' : 'This repository has no other worktrees yet.',
        );
      } else if (isolation === 'main') {
        setIsoNote(
          'warn',
          'The agent works directly in the checkout. Another session in the ' +
            'same folder would collide with it.',
        );
      } else {
        setIsoNote('', '');
      }
    }

    function setIsoNote(kind: string, text: string): void {
      isoNote.className = kind ? `note ${kind}` : 'note';
      isoNote.textContent = text;
      isoNote.hidden = !text;
    }

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
      await syncIsolation();
    }

    function setNote(kind: 'ok' | 'warn' | 'error', text: string): void {
      folderNote.className = `note ${kind}`;
      folderNote.textContent = text;
    }

    async function done(cancelled = false): Promise<void> {
      if (cancelled || !info?.isDirectory) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        return resolve(null);
      }

      let chosen = info.path;

      // Provision before closing, so a git refusal is reported in the dialog
      // that caused it rather than as a session that silently never appears.
      if (isolation === 'new') {
        const branch = branchInput.value.trim() || suggestBranch();
        create.toggleAttribute('disabled', true);
        setIsoNote('', 'Preparing worktree…');
        const res = await api.provisionWorktree(cwd, branch, includeBox.checked);
        create.toggleAttribute('disabled', false);
        if (!res.ok || !res.path) {
          setIsoNote('error', res.reason ?? 'Could not create that worktree.');
          return;
        }
        chosen = res.path;
      } else if (isolation === 'existing') {
        if (!existingSelect.value) {
          setIsoNote('error', 'Choose a worktree, or switch to Main checkout.');
          return;
        }
        chosen = existingSelect.value;
      }

      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      saveRecents(info.path);
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
        void done(true);
      } else if (e.key === 'Enter' && !create.hasAttribute('disabled')) {
        e.preventDefault();
        void done();
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
