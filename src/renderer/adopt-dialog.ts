import type { DiscoveredSession } from '../shared/types';

const api = window.sertum;

/**
 * Wireframe C18. Lists agent sessions running outside Sertum and lets
 * you adopt them.
 *
 * Two outcomes, and the dialog is explicit about which you get, because the
 * difference is not cosmetic: a daemon-hosted session gets a real terminal
 * here, while one living in another terminal can only be watched and raised.
 */
export function openAdoptDialog(): Promise<DiscoveredSession[] | null> {
  return new Promise((resolve) => {
    const chosen = new Set<string>();
    let found: DiscoveredSession[] = [];

    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog wide');
    overlay.append(dlg);

    const title = el('h3', '');
    title.textContent = 'Import running sessions';
    const sub = el('p', 'dialog-sub');
    sub.textContent = 'Scanning for agents running outside Sertum…';

    const list = el('div', 'adopt-list');
    const importBtn = btn('Import', 'primary', () => finish(false));
    importBtn.toggleAttribute('disabled', true);
    const footer = el('div', 'dialog-footer');
    footer.append(btn('Cancel', 'ghost', () => finish(true)), importBtn);

    dlg.append(title, sub, list, footer);

    function updateImportLabel(): void {
      importBtn.textContent = chosen.size
        ? `Import ${chosen.size} session${chosen.size === 1 ? '' : 's'}`
        : 'Import';
      importBtn.toggleAttribute('disabled', chosen.size === 0);
    }

    function render(): void {
      list.replaceChildren();
      if (found.length === 0) {
        const empty = el('div', 'adopt-empty');
        empty.textContent =
          'No agent sessions found outside this app. Start one in a terminal and rescan.';
        const rescan = btn('Rescan', '', () => void scan());
        list.append(empty, rescan);
        return;
      }

      for (const d of found) {
        const row = el('div', 'adopt-row');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = chosen.has(d.sessionId);
        box.onchange = () => {
          if (box.checked) chosen.add(d.sessionId);
          else chosen.delete(d.sessionId);
          updateImportLabel();
        };

        const body = el('div', 'adopt-body');
        const head = el('div', 'adopt-head');
        head.append(
          span(d.name, 'adopt-name'),
          chip(d.agent, 'agent'),
          chip(
            d.adoptMode === 'attach' ? 'TERMINAL' : 'MONITOR ONLY',
            d.adoptMode === 'attach' ? 'ok' : 'warn',
          ),
        );
        body.append(head);

        if (d.summary) body.append(span(d.summary, 'adopt-summary'));
        body.append(span(d.cwd || 'unknown folder', 'adopt-cwd'));
        body.append(
          span(
            d.adoptMode === 'attach'
              ? 'Daemon-hosted — opens as a real terminal tab here.'
              : 'Runs in another terminal, so it cannot be rendered here. Appears as a live status row; clicking raises its window.',
            'adopt-why',
          ),
        );

        row.append(box, body);
        row.onclick = (e) => {
          if (e.target === box) return;
          box.checked = !box.checked;
          box.dispatchEvent(new Event('change'));
        };
        list.append(row);
      }
    }

    async function scan(): Promise<void> {
      sub.textContent = 'Scanning…';
      try {
        found = await api.discoverSessions();
      } catch {
        found = [];
      }
      const attachable = found.filter((f) => f.adoptMode === 'attach').length;
      sub.textContent = found.length
        ? `Found ${found.length} session${found.length === 1 ? '' : 's'} — ${attachable} can open as a terminal, ${found.length - attachable} monitor only.`
        : 'Nothing found.';
      render();
      updateImportLabel();
    }

    function finish(cancelled: boolean): void {
      overlay.remove();
      resolve(cancelled ? null : found.filter((f) => chosen.has(f.sessionId)));
    }

    // Neither a backdrop click nor Escape is an answer: every route out of a
    // modal goes through one of its own buttons. See "Modals answer, they do
    // not vanish" in AGENTS.md.
    document.body.append(overlay);
    void scan();
  });
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
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
