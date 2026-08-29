import type { AdapterStatus, AgentKind } from '../shared/types';
import { agentName } from './chips';

const api = window.sertum;

/**
 * The agent catalogue, and the one popup that offers it.
 *
 * A segmented row of buttons was fine for two agents and is already crowded at
 * four; it cannot survive ten, and it cannot say the two things that matter as
 * the list grows -- that a shell is not an AI agent, and that an agent whose
 * CLI is missing cannot start. Both are structural, so the list is grouped and
 * each row carries its own availability.
 *
 * Adding an agent is a row in AGENT_GROUPS. Every surface that offers a choice
 * reads from here, so none of them has to be found and edited separately.
 */
export interface AgentGroup {
  title: string;
  agents: AgentKind[];
}

export const AGENT_GROUPS: AgentGroup[] = [
  { title: 'AI agents', agents: ['claude', 'codex', 'grok'] },
  // Its own group rather than a fourth button: a shell has no agent to speak
  // of, no status adapter and no model, and it is where shell profiles will
  // land when they arrive.
  { title: 'Shell', agents: ['shell'] },
];

export const ALL_AGENTS: AgentKind[] = AGENT_GROUPS.flatMap((g) => g.agents);

/**
 * Below this many, a permanent search box is clutter -- the whole list is on
 * screen already. Typing filters at any size, and the box appears the moment
 * it is doing something.
 */
const FILTER_THRESHOLD = 6;

/**
 * What was last known about each agent's CLI.
 *
 * Module-level so the list can be right on the first paint. Availability is a
 * round trip to main, and a popup that opens with four rows and then drops to
 * two has already shown you the wrong answer -- so the last poll is what the
 * list is built from, and a fresh answer only corrects it.
 *
 * Unknown means shown. A missing entry is "we have not asked yet", never
 * "absent": failing open costs a row that cannot start and says why, while
 * failing closed hides an agent that works.
 */
const availability = new Map<AgentKind, boolean>();

/** Feeds the cache from the status the app already polls. */
export function noteAgentAvailability(status: AdapterStatus): void {
  availability.set('claude', status.claude.binaryFound);
  availability.set('codex', status.codex.binaryFound);
  availability.set('grok', status.grok.binaryFound);
  // A shell is whatever the environment already is, so there is nothing to
  // find and nothing that could be missing.
  availability.set('shell', true);
}

export interface AgentPickerOptions {
  /** Ticked in the list, and where the keyboard cursor starts. */
  current?: AgentKind | null;
  /** Offered at the foot of the list, for a CLI that could not be found. */
  onManage?: () => void;
}

let open: HTMLElement | null = null;

/** Closes the picker if one is open. Safe to call when none is. */
export function closeAgentPicker(): void {
  open?.remove();
  open = null;
}

/**
 * Opens the agent list under `anchor`, resolving with the chosen agent.
 *
 * Resolves null when dismissed, so a caller can tell "cancelled" from "picked
 * the one already selected" -- the split button needs that difference, since
 * dismissing it must not start a session.
 */
