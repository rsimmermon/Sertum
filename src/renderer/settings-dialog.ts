import {
  DEFAULT_SETTINGS,
  SCROLLBACK_CHOICES,
  type ManagedAgent,
  type Settings,
  type TabPlacement,
} from '../shared/types';

const api = window.sertum;

/**
 * Settings — wireframes E1–E7 (frames L5YbBc, ueGO4, T8iqS5, DOU2x, ZMHK6,
 * WY30G, JFRlZ).
 *
 * One window, a nav down the left, one pane at a time. Every control applies
 * live rather than on a Save button: type size and theme are things you judge
 * by looking at them, and hiding the result behind a commit step makes you
 * guess. Cancel restores the settings captured on open, so live preview stays
 * safe to explore.
 *
 * Controls whose subsystem does not exist yet are rendered disabled carrying
 * the reason, the same way a declined agent capability reads. A switch that
 * silently switches nothing is worse than one that says why it cannot.
 */
export function openSettingsDialog(
  current: Settings,
  onPreview: (s: Settings) => void,
  muted: { list: () => Array<{ id: string; label: string }>; unmute: (id: string) => void } = {
    list: () => [],
    unmute: () => undefined,
  },
): Promise<Settings | null> {
  return new Promise((resolve) => {
    const opened: Settings = { ...current };
    let working: Settings = { ...current };

    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog settings-dialog');
    overlay.append(dlg);

    const apply = (patch: Partial<Settings>) => {
      working = { ...working, ...patch };
      onPreview(working);
    };

    const head = el('div', 'set-header');
    head.append(text('h3', 'Settings', ''));
    dlg.append(head);

    const body = el('div', 'set-body');
    const nav = el('div', 'set-nav');
    const content = el('div', 'set-content');
    body.append(nav, content);
    dlg.append(body);

    const PANES: Array<{ id: string; label: string; build: () => HTMLElement }> = [
      { id: 'general', label: 'General', build: general },
      { id: 'agents', label: 'Agents & permissions', build: agents },
      { id: 'terminal', label: 'Terminal', build: terminal },
      { id: 'worktrees', label: 'Worktrees', build: worktrees },
      { id: 'notifications', label: 'Notifications', build: notifications },
      { id: 'appearance', label: 'Appearance & shortcuts', build: appearance },
      { id: 'advanced', label: 'Advanced', build: advanced },
    ];

    const navButtons = new Map<string, HTMLButtonElement>();
    const show = (id: string): void => {
      for (const [key, btn] of navButtons) btn.classList.toggle('on', key === id);
      const pane = PANES.find((p) => p.id === id);
      content.replaceChildren(pane ? pane.build() : el('div', ''));
      content.scrollTop = 0;
    };
    for (const pane of PANES) {
      const b = button(pane.label, 'set-nav-item', () => show(pane.id));
      navButtons.set(pane.id, b);
      nav.append(b);
    }

    // ------------------------------------------------------ E1 · General
    function general(): HTMLElement {
      const pane = group();
      pane.append(sectionHead('Startup'));
      pane.append(
        declined(
          'Restore sessions on launch',
          'Would resume from transcript with claude --resume / codex resume',
          'Session restore is not built. PTYs die with the app, so there is nothing to restore from yet.',
        ),
        declined(
          'Launch at login',
          'Start Sertum when you sign in',
          'Not wired to the OS login-item API yet.',
        ),
      );

      pane.append(sectionHead('Sessions'));
      pane.append(
        field(
          'Default pane layout',
          select(
            [
              ['single', 'Single'],
              ['columns', 'Columns'],
              ['rows', 'Rows'],
              ['grid', 'Grid'],
            ],
            working.paneLayout,
            (v) => apply({ paneLayout: v as Settings['paneLayout'] }),
          ),
          'New windows open Single; this presets the split you get from ⌘⌥D.',
        ),
        declined(
          'Default agent',
          'Preselected in the New Session dialog',
          'Not stored yet — C1 remembers the last agent you picked instead.',
        ),
        declined(
          'Max concurrent sessions',
          'Soft warning above this count',
          'No session budget is enforced or counted.',
        ),
      );

      pane.append(sectionHead('Repositories'));
      pane.append(
        declined(
          'Known repositories',
          'Add, edit and forget repositories (C17)',
          'C17 is not built. C1 offers recent folders instead.',
        ),
      );
      return pane;
    }

    // ------------------------------- E2 · Agents & permissions
    function agents(): HTMLElement {
      const pane = group();
      pane.append(sectionHead('Adapters'));
      pane.append(
        note(
          'A blank path auto-detects: candidate install locations first, then ' +
            'PATH. Set one explicitly when a CLI lives somewhere unusual.',
        ),
      );

      const AGENT_FIELDS: Array<{ key: ManagedAgent; label: string }> = [
        { key: 'claude', label: 'Claude Code' },
        { key: 'codex', label: 'Codex' },
        { key: 'grok', label: 'Grok' },
      ];

      for (const a of AGENT_FIELDS) {
        const pathInput = document.createElement('input');
        pathInput.type = 'text';
        pathInput.className = 'field';
        pathInput.spellcheck = false;
        pathInput.placeholder = 'Auto-detect';
        pathInput.value = working.agentBinaryPaths[a.key];
        pathInput.setAttribute('aria-label', `${a.label} executable path`);

        const status = el('div', 'note');
        const setNote = (kind: '' | 'ok' | 'warn' | 'error', msg: string) => {
          status.className = kind ? `note ${kind}` : 'note';
          status.textContent = msg;
        };

        const setPath = (value: string) => {
          pathInput.value = value;
          apply({
            agentBinaryPaths: { ...working.agentBinaryPaths, [a.key]: value.trim() },
          });
        };
        pathInput.oninput = () => setPath(pathInput.value);

        const browse = button('Browse…', 'btn ghost', async () => {
          const picked = await api.pickFile(pathInput.value || undefined);
          if (!picked) return;
          setPath(picked);
          setNote('ok', `Set to ${picked}`);
        });
        const detect = button('Detect', 'btn ghost', async () => {
          setNote('', 'Checking…');
          const result = await api.detectAgentBinary(a.key);
          if (result.path) {
            setPath(result.path);
            setNote('ok', `Found at ${result.path}`);
          } else {
            setNote(
              'error',
              'Not found on PATH or in common install locations — set it ' +
                'manually with Browse…, or install the CLI.',
            );
          }
        });

        const row = el('div', 'row');
        row.append(pathInput, browse, detect);
        const stack = el('div', 'setting-stack');
        stack.append(row, status);
        pane.append(field(a.label, stack, 'Leave blank to auto-detect.', true));
      }

      pane.append(sectionHead('Permission rules'));
      pane.append(
        declined(
          'Allow, deny and ask rules',
          'Per-command rules scoped to a repository',
          'There is no permission-rules engine. Claude tool use can be paused ' +
            'wholesale from a session’s row menu, which is the only gate that exists.',
        ),
      );
      return pane;
    }

    // ----------------------------------------------------- E3 · Terminal
    function terminal(): HTMLElement {
      const pane = group();
      pane.append(sectionHead('Appearance'));

      const family = document.createElement('input');
      family.type = 'text';
      family.className = 'field';
      family.spellcheck = false;
      family.placeholder = 'Default monospace stack';
      family.value = working.terminalFontFamily;
      family.oninput = () => apply({ terminalFontFamily: family.value });
      pane.append(
        field('Font family', family, 'Blank uses the built-in stack.', true),
        field(
          'Font size',
          stepper(working.terminalFontSize, (v) => apply({ terminalFontSize: v })),
          'Agent output and input.',
        ),
        field(
          'Line height',
          select(
            [
              ['1', 'Tight (1.0)'],
              ['1.2', 'Normal (1.2)'],
              ['1.4', 'Relaxed (1.4)'],
              ['1.6', 'Loose (1.6)'],
            ],
            String(working.terminalLineHeight),
            (v) => apply({ terminalLineHeight: Number(v) }),
          ),
        ),
        field(
          'Cursor style',
          select(
            [
              ['block-blink', 'Block, blinking'],
              ['block', 'Block, steady'],
              ['bar-blink', 'Bar, blinking'],
              ['bar', 'Bar, steady'],
              ['underline-blink', 'Underline, blinking'],
              ['underline', 'Underline, steady'],
            ],
            working.terminalCursorStyle,
            (v) => apply({ terminalCursorStyle: v as Settings['terminalCursorStyle'] }),
          ),
        ),
      );

      pane.append(sectionHead('Behaviour'));
      const scrollHint = el('div', 'note');
      const describeScrollback = (lines: number): string =>
        `≈${Math.round((lines * 180) / 1_000_000 * 10) / 10} MB per session at this setting`;
      scrollHint.textContent = describeScrollback(working.terminalScrollback);
      const scrollStack = el('div', 'setting-stack');
      scrollStack.append(
        select(
          SCROLLBACK_CHOICES.map(
            (n) => [String(n), n.toLocaleString()] as [string, string],
          ),
          String(working.terminalScrollback),
          (v) => {
            apply({ terminalScrollback: Number(v) });
            scrollHint.textContent = describeScrollback(Number(v));
          },
        ),
        scrollHint,
      );
      pane.append(
        field('Scrollback lines', scrollStack, 'Applies to new sessions.', true),
        toggle('Copy on select', working.terminalCopyOnSelect, (v) =>
          apply({ terminalCopyOnSelect: v }),
        ),
        field(
          'Renderer',
          select(
            [
              ['webgl', 'WebGL'],
              ['canvas', 'Canvas'],
            ],
            working.terminalRenderer,
            (v) => apply({ terminalRenderer: v as Settings['terminalRenderer'] }),
          ),
          'WebGL falls back to canvas automatically.',
        ),
        declined(
          'Restore scrollback on reattach',
          'Already always on',
          'Nothing to switch: the xterm instance is cached per session, so its ' +
            'buffer already survives every detach, layout change and reattach. ' +
            'A PTY that exited has no buffer to restore either way.',
        ),
      );
      pane.append(
        note(
          'Very large scrollback across many tabs is the main memory cost in ' +
            'the app. Eight sessions at 10,000 lines is roughly 110 MB.',
        ),
      );
      return pane;
    }

    // ---------------------------------------------------- E4 · Worktrees
    function worktrees(): HTMLElement {
      const pane = group();
      pane.append(sectionHead('Defaults'));
      pane.append(
        declined(
          'Repository',
          'Scope these settings to one repository',
          'Per-repository overrides are not stored. These defaults apply everywhere.',
        ),
        field(
          'Base branch',
          select(
            [
              ['fresh', 'fresh — branch from the remote default'],
              ['head', 'head — carry unpushed local work'],
            ],
            working.worktreeBase,
            (v) => apply({ worktreeBase: v as Settings['worktreeBase'] }),
          ),
        ),
      );

      pane.append(
        declined(
          'Worktree location',
          'Where managed worktrees are created',
          'Managed worktrees live under a single root outside the repository ' +
            '(~/.sertum/worktrees). That prefix is what lets Sertum tell its ' +
            'own worktrees from yours, so it is not configurable per repo.',
        ),
        declined(
          'Remove worktree when closing a clean tab',
          'Off by default: losing work is worse than disk usage',
          'Closing a tab does not reclaim its worktree yet. Remove one ' +
            'deliberately from the worktree manager (C9).',
        ),
        note(
          'A managed worktree is kept when its session ends rather than ' +
            'deleted, so returning to the same branch skips reinstalling ' +
            'everything git does not carry across.',
        ),
      );

      pane.append(sectionHead('Bootstrap command'));
      const bootstrap = document.createElement('input');
      bootstrap.type = 'text';
      bootstrap.className = 'field';
      bootstrap.spellcheck = false;
      bootstrap.placeholder = 'e.g. dotnet restore, pnpm install, uv sync';
      bootstrap.value = working.worktreeBootstrap;
      bootstrap.oninput = () => apply({ worktreeBootstrap: bootstrap.value });
      pane.append(
        field(
          'Run after creating a worktree',
          bootstrap,
          'Runs in the new worktree before the agent starts. Blank runs nothing.',
          true,
        ),
        declined(
          '.worktreeinclude editor',
          'Gitignored files copied into every new worktree',
          'Not built here yet. Edit .worktreeinclude at the repository root; ' +
            'C9 already reads the same file.',
        ),
      );
      return pane;
    }

    // ------------------------------------------------ E5 · Notifications
    function notifications(): HTMLElement {
      const pane = group();
      pane.append(sectionHead('Notify me when'));
      pane.append(
        toggle('A session needs input', working.notifyNeedsInput, (v) =>
          apply({ notifyNeedsInput: v }),
        ),
        toggle('A session fails', working.notifyFailed, (v) =>
          apply({ notifyFailed: v }),
        ),
        toggle('A session finishes', working.notifyFinished, (v) =>
          apply({ notifyFinished: v }),
        ),
        field(
          'A long turn passes a threshold',
          select(
            [
              ['0', 'Never'],
              ['5', '5 minutes'],
              ['10', '10 minutes'],
              ['30', '30 minutes'],
            ],
            String(working.notifyLongTurnMinutes),
            (v) => apply({ notifyLongTurnMinutes: Number(v) }),
          ),
          'Fires once per turn.',
        ),
      );
      pane.append(
        note(
          'Notifications fire from adapter events, not from screen output. ' +
            'They are exact, which is what lets the defaults be this narrow: ' +
            'a working session never interrupts you.',
        ),
      );

      pane.append(sectionHead('Delivery'));
      pane.append(
        toggle(
          'Only when the window is not focused',
          working.notifyOnlyWhenUnfocused,
          (v) => apply({ notifyOnlyWhenUnfocused: v }),
        ),
        toggle('Play a sound', working.notifySound, (v) => apply({ notifySound: v })),
        field(
          'Badge the app icon with the needs-input count',
          checkbox(working.notifyBadge, (v) => apply({ notifyBadge: v })),
          'macOS and Linux only — Windows has no dock badge to set.',
        ),
        field(
          'Snooze duration',
          select(
            [
              ['5', '5 minutes'],
              ['10', '10 minutes'],
              ['30', '30 minutes'],
              ['60', '1 hour'],
            ],
            String(working.notifySnoozeMinutes),
            (v) => apply({ notifySnoozeMinutes: Number(v) }),
          ),
          'Offered on every notification.',
        ),
      );

      pane.append(sectionHead('Per session'));
      const rows = muted.list();
      if (!rows.length) {
        pane.append(
          note(
            'Nothing is muted. Mute a session from its row menu to silence it ' +
              'until it finishes.',
          ),
        );
      }
      for (const row of rows) {
        const unmute = button('Unmute', 'btn ghost', () => {
          muted.unmute(row.id);
          show('notifications');
        });
        pane.append(field(row.label, unmute, 'Muted until it finishes.'));
      }
      return pane;
    }

    // --------------------------------- E6 · Appearance & shortcuts
    function appearance(): HTMLElement {
      const pane = group();
      pane.append(sectionHead('Appearance'));
      pane.append(
        field(
          'Theme',
          select(
            [
              ['system', 'Follow system'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ],
            working.theme,
            (v) => apply({ theme: v as Settings['theme'] }),
          ),
        ),
        field(
          'Accent colour',
          select(
            [
              ['blue', 'Blue'],
              ['violet', 'Violet'],
              ['green', 'Green'],
              ['amber', 'Amber'],
            ],
            working.accent,
            (v) => apply({ accent: v as Settings['accent'] }),
          ),
        ),
        toggle('Compact sidebar rows', working.compactRows, (v) =>
          apply({ compactRows: v }),
        ),
      );

      const placements: Array<{ id: TabPlacement; label: string; hint: string }> = [
        { id: 'side', label: 'Side', hint: 'Session list only' },
        { id: 'top', label: 'Top', hint: 'Horizontal tab strip only' },
        { id: 'both', label: 'Both', hint: 'Strip and list together' },
      ];
      const placementRow = el('div', 'seg');
      const placementButtons = new Map<TabPlacement, HTMLButtonElement>();
      for (const p of placements) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-btn' + (working.tabPlacement === p.id ? ' on' : '');
        b.textContent = p.label;
        b.title = p.hint;
        b.onclick = () => {
          for (const [id, btn] of placementButtons) btn.classList.toggle('on', id === p.id);
          apply({ tabPlacement: p.id });
        };
        placementButtons.set(p.id, b);
        placementRow.append(b);
      }
      pane.append(field('Tabs', placementRow, 'Where session tabs appear.'));
      pane.append(
        toggle('Model and effort badges', working.showChips, (v) =>
          apply({ showChips: v }),
        ),
      );

      pane.append(sectionHead('Type size'));
      const sizes: Array<{ key: keyof Settings; label: string; hint: string }> = [
        { key: 'terminalFontSize', label: 'Terminal', hint: 'Agent output and input' },
        { key: 'tabFontSize', label: 'Tab labels', hint: 'Top strip, when shown' },
        { key: 'listFontSize', label: 'Session list', hint: 'Sidebar rows' },
        { key: 'uiFontSize', label: 'Interface', hint: 'Menus, dialogs, status bar' },
      ];
      for (const s of sizes) {
        pane.append(
          field(
            s.label,
            stepper(working[s.key] as number, (v) =>
              apply({ [s.key]: v } as Partial<Settings>),
            ),
            s.hint,
          ),
        );
      }

      pane.append(sectionHead('Shortcuts'));
      pane.append(
        declined(
          'Remap shortcuts',
          'Every binding listed in C23',
          'Shortcuts are fixed in the application menu; there is no keybinding ' +
            'registry to rebind against.',
        ),
      );
      return pane;
    }

    // ---------------------------------------------------- E7 · Advanced
    function advanced(): HTMLElement {
      const pane = group();
      pane.append(sectionHead('Platform'));
      pane.append(
        field('PTY backend', chip('HEALTHY', 'ok'), 'node-pty — ConPTY on Windows, forkpty elsewhere.'),
        declined(
          'WSL mode',
          'Native and WSL sessions cannot see each other',
          'Only native sessions are supported.',
        ),
      );

      pane.append(sectionHead('Diagnostics'));
      pane.append(
        declined(
          'Log level and event history',
          'Would feed C10 and C14',
          'No diagnostics store exists; logs go to the console.',
        ),
      );

      pane.append(sectionHead('Storage'));
      pane.append(
        declined(
          'Session database',
          'Vacuum stored session records',
          'Sertum keeps no database. Settings are a single JSON file and ' +
            'transcripts belong to the agents.',
        ),
        declined(
          'Terminal scrollback cache',
          'Clear buffered output',
          'Scrollback lives in xterm in memory and goes when a session does. ' +
            'Its size is capped on the Terminal pane.',
        ),
      );

      pane.append(sectionHead('Reset'));
      const resetRow = el('div', 'row');
      resetRow.append(
        button('Reset all settings', 'btn danger', () => {
          working = { ...DEFAULT_SETTINGS, sidebarWidth: working.sidebarWidth };
          onPreview(working);
          show('advanced');
        }),
      );
      pane.append(
        field(
          'Reset all settings',
          resetRow,
          'Restores every preference to its default. Sessions are untouched.',
          true,
        ),
      );
      return pane;
    }

    // ---------------------------------------------------------- actions
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', 'btn ghost', () => close(null));
    const done = button('Done', 'btn primary', () => close(working));
    actions.append(spacer(), cancel, done);
    dlg.append(actions);

    function close(result: Settings | null): void {
      // Cancel puts back exactly what was showing when the dialog opened.
      if (!result) onPreview(opened);
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };

    show('general');
    document.body.append(overlay);
    navButtons.get('general')?.focus();
  });
}

