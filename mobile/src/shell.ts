import { agentIcon } from '@desktop/renderer/agent-icon';
import { ChatPane } from '@desktop/renderer/chat-pane';
import { closeSessionMenu } from '@desktop/renderer/session-menu';
import type {
  AgentCapabilities,
  AgentKind,
  CapabilityAnswer,
  PendingApproval,
  SertumApi,
  SessionSnapshot,
  SessionStatus,
} from '@desktop/shared/types';
import { device, type Connection, type ConnectionState, type PairedPc } from './connection';
import { parseOffer, type PairingOffer } from './pairing';

const PC_KEY = 'sertum.pc';
const FOLDERS_KEY = 'sertum.folders';
const MAX_FOLDERS = 20;
/** Panes hold about 1,000 items each, so only the last few read are kept open. */
const MAX_OPEN_PANES = 4;

const STATUS_WORD: Record<SessionStatus, string> = {
  'needs-input': 'Needs you',
  working: 'Working',
  attention: 'Failed',
  idle: 'Idle',
  done: 'Finished',
};
const STATUS_RANK: Record<SessionStatus, number> = {
  'needs-input': 0, attention: 1, working: 2, idle: 3, done: 4,
};
const START_AGENTS: Array<[AgentKind, string]> = [['claude', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok']];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(label: string, cls: string, run: () => void | Promise<void>): HTMLButtonElement {
  const node = el('button', cls, label);
  node.type = 'button';
  node.onclick = () => void run();
  return node;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do. The phone asks again next time.
  }
}

function shortFolder(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || cwd;
}

/** Says what is wrong in the words that point at the fix. */
function describe(state: ConnectionState, pc: { name: string } | null): { line: string; detail: string | null } | null {
  const name = pc?.name ?? 'your PC';
  switch (state.kind) {
    case 'idle':
    case 'connected':
      return null;
    case 'connecting':
      return { line: `Connecting to ${name}…`, detail: null };
    case 'refused':
      return { line: state.message, detail: null };
    case 'unreachable':
      return state.found
        ? {
          line: `Found ${name} at ${state.found}, but cannot connect.`,
          detail: 'Discovery works and the connection does not, so a firewall is the likely cause. On the PC, allow Sertum on private networks.',
        }
        : {
          line: `Cannot find or reach ${name}.`,
          detail: `Tried ${state.tried.join(', ') || 'no addresses'}. Check that the phone and PC are on the same network and that phone access is on in Settings on the PC.`,
        };
  }
}

