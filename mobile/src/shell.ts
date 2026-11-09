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
import { device, type ConnectionState } from './connection';
import { foldersKey, sessionsKey, type Fleet, type Member } from './fleet';
import { parseOffer, type PairingOffer } from './pairing';

const LAST_PC_KEY = 'sertum.lastPc';
const MAX_FOLDERS = 20;
/** How many sessions per PC are remembered for when it is offline. */
const MAX_REMEMBERED = 50;
/** Sessions update many times a second while a turn runs, so saving waits for a lull. */
const REMEMBER_DELAY_MS = 2000;
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

/** Which screen is showing. The back button walks these, through the WebView's history. */
type View = { kind: 'list' } | { kind: 'chat'; id: string } | { kind: 'pcs' } | { kind: 'pair' };

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

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Says what is wrong in the words that point at the fix. */
function describe(state: ConnectionState, name: string): { line: string; detail: string | null } | null {
  switch (state.kind) {
    case 'idle':
    case 'connected':
      return null;
    case 'connecting':
      return { line: `Connecting to ${name}…`, detail: null };
    case 'refused':
      return { line: state.message, detail: null };
    case 'unreachable': {
      const next = state.retryAt === null
        ? 'Not trying again until you tap Try again or come back to the app.'
        : `Trying again at ${clock(state.retryAt)}.`;
      return state.found
        ? {
          line: `Found ${name} at ${state.found}, but cannot connect.`,
          detail: `Discovery works and the connection does not, so a firewall is the likely cause. On the PC, allow Sertum on private networks. ${next}`,
        }
        : {
          line: `Cannot find or reach ${name}.`,
          detail: `Tried ${state.tried.join(', ') || 'no addresses'}. It may be off or asleep, or phone access may be off in Settings on the PC. ${next}`,
        };
    }
  }
}

/** A word for the PC's connection, beside its name everywhere a session is shown. */
function pcWord(state: ConnectionState): string {
  switch (state.kind) {
    case 'connected': return 'connected';
    case 'connecting': return 'connecting';
    case 'refused': return 'refused';
    case 'unreachable': return 'offline';
    case 'idle': return 'offline';
  }
}

function pcTag(member: Member | null, cls = 'phone-pc'): HTMLElement {
  const tag = el('span', cls);
  const state = member?.connection.state.kind ?? 'idle';
  tag.append(el('span', `phone-pc-dot is-${state}`), el('span', 'phone-pc-name', member?.pc.name ?? 'Unknown PC'));
  return tag;
}