/** A control that exists so its reason can be read, not to be operated. */
function declined(label: string, hint: string, reason: string): HTMLElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.disabled = true;
  const wrap = el('label', 'check is-declined');
  wrap.append(box, text('span', 'Not available', ''));
  wrap.title = reason;
  const row = field(label, wrap, hint || undefined);
  row.classList.add('is-declined');
  row.title = reason;
  return row;
}

function toggle(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
  hint?: string,
): HTMLElement {
  return field(label, checkbox(value, onChange), hint);
}

function checkbox(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = value;
  box.onchange = () => onChange(box.checked);
  const wrap = el('label', 'check');
  wrap.append(box, text('span', 'On', ''));
  return wrap;
}

function select(
  options: Array<[string, string]>,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const node = document.createElement('select');
  node.className = 'field';
  for (const [id, label] of options) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    if (id === value) option.selected = true;
    node.append(option);
  }
  node.onchange = () => onChange(node.value);
  return node;
}

function chip(label: string, tone: string): HTMLElement {
  return text('span', label, `minichip ${tone}`);
}

function note(message: string): HTMLElement {
  return text('div', message, 'set-note');
}

function group(): HTMLElement {
  return el('div', 'set-pane');
}

/** −/+ around a number, so a size can be nudged without selecting text. */
function stepper(value: number, onChange: (v: number) => void): HTMLElement {
  let current = value;
  const wrap = el('div', 'stepper');
  const out = el('span', 'stepper-value');
  out.textContent = `${current} pt`;

  const step = (delta: number) => {
    const next = Math.min(32, Math.max(8, current + delta));
    if (next === current) return;
    current = next;
    out.textContent = `${current} pt`;
    onChange(current);
  };

  wrap.append(
    button('−', 'stepper-btn', () => step(-1)),
    out,
    button('+', 'stepper-btn', () => step(1)),
  );
  return wrap;
}

/** `fill` gives the control the rest of the row rather than hugging it right. */
function field(
  label: string,
  control: HTMLElement,
  hint?: string,
  fill = false,
): HTMLElement {
  const row = el('div', 'setting-row' + (fill ? ' fill' : ''));
  const left = el('div', 'setting-label');
  left.append(text('span', label, 'setting-name'));
  if (hint) left.append(text('span', hint, 'setting-hint'));
  row.append(left, control);
  return row;
}

function sectionHead(label: string): HTMLElement {
  return text('div', label, 'setting-section');
}

function spacer(): HTMLElement {
  return el('div', 'grow');
}

function button(
  label: string,
  cls: string,
  action: () => void | Promise<void>,
): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = cls;
  node.textContent = label;
  node.onclick = () => void action();
  return node;
}

function text(tag: string, content: string, cls: string): HTMLElement {
  const node = el(tag, cls);
  node.textContent = content;
  return node;
}

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}