export function startShell(
  host: HTMLElement,
  connection: Connection,
  api: SertumApi,
  hooks: { state(s: ConnectionState): void; ready(): void; pc(p: PairedPc): void },
): void {
  let pc = readJson<PairedPc | null>(PC_KEY, null);
  let sessions = new Map<string, SessionSnapshot>();
  let pending: PendingApproval[] = [];
  let capabilities: Record<AgentKind, AgentCapabilities> | null = null;
  let openId: string | null = null;
  let sheet: HTMLElement | null = null;
  const panes = new Map<string, ChatPane>();
  const paneOrder: string[] = [];

  const root = el('div', 'phone-root');
  const banner = el('div', 'phone-banner');
  const page = el('div', 'phone-page');
  root.append(banner, page);
  host.append(root);

  function rememberFolders(): void {
    const known = readJson<string[]>(FOLDERS_KEY, []);
    const merged = [...new Set([...sessions.values()].filter((s) => s.agent !== 'shell').map((s) => s.cwd).concat(known))];
    writeJson(FOLDERS_KEY, merged.slice(0, MAX_FOLDERS));
  }

  // --------------------------------------------------------------- the banner
  function drawBanner(): void {
    banner.replaceChildren();
    const said = pc ? describe(connection.state, pc) : null;
    banner.hidden = !said;
    if (!said) return;
    banner.classList.toggle('is-trouble', connection.state.kind !== 'connecting');
    banner.append(el('div', 'phone-banner-line', said.line));
    if (said.detail) banner.append(el('div', 'phone-banner-detail', said.detail));
    if (connection.state.kind === 'unreachable') {
      const row = el('div', 'phone-banner-actions');
      row.append(
        button('Try again', 'btn', () => connection.retryNow()),
        button('Address…', 'btn ghost', () => openConnectionSheet()),
      );
      banner.append(row);
    } else if (connection.state.kind === 'refused') {
      banner.append(button('Pair again', 'btn', () => forget()));
    }
  }

  // ---------------------------------------------------------------- the sheet
  function closeSheet(): void {
    sheet?.remove();
    sheet = null;
  }

  function openSheet(title: string, build: (body: HTMLElement) => void): void {
    closeSheet();
    const backdrop = el('div', 'phone-sheet-backdrop');
    const panel = el('div', 'phone-sheet');
    panel.append(el('div', 'phone-sheet-title', title));
    const body = el('div', 'phone-sheet-body');
    build(body);
    panel.append(body);
    backdrop.append(panel);
    root.append(backdrop);
    sheet = backdrop;
  }

  function confirmSheet(title: string, words: string, label: string, run: () => Promise<void>): void {
    openSheet(title, (body) => {
      const said = el('div', 'phone-note', words);
      const row = el('div', 'phone-actions');
      row.append(
        button('Cancel', 'btn ghost', closeSheet),
        button(label, 'btn danger', async () => {
          try {
            await run();
            closeSheet();
          } catch (err) {
            said.textContent = err instanceof Error ? err.message : String(err);
          }
        }),
      );
      body.append(said, row);
    });
  }

  function openConnectionSheet(): void {
    if (!pc) return;
    const paired = pc;
    openSheet(paired.name, (body) => {
      const state = connection.state;
      body.append(el('div', 'phone-note', state.kind === 'connected' ? `Connected at ${state.host}.` : 'Not connected.'));
      body.append(el('label', 'phone-label', 'Address'));
      const input = el('input', 'phone-input');
      input.value = paired.manualHost ?? '';
      input.placeholder = 'Found automatically';
      input.autocapitalize = 'off';
      body.append(
        input,
        el('div', 'phone-hint', `Only needed for a VPN or a network that hides devices from each other. Port ${paired.port}. The PC is checked by its key, so a wrong address cannot fool this phone.`),
      );
      const row = el('div', 'phone-actions');
      row.append(
        button('Cancel', 'btn ghost', closeSheet),
        button('Save', 'btn primary', () => {
          paired.manualHost = input.value.trim() || null;
          savePc(paired);
          closeSheet();
          connection.start(paired);
        }),
      );
      body.append(row, button('Forget this PC', 'btn ghost phone-forget', () => {
        confirmSheet(
          `Forget ${paired.name}?`,
          'This phone stops connecting until it is paired again. To cut it off from the PC side as well, remove it in Settings on the PC.',
          'Forget',
          () => {
            forget();
            return Promise.resolve();
          },
        );
      }));
    });
  }

  function openNewSession(): void {
    const folders = readJson<string[]>(FOLDERS_KEY, []);
    openSheet('New session', (body) => {
      let agent: AgentKind = 'claude';
      const chips = el('div', 'phone-chips');
      const agentButtons = START_AGENTS.map(([id, label]) => {
        const chip = button(label, 'phone-chip', () => {
          agent = id;
          for (const other of agentButtons) other.classList.toggle('on', other === chip);
        });
        chip.classList.toggle('on', id === agent);
        chip.prepend(agentIcon(id));
        chips.append(chip);
        return chip;
      });
      body.append(el('label', 'phone-label', 'Agent'), chips);

      body.append(el('label', 'phone-label', 'Folder on the PC'));
      const input = el('input', 'phone-input');
      input.placeholder = 'D:\\source\\repos\\project';
      input.autocapitalize = 'off';
      input.value = folders[0] ?? '';
      body.append(input);
      if (folders.length) {
        const list = el('div', 'phone-folders');
        for (const folder of folders) {
          const row = button(folder, 'phone-folder', () => { input.value = folder; });
          list.append(row);
        }
        body.append(list);
      }
      const said = el('div', 'phone-note');
      const start = button('Start', 'btn primary', async () => {
        start.disabled = true;
        said.textContent = 'Starting…';
        try {
          // Named as the desktop's new-session dialog names one, after its folder.
          const cwd = input.value.trim();
          const label = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
          const made = await api.createSession({ agent, cwd, label });
          sessions.set(made.id, made);
          rememberFolders();
          closeSheet();
          openChat(made.id);
        } catch (err) {
          said.textContent = err instanceof Error ? err.message : String(err);
          start.disabled = false;
        }
      });
      const row = el('div', 'phone-actions');
      row.append(button('Cancel', 'btn ghost', closeSheet), start);
      body.append(said, row);
    });
  }

  // ----------------------------------------------------------------- pairing
  function savePc(next: PairedPc): void {
    pc = next;
    writeJson(PC_KEY, next);
  }

  function forget(): void {
    connection.stop();
    pc = null;
    try {
      localStorage.removeItem(PC_KEY);
    } catch {
      // It stays until replaced, and is not a secret.
    }
    for (const pane of panes.values()) pane.dispose();
    panes.clear();
    paneOrder.length = 0;
    sessions = new Map();
    pending = [];
    openId = null;
    closeSheet();
    drawBanner();
    drawPairing();
  }

  function drawPairing(): void {
    let offer: PairingOffer | null = null;
    page.replaceChildren();
    const box = el('div', 'phone-pair');
    box.append(
      el('h1', 'phone-pair-title', 'Connect to your PC'),
      el('div', 'phone-note', 'On the PC, open Settings, then Phones. Turn on phone access and show the pairing code.'),
    );
    const said = el('div', 'phone-pair-status');
    const detail = el('div', 'phone-hint');
    const address = el('input', 'phone-input');
    address.placeholder = 'PC address (optional)';
    address.autocapitalize = 'off';
    const manual = el('div', 'phone-pair-manual');
    manual.hidden = true;

    const attempt = async (chosen: PairingOffer): Promise<void> => {
      offer = chosen;
      said.textContent = `Connecting to ${chosen.name}…`;
      detail.textContent = '';
      try {
        const paired = await connection.pair(chosen, address.value.trim() || null);
        savePc(paired);
        drawBanner();
        drawList();
      } catch {
        const told = describe(connection.state, chosen);
        said.textContent = told?.line ?? 'Could not pair.';
        detail.textContent = told?.detail ?? '';
        manual.hidden = connection.state.kind !== 'unreachable';
      }
    };
    const scan = button('Scan the code', 'btn primary phone-wide', async () => {
      said.textContent = '';
      detail.textContent = '';
      try {
        const { text, cancelled } = await device.scanQr();
        if (cancelled) return;
        const parsed = parseOffer(text ?? '');
        if (!parsed) said.textContent = 'That is not a Sertum pairing code.';
        else await attempt(parsed);
      } catch (err) {
        said.textContent = err instanceof Error ? err.message : String(err);
        detail.textContent = 'You can use “Copy as text” on the PC and paste it below instead.';
      }
    });
    const paste = el('textarea', 'phone-input phone-paste');
    paste.placeholder = 'Or paste the code here';
    paste.rows = 2;
    const usePasted = button('Use pasted code', 'btn ghost phone-wide', async () => {
      const parsed = parseOffer(paste.value);
      if (!parsed) said.textContent = 'That is not a Sertum pairing code.';
      else await attempt(parsed);
    });
    manual.append(
      el('label', 'phone-label', 'Try another address'),
      address,
      button('Try again', 'btn', async () => {
        if (offer) await attempt(offer);
      }),
    );
    box.append(scan, paste, usePasted, said, detail, manual);
    page.append(box);
  }

  // ------------------------------------------------------------- the list
  function sessionRow(session: SessionSnapshot): HTMLElement {
    const isTerminal = session.agent === 'shell';
    const row = el('button', 'phone-row');
    row.type = 'button';
    row.disabled = isTerminal;
    row.append(agentIcon(session.agent));
    const text = el('div', 'phone-row-text');
    text.append(
      el('div', 'phone-row-title', session.label),
      el('div', 'phone-row-sub', isTerminal
        ? 'Terminal sessions open on the PC'
        : session.activity ?? shortFolder(session.cwd)),
    );
    const waiting = pending.filter((a) => a.sessionId === session.id).length;
    const badge = el('div', `phone-status is-${session.status}`, waiting ? `${waiting} to answer` : STATUS_WORD[session.status]);
    row.append(text, badge);
    row.onclick = () => openChat(session.id);
    return row;
  }

  function drawList(): void {
    if (!pc) return;
    if (openId) return;
    page.replaceChildren();
    const head = el('div', 'phone-head');
    head.append(
      el('div', 'phone-head-title', pc.name),
      button('New', 'btn primary', openNewSession),
      button('Connection', 'btn ghost', openConnectionSheet),
    );
    const list = el('div', 'phone-list');
    const rows = [...sessions.values()].sort((a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.startedAt - a.startedAt);
    for (const session of rows) list.append(sessionRow(session));
    if (!rows.length) {
      list.append(el('div', 'phone-empty', connection.state.kind === 'connected'
        ? 'No sessions on this PC. Start one with New.'
        : 'Sessions appear here once connected.'));
    }
    page.append(head, list);
  }

  // ------------------------------------------------------------- a conversation
  function interruptAnswer(session: SessionSnapshot): CapabilityAnswer {
    return capabilities?.[session.agent]['turn-interrupt'] ?? { ok: false, reason: 'Agent capabilities are still loading.' };
  }

  function paneFor(session: SessionSnapshot): ChatPane {
    let pane = panes.get(session.id);
    if (!pane) {
      pane = new ChatPane(session, interruptAnswer(session), (id) => {
        pending = pending.filter((a) => a.id !== id);
        syncPane(session.id);
      }, capabilities);
      panes.set(session.id, pane);
    }
    const at = paneOrder.indexOf(session.id);
    if (at >= 0) paneOrder.splice(at, 1);
    paneOrder.push(session.id);
    while (paneOrder.length > MAX_OPEN_PANES) {
      const oldest = paneOrder.shift() as string;
      panes.get(oldest)?.dispose();
      panes.delete(oldest);
    }
    return pane;
  }

  function syncPane(id: string): void {
    const pane = panes.get(id);
    const session = sessions.get(id);
    if (!pane || !session) return;
    pane.setCapabilities(capabilities, interruptAnswer(session));
    pane.update(session);
    pane.setApprovals(pending.filter((a) => a.sessionId === id));
  }

  function drawChatHead(session: SessionSnapshot): HTMLElement {
    const head = el('div', 'phone-head phone-chat-head');
    const title = el('div', 'phone-chat-title');
    title.append(
      el('div', 'phone-head-title', session.label),
      el('div', `phone-status is-${session.status}`, STATUS_WORD[session.status]),
    );
    head.append(
      button('‹', 'phone-back', () => history.back()),
      title,
      button('End', 'btn ghost', () => confirmSheet(
        `End ${session.label}?`,
        session.exitCode === null
          ? 'This ends the agent on the PC, and anything mid-turn is lost. The transcript stays.'
          : 'This removes it from the list. The transcript stays.',
        'End session',
        async () => {
          const gone = await api.removeSession(session.id);
          if (!gone) throw new Error('It will not exit: its process is still running on the PC.');
          dropSession(session.id);
        },
      )),
    );
    return head;
  }

  function drawChat(): void {
    const session = openId ? sessions.get(openId) : null;
    if (!session) return;
    const pane = paneFor(session);
    page.replaceChildren(drawChatHead(session), pane.element);
    pane.element.classList.add('phone-chat');
    syncPane(session.id);
    pane.attach();
  }

  function openChat(id: string): void {
    if (openId === id) return;
    openId = id;
    history.pushState({ session: id }, '');
    drawChat();
  }

  function leaveChat(): void {
    // A chip's picker lives on the body, so it would outlast the pane and cover
    // whatever comes next, naming a session no longer on screen.
    closeSessionMenu();
    if (openId) panes.get(openId)?.unmount();
    openId = null;
    drawList();
  }

  // Android's back button walks this, through the WebView's own history.
  window.addEventListener('popstate', () => {
    if (sheet) closeSheet();
    if (openId) leaveChat();
  });

  function dropSession(id: string): void {
    sessions.delete(id);
    pending = pending.filter((a) => a.sessionId !== id);
    const pane = panes.get(id);
    if (pane) {
      pane.dispose();
      panes.delete(id);
      const at = paneOrder.indexOf(id);
      if (at >= 0) paneOrder.splice(at, 1);
    }
    if (openId === id) {
      closeSessionMenu();
      openId = null;
      history.back();
      drawList();
    } else if (!openId) {
      drawList();
    }
  }

  // ---------------------------------------------------------------- the feed
  api.onSessionUpdated((session) => {
    sessions.set(session.id, session);
    if (openId === session.id) {
      syncPane(session.id);
      const status = page.querySelector('.phone-chat-title .phone-status');
      if (status) {
        status.className = `phone-status is-${session.status}`;
        status.textContent = STATUS_WORD[session.status];
      }
    } else if (panes.has(session.id)) {
      syncPane(session.id);
    }
    if (!openId) drawList();
  });
  api.onSessionRemoved(({ id }) => dropSession(id));
  api.onApprovalNeeded((request) => {
    if (!pending.some((a) => a.id === request.id)) pending.push(request);
    syncPane(request.sessionId);
    if (!openId) drawList();
  });
  api.onApprovalGone((id) => {
    const gone = pending.find((a) => a.id === id);
    pending = pending.filter((a) => a.id !== id);
    if (gone) syncPane(gone.sessionId);
    if (!openId) drawList();
  });

  hooks.state = () => {
    drawBanner();
    if (!openId && pc) drawList();
  };
  hooks.pc = (next) => savePc(next);
  /** Everything held may be stale after a gap, so all of it is asked for again. */
  hooks.ready = () => {
    void (async () => {
      try {
        const [listed, asks, answers] = await Promise.all([
          api.listSessions(), api.pendingApprovals(), api.agentCapabilities(),
        ]);
        sessions = new Map(listed.map((s) => [s.id, s]));
        pending = asks;
        capabilities = answers;
        rememberFolders();
        for (const id of [...panes.keys()]) {
          if (sessions.has(id)) {
            syncPane(id);
            panes.get(id)?.catchUp();
          } else dropSession(id);
        }
        if (openId && !sessions.has(openId)) leaveChat();
        else if (!openId) drawList();
      } catch (err) {
        console.error('[phone] could not read the PC after connecting:', err);
      }
    })();
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) connection.retryNow();
  });

  if (pc) {
    drawList();
    drawBanner();
    connection.start(pc);
  } else {
    drawBanner();
    drawPairing();
  }
}