export function startShell(host: HTMLElement, fleet: Fleet, api: SertumApi): void {
  let sessions = new Map<string, SessionSnapshot>();
  let pending: PendingApproval[] = [];
  let sheet: HTMLElement | null = null;
  const panes = new Map<string, ChatPane>();
  const paneOrder: string[] = [];
  const stack: View[] = [{ kind: 'list' }];
  let shownChat: string | null = null;

  const root = el('div', 'phone-root');
  const banner = el('div', 'phone-banner');
  const page = el('div', 'phone-page');
  root.append(banner, page);
  host.append(root);

  const top = (): View => stack[stack.length - 1];
  const openId = (): string | null => {
    const view = top();
    return view.kind === 'chat' ? view.id : null;
  };

  let rememberTimer: ReturnType<typeof setTimeout> | null = null;
  /** Saves each PC's sessions as they now stand, for showing while it is offline. */
  function rememberSessions(): void {
    if (rememberTimer) return;
    rememberTimer = setTimeout(() => {
      rememberTimer = null;
      for (const member of fleet.list()) {
        const owned = [...sessions.values()]
          .filter((s) => fleet.ownerOf(s.id) === member)
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, MAX_REMEMBERED);
        writeJson(sessionsKey(member.pc.id), owned);
      }
    }, REMEMBER_DELAY_MS);
  }

  function rememberFolders(pcId: string): void {
    const key = foldersKey(pcId);
    const known = readJson<string[]>(key, []);
    const used = [...sessions.values()]
      .filter((s) => s.agent !== 'shell' && fleet.ownerOf(s.id)?.pc.id === pcId)
      .map((s) => s.cwd);
    writeJson(key, [...new Set(used.concat(known))].slice(0, MAX_FOLDERS));
  }

  // ------------------------------------------------------------ navigation
  function go(view: View): void {
    stack.push(view);
    history.pushState({ depth: stack.length - 1 }, '');
    render();
  }

  function back(levels = 1): void {
    if (stack.length > 1) history.go(-Math.min(levels, stack.length - 1));
    else render();
  }

  history.replaceState({ depth: 0 }, '');
  window.addEventListener('popstate', (event) => {
    if (sheet) {
      // Back closes the sheet and nothing else, so the screen under it stays.
      closeSheet();
      history.pushState({ depth: stack.length - 1 }, '');
      return;
    }
    const depth = Number((event.state as { depth?: number } | null)?.depth ?? 0);
    stack.length = Math.max(1, Math.min(stack.length, depth + 1));
    render();
  });

  function render(): void {
    const view = top();
    if (shownChat && (view.kind !== 'chat' || view.id !== shownChat)) {
      // A chip's picker lives on the body, so it would outlast the pane and cover
      // whatever comes next, naming a session no longer on screen.
      closeSessionMenu();
      panes.get(shownChat)?.unmount();
      shownChat = null;
    }
    fleet.focus = openId();
    if (!fleet.list().length) {
      drawPairing(false);
    } else if (view.kind === 'chat' && sessions.has(view.id)) {
      drawChat(view.id);
    } else if (view.kind === 'pcs') {
      drawPcs();
    } else if (view.kind === 'pair') {
      drawPairing(true);
    } else {
      drawList();
    }
    drawBanner();
  }

  // --------------------------------------------------------------- the banner
  /** Only PCs in trouble are named here, and in a chat, only that chat's PC. */
  function drawBanner(): void {
    banner.replaceChildren();
    const view = top();
    const chatPc = view.kind === 'chat' ? fleet.ownerOf(view.id) : null;
    const shown = view.kind === 'pcs' || view.kind === 'pair' || !fleet.list().length
      ? []
      : fleet.list().filter((m) => (!chatPc || m === chatPc) && describe(m.connection.state, m.pc.name));
    banner.hidden = !shown.length;
    banner.classList.toggle('is-trouble', shown.some((m) => m.connection.state.kind !== 'connecting'));
    for (const member of shown) {
      const state = member.connection.state;
      const said = describe(state, member.pc.name);
      if (!said) continue;
      const row = el('div', 'phone-banner-row');
      row.append(el('div', 'phone-banner-line', said.line));
      if (state.kind === 'unreachable' || state.kind === 'refused') {
        const actions = el('div', 'phone-banner-actions');
        if (state.kind === 'unreachable') actions.append(button('Try again', 'btn', () => fleet.retry(member.pc.id)));
        actions.append(button('Details', 'btn ghost', () => go({ kind: 'pcs' })));
        row.append(actions);
      }
      banner.append(row);
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

  function openAddressSheet(member: Member): void {
    const paired = member.pc;
    openSheet(`${paired.name} address`, (body) => {
      const input = el('input', 'phone-input');
      input.value = paired.manualHost ?? '';
      input.placeholder = 'Found automatically';
      input.autocapitalize = 'off';
      body.append(
        el('label', 'phone-label', 'Address'),
        input,
        el('div', 'phone-hint', `Only needed for a VPN or a network that hides devices from each other. Port ${paired.port}. The PC is checked by its key, so a wrong address cannot fool this phone.`),
      );
      const row = el('div', 'phone-actions');
      row.append(
        button('Cancel', 'btn ghost', closeSheet),
        button('Save', 'btn primary', () => {
          fleet.update({ ...paired, manualHost: input.value.trim() || null });
          closeSheet();
          render();
        }),
      );
      body.append(row);
    });
  }

  function openNewSession(): void {
    const members = fleet.list();
    const connected = members.filter((m) => m.connection.state.kind === 'connected');
    const last = fleet.get(readJson<string>(LAST_PC_KEY, ''));
    let chosen: Member = (last && connected.includes(last) ? last : connected[0]) ?? last ?? members[0];
    let agent: AgentKind = 'claude';
    openSheet('New session', (body) => {
      if (members.length > 1) {
        const pcs = el('div', 'phone-chips phone-chips-wrap');
        const pcButtons = members.map((member) => {
          const chip = button('', 'phone-chip', () => {
            chosen = member;
            for (const other of pcButtons) other.classList.toggle('on', other === chip);
            drawFolders();
          });
          chip.append(pcTag(member));
          chip.classList.toggle('on', member === chosen);
          pcs.append(chip);
          return chip;
        });
        body.append(el('label', 'phone-label', 'PC'), pcs);
      }

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

      const folderLabel = el('label', 'phone-label');
      const input = el('input', 'phone-input');
      input.placeholder = 'D:\\source\\repos\\project';
      input.autocapitalize = 'off';
      const list = el('div', 'phone-folders');
      body.append(folderLabel, input, list);
      /** Each PC has its own folders, so the list follows the PC chosen. */
      function drawFolders(): void {
        const folders = readJson<string[]>(foldersKey(chosen.pc.id), []);
        folderLabel.textContent = `Folder on ${chosen.pc.name}`;
        input.value = folders[0] ?? '';
        list.replaceChildren(...folders.map((folder) => button(folder, 'phone-folder', () => { input.value = folder; })));
        list.hidden = !folders.length;
      }
      drawFolders();

      const said = el('div', 'phone-note');
      const start = button('Start', 'btn primary', async () => {
        start.disabled = true;
        said.textContent = 'Starting…';
        try {
          // Named as the desktop's new-session dialog names one, after its folder.
          const cwd = input.value.trim();
          const label = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
          const pcId = chosen.pc.id;
          const made = await fleet.createSession(pcId, { agent, cwd, label });
          sessions.set(made.id, made);
          rememberSessions();
          writeJson(LAST_PC_KEY, pcId);
          rememberFolders(pcId);
          closeSheet();
          go({ kind: 'chat', id: made.id });
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
  function drawPairing(canGoBack: boolean): void {
    let offer: PairingOffer | null = null;
    page.replaceChildren();
    if (canGoBack) {
      const head = el('div', 'phone-head');
      head.append(button('‹', 'phone-back', () => back()), el('div', 'phone-head-title', 'Add a PC'));
      page.append(head);
    }
    const box = el('div', 'phone-pair');
    box.append(
      el('h1', 'phone-pair-title', canGoBack ? 'Connect another PC' : 'Connect to your PC'),
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
      const outcome = await fleet.pair(chosen, address.value.trim() || null);
      if (outcome.ok) {
        // Back to the session list, whether this was the first PC or another.
        if (stack.length > 1) back(stack.length - 1);
        else render();
        return;
      }
      const told = describe(outcome.state, chosen.name);
      said.textContent = told?.line ?? 'Could not pair.';
      detail.textContent = outcome.state.kind === 'unreachable'
        ? `Tried ${outcome.state.tried.join(', ') || 'no addresses'}. Check that the phone and PC are on the same network.`
        : '';
      manual.hidden = outcome.state.kind !== 'unreachable';
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

  // ------------------------------------------------------------- the PCs page
  function pcCard(member: Member): HTMLElement {
    const state = member.connection.state;
    const card = el('div', 'phone-pc-card');
    const head = el('div', 'phone-pc-card-head');
    head.append(pcTag(member, 'phone-pc phone-pc-big'), el('span', `phone-pc-word is-${state.kind}`, pcWord(state)));
    card.append(head);
    const said = describe(state, member.pc.name);
    const count = fleet.sessionsOf(member.pc.id).length;
    card.append(el('div', 'phone-note', state.kind === 'connected'
      ? `Connected at ${state.host}. ${count === 1 ? '1 session' : `${count} sessions`}.`
      : said?.line ?? 'Not connected.'));
    if (said?.detail) card.append(el('div', 'phone-hint', said.detail));
    if (member.pc.manualHost) card.append(el('div', 'phone-hint', `Address set by hand: ${member.pc.manualHost}`));
    const row = el('div', 'phone-pc-actions');
    if (state.kind === 'unreachable') row.append(button('Try again', 'btn primary', () => fleet.retry(member.pc.id)));
    if (state.kind === 'refused') row.append(button('Pair again', 'btn primary', () => go({ kind: 'pair' })));
    row.append(
      button('Address…', 'btn ghost', () => openAddressSheet(member)),
      button('Forget', 'btn ghost phone-forget', () => confirmSheet(
        `Forget ${member.pc.name}?`,
        'This phone stops connecting to it and its sessions leave the list, until it is paired again. To cut the phone off from the PC side as well, remove it in Settings on the PC.',
        'Forget',
        () => {
          forget(member.pc.id);
          return Promise.resolve();
        },
      )),
    );
    card.append(row);
    return card;
  }

  function drawPcs(): void {
    page.replaceChildren();
    const head = el('div', 'phone-head');
    head.append(
      button('‹', 'phone-back', () => back()),
      el('div', 'phone-head-title', 'PCs'),
      button('Add PC', 'btn primary', () => go({ kind: 'pair' })),
    );
    const list = el('div', 'phone-list phone-pcs');
    for (const member of fleet.list()) list.append(pcCard(member));
    page.append(head, list);
  }

  function forget(pcId: string): void {
    for (const id of fleet.sessionsOf(pcId)) dropSession(id, false);
    fleet.forget(pcId);
    render();
  }

  // ------------------------------------------------------------- the list
  function sessionRow(session: SessionSnapshot): HTMLElement {
    const isTerminal = session.agent === 'shell';
    const owner = fleet.ownerOf(session.id);
    const online = owner?.connection.state.kind === 'connected';
    const row = el('button', `phone-row${online ? '' : ' is-offline'}`);
    row.type = 'button';
    row.disabled = isTerminal;
    row.append(agentIcon(session.agent));
    const text = el('div', 'phone-row-text');
    const sub = el('div', 'phone-row-sub');
    sub.append(pcTag(owner), el('span', 'phone-row-activity', isTerminal
      ? 'Terminal sessions open on the PC'
      : session.activity ?? shortFolder(session.cwd)));
    text.append(el('div', 'phone-row-title', session.label), sub);
    const waiting = pending.filter((a) => a.sessionId === session.id).length;
    const badge = online
      ? el('div', `phone-status is-${session.status}`, waiting ? `${waiting} to answer` : STATUS_WORD[session.status])
      : el('div', 'phone-status', 'PC offline');
    row.append(text, badge);
    row.onclick = () => go({ kind: 'chat', id: session.id });
    return row;
  }

  function drawList(): void {
    page.replaceChildren();
    const head = el('div', 'phone-head');
    head.append(
      el('div', 'phone-head-title', 'Sessions'),
      button('New', 'btn primary', openNewSession),
      button('PCs', 'btn ghost', () => go({ kind: 'pcs' })),
    );
    const list = el('div', 'phone-list');
    const rows = [...sessions.values()].sort((a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.startedAt - a.startedAt);
    for (const session of rows) list.append(sessionRow(session));
    if (!rows.length) {
      const anyConnected = fleet.list().some((m) => m.connection.state.kind === 'connected');
      list.append(el('div', 'phone-empty', anyConnected
        ? 'No sessions. Start one with New.'
        : 'Sessions appear here once a PC is connected.'));
    }
    page.append(head, list);
  }

  // ------------------------------------------------------------- a conversation
  function capabilitiesFor(session: SessionSnapshot): Record<AgentKind, AgentCapabilities> | null {
    return fleet.ownerOf(session.id)?.capabilities ?? null;
  }

  function interruptAnswer(session: SessionSnapshot): CapabilityAnswer {
    return capabilitiesFor(session)?.[session.agent]['turn-interrupt'] ?? { ok: false, reason: 'Agent capabilities are still loading.' };
  }

  function paneFor(session: SessionSnapshot): ChatPane {
    let pane = panes.get(session.id);
    if (!pane) {
      pane = new ChatPane(session, interruptAnswer(session), (id) => {
        pending = pending.filter((a) => a.id !== id);
        syncPane(session.id);
      }, capabilitiesFor(session));
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
    pane.setCapabilities(capabilitiesFor(session), interruptAnswer(session));
    pane.update(session);
    pane.setApprovals(pending.filter((a) => a.sessionId === id));
  }

  function drawChatHead(session: SessionSnapshot): HTMLElement {
    const head = el('div', 'phone-head phone-chat-head');
    const title = el('div', 'phone-chat-title');
    const sub = el('div', 'phone-chat-sub');
    sub.append(el('span', `phone-status is-${session.status}`, STATUS_WORD[session.status]), pcTag(fleet.ownerOf(session.id)));
    title.append(el('div', 'phone-head-title', session.label), sub);
    head.append(
      button('‹', 'phone-back', () => back()),
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

  function drawChat(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    const pane = paneFor(session);
    page.replaceChildren(drawChatHead(session), pane.element);
    pane.element.classList.add('phone-chat');
    syncPane(session.id);
    if (shownChat !== id) pane.attach();
    shownChat = id;
  }

  /** The chat head's status and PC, redrawn in place so the pane is not disturbed. */
  function refreshChatHead(session: SessionSnapshot): void {
    const sub = page.querySelector('.phone-chat-sub');
    if (!sub) return;
    sub.replaceChildren(el('span', `phone-status is-${session.status}`, STATUS_WORD[session.status]), pcTag(fleet.ownerOf(session.id)));
  }

  function dropSession(id: string, redraw = true): void {
    sessions.delete(id);
    rememberSessions();
    pending = pending.filter((a) => a.sessionId !== id);
    const pane = panes.get(id);
    if (pane) {
      if (shownChat === id) {
        closeSessionMenu();
        shownChat = null;
      }
      pane.dispose();
      panes.delete(id);
      const at = paneOrder.indexOf(id);
      if (at >= 0) paneOrder.splice(at, 1);
    }
    if (!redraw) return;
    if (openId() === id) back();
    else if (top().kind === 'list') drawList();
  }

  // ---------------------------------------------------------------- the feed
  api.onSessionUpdated((session) => {
    sessions.set(session.id, session);
    rememberSessions();
    if (panes.has(session.id)) syncPane(session.id);
    if (openId() === session.id) refreshChatHead(session);
    if (top().kind === 'list') drawList();
  });
  api.onSessionRemoved(({ id }) => dropSession(id));
  api.onApprovalNeeded((request) => {
    if (!pending.some((a) => a.id === request.id)) pending.push(request);
    syncPane(request.sessionId);
    if (top().kind === 'list') drawList();
  });
  api.onApprovalGone((id) => {
    const gone = pending.find((a) => a.id === id);
    pending = pending.filter((a) => a.id !== id);
    if (gone) syncPane(gone.sessionId);
    if (top().kind === 'list') drawList();
  });

  fleet.hooks.state = () => {
    drawBanner();
    const view = top();
    if (view.kind === 'list') drawList();
    else if (view.kind === 'pcs') drawPcs();
    else if (view.kind === 'chat') {
      const session = sessions.get(view.id);
      if (session) refreshChatHead(session);
    }
  };
  /** Everything held for that PC may be stale after a gap, so all of it is asked for again. */
  fleet.hooks.ready = (pcId) => {
    void (async () => {
      const member = fleet.get(pcId) ?? null;
      if (!member) return;
      try {
        const before = fleet.sessionsOf(pcId);
        const [listed, asks, answers] = await Promise.all([
          fleet.listSessions(pcId),
          member.connection.call<PendingApproval[]>('approval/pending'),
          member.connection.call<Record<AgentKind, AgentCapabilities>>('agent/capabilities'),
        ]);
        member.capabilities = answers;
        const kept = new Set(listed.map((s) => s.id));
        for (const id of before) if (!kept.has(id)) dropSession(id);
        for (const session of listed) sessions.set(session.id, session);
        rememberSessions();
        pending = pending.filter((a) => fleet.ownerOf(a.sessionId)?.pc.id !== pcId).concat(asks);
        rememberFolders(pcId);
        for (const id of kept) {
          if (!panes.has(id)) continue;
          syncPane(id);
          panes.get(id)?.catchUp();
        }
        const view = top();
        if (view.kind === 'list') drawList();
        else if (view.kind === 'pcs') drawPcs();
        else if (view.kind === 'chat') {
          const session = sessions.get(view.id);
          if (session) refreshChatHead(session);
        }
      } catch (err) {
        console.error(`[phone] could not read ${member.pc.name} after connecting:`, err);
      }
    })();
  };

  document.addEventListener('visibilitychange', () => fleet.setForeground(!document.hidden));

  fleet.load();
  // Until each PC answers, its sessions are the ones it had last time, shown offline.
  for (const member of fleet.list()) {
    const remembered = readJson<SessionSnapshot[]>(sessionsKey(member.pc.id), []);
    fleet.remember(member.pc.id, remembered);
    for (const session of remembered) if (!sessions.has(session.id)) sessions.set(session.id, session);
  }
  render();
}