export function openAgentPicker(
  anchor: HTMLElement,
  opts: AgentPickerOptions = {},
): Promise<AgentKind | null> {
  closeAgentPicker();

  return new Promise((resolve) => {
    const menu = document.createElement('div');
    menu.className = 'ctx-menu agent-picker';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Choose an agent');

    let filter = '';
    const filterRow = document.createElement('div');
    filterRow.className = 'agent-filter';
    const filterText = document.createElement('span');
    filterText.className = 'agent-filter-text';
    filterRow.append(filterText);
    menu.append(filterRow);

    const list = document.createElement('div');
    list.className = 'agent-list';
    menu.append(list);

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ctx-item agent-more';
    more.hidden = true;
    more.title = 'Show the agents whose CLI could not be found';
    more.onclick = () => {
      showAll = true;
      draw();
    };
    menu.append(more);

    if (opts.onManage) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      const manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'ctx-item';
      manage.textContent = 'Manage agents…';
      manage.onclick = () => {
        const go = opts.onManage;
        finish(null);
        go?.();
      };
      menu.append(sep, manage);
    }

    let rows: Array<{ agent: AgentKind; el: HTMLButtonElement }> = [];
    let cursor = 0;
    /** Set by the footer, to see the agents that are not installed. */
    let showAll = false;

    /**
     * Whether an agent belongs in the list as it currently stands.
     *
     * The default list is what this machine can actually run. Three things
     * override that, and each is the user asking: a filter is an explicit
     * search and must not pretend a named agent does not exist; the agent
     * already chosen stays visible so the row and the list cannot disagree;
     * and the footer reveals the rest.
     */
    const visible = (agent: AgentKind, needle: string): boolean => {
      if (needle || showAll || agent === opts.current) return true;
      return availability.get(agent) !== false;
    };

    const draw = () => {
      list.replaceChildren();
      rows = [];
      const needle = filter.toLowerCase();
      const missing = ALL_AGENTS.filter((a) => availability.get(a) === false);

      for (const group of AGENT_GROUPS) {
        const matches = group.agents.filter(
          (a) =>
            agentName(a).toLowerCase().includes(needle) && visible(a, needle),
        );
        if (matches.length === 0) continue;

        const head = document.createElement('div');
        head.className = 'agent-group';
        head.textContent = group.title;
        list.append(head);

        for (const agent of matches) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'ctx-item agent-row';
          if (agent === opts.current) row.classList.add('on');

          const dot = document.createElement('span');
          dot.className = 'agent-dot agent-' + agent;
          const name = document.createElement('span');
          name.className = 'agent-row-name';
          name.textContent = agentName(agent);
          const left = document.createElement('span');
          left.className = 'agent-row-left';
          left.append(dot, name);
          row.append(left);

          // Availability is the one thing a picker can say that a button row
          // cannot. A missing CLI stays selectable: the honest next step is
          // Settings, not a dead row with no explanation.
          if (availability.get(agent) === false) {
            const warn = document.createElement('span');
            warn.className = 'ctx-accel agent-missing';
            warn.textContent = 'not found';
            row.append(warn);
            row.title =
              agentName(agent) +
              ' is not installed, or its path is not set — Settings › Agents';
          }

          row.onclick = () => finish(agent);
          list.append(row);
          rows.push({ agent, el: row });
        }
      }

      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'agent-empty';
        empty.textContent = needle ? 'No agent matches' : 'No agent installed';
        list.append(empty);
      }

      // The way back to what was left out. Without it, an agent installed
      // later would be invisible with nothing to say it could exist.
      const hiddenNow = showAll || filter ? 0 : missing.length;
      more.hidden = hiddenNow === 0;
      more.textContent = hiddenNow + ' not installed — show';

      cursor = Math.min(cursor, Math.max(0, rows.length - 1));
      highlight();
    };

    const highlight = () => {
      rows.forEach((r, i) => r.el.classList.toggle('cursor', i === cursor));
    };

    const showFilter = () => {
      const on = filter.length > 0 || ALL_AGENTS.length > FILTER_THRESHOLD;
      filterRow.hidden = !on;
      filterText.textContent = filter || 'Type to filter…';
      filterText.classList.toggle('empty', filter.length === 0);
    };

    /**
     * A key the picker acts on is a key nothing else may see.
     *
     * Both surfaces that open this sit inside something else that reads the
     * keyboard: the New Session dialog creates the session on Enter and
     * dismisses on Escape. Without stopping the event there, choosing an agent
     * with the keyboard would also submit the dialog -- with whichever agent
     * was selected *before* the pick, since the dialog's handler runs
     * synchronously and this one only resolves a promise. Verified: it created
     * a session behind the open picker.
     *
     * Stopping is not enough on its own, which is why the listener is on
     * `window` rather than `document` -- see below.
     */
    const consume = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        consume(e);
        finish(null);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        consume(e);
        if (rows.length === 0) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        cursor = (cursor + step + rows.length) % rows.length;
        highlight();
        return;
      }
      if (e.key === 'Enter') {
        consume(e);
        if (rows[cursor]) finish(rows[cursor].agent);
        return;
      }
      if (e.key === 'Backspace') {
        consume(e);
        filter = filter.slice(0, -1);
        showFilter();
        draw();
        return;
      }
      // Type-to-filter with no focused input: the popup owns the keyboard
      // while it is up, so these keystrokes have nowhere else to go.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        consume(e);
        filter += e.key;
        showFilter();
        draw();
      }
    };

    const onPointerDown = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) finish(null);
    };

    function finish(agent: AgentKind | null) {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      closeAgentPicker();
      resolve(agent);
    }

    showFilter();
    draw();

    document.body.append(menu);
    open = menu;
    position(menu, anchor);

    // On `window`, not `document`: the dialog underneath also captures on
    // `document`, and capture listeners on the same node run in registration
    // order -- so the dialog, having opened first, would see every key before
    // this popup and no amount of stopping here would come soon enough. window
    // is one step earlier in the capture path, which is what makes the popup
    // able to own the keyboard while it is up.
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointerDown, true);

    // Availability arrives a beat later. The list is useful before it does, so
    // it is folded in on arrival rather than waited for.
    void api
      .adapterStatus()
      .then((status) => {
        noteAgentAvailability(status);
        if (open === menu) draw();
      })
      .catch(() => {
        // No answer is not the same as "missing": leave the rows unmarked.
      });

    // Start on the current agent, so Enter repeats the last choice.
    const at = rows.findIndex((r) => r.agent === opts.current);
    if (at >= 0) {
      cursor = at;
      highlight();
    }
  });
}

/** Below the anchor, nudged back inside the window when it would overflow. */
function position(menu: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const gap = 4;
  let left = a.left;
  let top = a.bottom + gap;
  if (left + m.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - 8 - m.width);
  }
  if (top + m.height > window.innerHeight - 8) {
    top = Math.max(8, a.top - gap - m.height);
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}
