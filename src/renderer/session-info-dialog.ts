import type {
  SessionDiagnostics,
  SessionSnapshot,
  SessionStatus,
} from '../shared/types';

const api = window.sertum;

/** Read-only truth/process detail for a session that looks quiet. */
export function openSessionInfoDialog(session: SessionSnapshot): void {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const dialog = document.createElement('div');
  dialog.className = 'dialog wide session-info-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  overlay.append(dialog);

  const title = document.createElement('h3');
  title.textContent = `${session.label} · Session info`;
  dialog.append(title);
  const sub = document.createElement('p');
  sub.className = 'dialog-sub';
  sub.textContent = session.cwd;
  dialog.append(sub);

  const body = document.createElement('div');
  body.className = 'session-info-body';
  dialog.append(body);

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const refresh = makeButton('Refresh', 'btn ghost', () => void load());
  const close = makeButton('Close', 'btn primary', finish);
  actions.append(refresh, close);
  dialog.append(actions);

  let loading = false;
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => void load(), 2000);

  function finish(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish();
    }
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    try {
      const diagnostics = await api.sessionDiagnostics(session.id);
      render(diagnostics);
    } catch (error) {
      body.replaceChildren(text('p', `Could not read session info — ${String(error)}`, 'note error'));
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  }

  function render(diagnostics: SessionDiagnostics): void {
    body.replaceChildren();
    const latest = diagnostics.recentActivity[diagnostics.recentActivity.length - 1];
    const currentStatus = latest?.status ?? session.status;
    const currentActivity = latest?.activity ?? session.activity;
    const lastEventAt = latest?.at ?? session.lastEventAt ?? diagnostics.capturedAt;
    const summary = document.createElement('div');
    summary.className = 'session-info-summary';
    summary.append(
      statusChip(currentStatus),
      text('span', currentActivity ?? 'no activity reported', 'session-info-activity'),
      text('span', session.pid === null ? 'no live pid' : `pid ${session.pid}`, 'session-info-meta'),
      text('span', `updated ${age(diagnostics.capturedAt - lastEventAt)} ago`, 'session-info-meta'),
    );
    body.append(summary);

    const children = section('Sub-sessions', diagnostics.subSessions.length);
    if (diagnostics.subSessions.length === 0) {
      children.append(text('div', 'No agent-owned sub-sessions are currently reported.', 'session-info-empty'));
    } else {
      const list = document.createElement('div');
      list.className = 'session-info-list';
      for (const child of diagnostics.subSessions) {
        const row = document.createElement('div');
        row.className = 'session-info-row';
        row.append(
          statusChip(child.status),
          text('span', child.label, 'session-info-name'),
          text('span', child.activity ?? 'no activity reported', 'session-info-activity'),
          text('code', child.id.slice(0, 8), 'session-info-id'),
        );
        list.append(row);
      }
      children.append(list);
    }
    body.append(children);

    const processes = section('Process monitor', diagnostics.processes.length);
    if (diagnostics.processes.length === 0) {
      processes.append(text('div', 'The process tree is unavailable or the session has no live process.', 'session-info-empty'));
    } else {
      const list = document.createElement('div');
      list.className = 'session-info-list session-process-list';
      const byPid = new Map(diagnostics.processes.map((p) => [p.pid, p]));
      for (const process of diagnostics.processes) {
        const row = document.createElement('div');
        row.className = 'session-info-row';
        row.style.paddingLeft = `${8 + processDepth(process.pid, byPid)}px`;
        row.append(
          text('code', String(process.pid), 'session-info-id'),
          text('span', process.command, 'session-info-command'),
        );
        list.append(row);
      }
      processes.append(list);
    }
    body.append(processes);

    const feed = section('Recent agent feedback', diagnostics.recentActivity.length);
    if (diagnostics.recentActivity.length === 0) {
      feed.append(text('div', 'No structured activity has been recorded yet.', 'session-info-empty'));
    } else {
      const list = document.createElement('div');
      list.className = 'session-info-list session-feed';
      for (const event of [...diagnostics.recentActivity].reverse()) {
        const row = document.createElement('div');
        row.className = 'session-info-row';
        row.append(
          text('time', clock(event.at), 'session-info-time'),
          statusChip(event.status),
          text('span', event.activity ?? 'status changed', 'session-info-activity'),
        );
        list.append(row);
      }
      feed.append(list);
    }
    body.append(feed);
  }

  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();
  void load();
}

function section(label: string, count: number): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'session-info-section';
  const heading = document.createElement('div');
  heading.className = 'session-info-heading';
  heading.append(text('h4', label, ''), text('span', String(count), 'session-info-count'));
  wrap.append(heading);
  return wrap;
}

function statusChip(status: SessionStatus): HTMLSpanElement {
  const chip = text('span', status.replace('-', ' '), `session-info-status ${status}`) as HTMLSpanElement;
  return chip;
}

function processDepth(pid: number, byPid: Map<number, { pid: number; parentPid: number | null }>): number {
  let depth = 0;
  let current = byPid.get(pid);
  const seen = new Set<number>();
  while (current && current.parentPid !== null && !seen.has(current.parentPid)) {
    seen.add(current.pid);
    const parent = byPid.get(current.parentPid);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return Math.min(depth * 14, 70);
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 2 ? 'just now' : `${seconds}s`;
}

function text(tag: string, value: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function makeButton(label: string, className: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.onclick = action;
  return node;
}
