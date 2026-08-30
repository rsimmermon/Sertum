import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { Settings, SessionSnapshot } from '../shared/types';

const api = window.sertum;

/**
 * One xterm instance bound to one PTY.
 *
 * Kept deliberately dumb: it renders bytes and forwards keystrokes. It never
 * inspects output to decide what the agent is doing -- that is the adapters'
 * job. Instances are cached so switching tabs preserves scrollback without
 * touching the process.
 */
export class TerminalPane {
  readonly element: HTMLDivElement;
  private term: Terminal;
  private fit: FitAddon;
  private serialize: SerializeAddon;
  private disposers: Array<() => void> = [];
  private resizeObserver: ResizeObserver;
  private attached = false;
  private renderer: Settings['terminalRenderer'];
  private copyOnSelect = false;

  constructor(
    readonly session: SessionSnapshot,
    settings: Settings,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'term-host';
    this.renderer = settings.terminalRenderer;

    this.term = new Terminal({
      fontFamily: terminalFontFamily(settings),
      fontSize: settings.terminalFontSize,
      lineHeight: settings.terminalLineHeight,
      scrollback: settings.terminalScrollback,
      ...cursorOptions(settings.terminalCursorStyle),
      allowProposedApi: true,
      theme: readTerminalTheme(),
    });

    this.fit = new FitAddon();
    this.serialize = new SerializeAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.serialize);

    this.copyOnSelect = settings.terminalCopyOnSelect;

    // Keystrokes go straight to the PTY.
    this.disposers.push(
      this.term.onData((data) => api.write(this.session.id, data)).dispose,
    );

    // Copy on select, when asked for. The selection is left in place: clearing
    // it here would fight the Ctrl+C handler, which clears deliberately so a
    // stale selection cannot keep swallowing interrupts.
    this.disposers.push(
      this.term.onSelectionChange(() => {
        if (!this.copyOnSelect) return;
        const selection = this.term.getSelection();
        if (selection) void api.copyText(selection);
      }).dispose,
    );

    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Shift/Ctrl/Alt+Enter (Cmd+Enter on macOS) insert a newline rather than
      // submitting. xterm sends a bare CR for all of them, which every agent
      // reads as "send the message". ESC+CR is the sequence Claude Code's own
      // `/terminal-setup` installs for Shift+Enter, and Codex reads it as
      // Alt+Enter, so one sequence covers both.
      if (e.key === 'Enter' && newlineChord(e)) {
        e.preventDefault();
        api.write(this.session.id, '\x1b\r');
        return false;
      }

      // Ctrl+C copies only when there is a selection to copy; with nothing
      // selected it stays the interrupt that stops whatever the agent is
      // doing. Copying clears the selection, so a second press interrupts
      // instead of silently re-copying the same text.
      if (isCopyChord(e) && this.term.hasSelection()) {
        e.preventDefault();
        void api.copyText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }

      // Ctrl+V (Cmd+V on macOS) pastes. Taken over from the browser's own
      // paste handling because an image has to become something a byte stream
      // can carry before xterm ever sees it.
      if (isPasteChord(e)) {
        e.preventDefault();
        void this.pasteClipboard();
        return false;
      }

      return true;
    });

    // Every xterm resize must be mirrored to the PTY or the agent's TUI
    // redraws against stale geometry.
    this.disposers.push(
      this.term.onResize(({ cols, rows }) =>
        api.resize(this.session.id, { cols, rows }),
      ).dispose,
    );

    this.resizeObserver = new ResizeObserver(() => this.refit());
  }

  /**
   * Mount into the DOM. Safe to call repeatedly.
   *
   * Deliberately does not take keyboard focus: with a split layout the last
   * pane mounted would otherwise steal it from the focused one, so the app
   * focuses the pane it actually means.
   */
  mount(parent: HTMLElement): void {
    parent.appendChild(this.element);
    this.attach();
  }

  /**
   * Opens xterm against the host element, once.
   *
   * Separate from `mount` because the pane grid puts `element` in place itself
   * -- the element has to already be in the document when this runs, since
   * xterm measures it to work out its cell size.
   */
  attach(): void {
    if (this.attached) return;
    this.term.open(this.element);
    if (this.renderer === 'webgl') {
      try {
        this.term.loadAddon(new WebglAddon());
      } catch {
        // Canvas fallback is automatic; nothing to do.
      }
    }
    this.attached = true;
    this.resizeObserver.observe(this.element);
    this.refit();
  }

  /** Detach from the DOM without destroying the buffer. */
  unmount(): void {
    this.element.remove();
  }

  write(data: string): void {
    this.term.write(data);
  }

  /** Terminal-visible notice, used for process exit. */
  writeNotice(text: string): void {
    this.term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
  }

  focus(): void {
    this.term.focus();
  }

  /**
   * Put the system clipboard into this PTY.
   *
   * Goes through `term.paste` rather than a raw write so bracketed-paste mode
   * is honoured -- an agent's composer has to be able to tell a pasted block
   * from typing, or a multi-line paste submits on its first newline.
   *
   * An image cannot travel down a PTY, so it arrives as the path to a file the
   * agent can read. Both Claude Code and Codex treat an image path in the
   * prompt as an image; a plain shell just sees the path, which is the least
   * surprising thing it could see.
   */
  private async pasteClipboard(): Promise<void> {
    const item = await api.readClipboard();
    if (item.kind === 'text') this.term.paste(item.text);
    if (item.kind === 'image') this.term.paste(`${quotedPath(item.path)} `);
  }

  /** Scrollback as text, for restoring a pane later. */
  snapshot(): string {
    return this.serialize.serialize();
  }

  /**
   * Applies a new type size and re-fits. Changing the size changes how many
   * cells fit, so the PTY must be told the new geometry or the agent's TUI
   * keeps drawing against the old one.
   */
  setFontSize(size: number): void {
    if (this.term.options.fontSize === size) return;
    this.term.options.fontSize = size;
    this.refit();
  }

  /**
   * Applies E3's preferences to a live terminal.
   *
   * Anything that changes the cell box -- family, size, line height -- ends in
   * a refit, because the PTY has to be told the new geometry or the agent's
   * TUI keeps drawing against the old one. `scrollback` is applied here too,
   * which xterm honours by trimming an over-long buffer immediately; the
   * renderer choice is not, since an addon cannot be swapped under a live
   * terminal and the next session picks it up.
   */
  applySettings(settings: Settings): void {
    const options = this.term.options;
    const family = terminalFontFamily(settings);
    const cursor = cursorOptions(settings.terminalCursorStyle);
    const geometryChanged =
      options.fontFamily !== family ||
      options.fontSize !== settings.terminalFontSize ||
      options.lineHeight !== settings.terminalLineHeight;

    options.fontFamily = family;
    options.fontSize = settings.terminalFontSize;
    options.lineHeight = settings.terminalLineHeight;
    options.scrollback = settings.terminalScrollback;
    options.cursorStyle = cursor.cursorStyle;
    options.cursorBlink = cursor.cursorBlink;
    this.copyOnSelect = settings.terminalCopyOnSelect;

    if (geometryChanged) this.refit();
  }

  refit(): void {
    if (!this.attached) return;
    // A hidden pane has zero size; fitting then would resize the PTY to 0.
    if (this.element.clientWidth < 20 || this.element.clientHeight < 20) return;
    try {
      this.fit.fit();
    } catch {
      // Layout can be mid-flight.
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    for (const d of this.disposers) d();
    this.term.dispose();
    this.element.remove();
  }
}

function readTerminalTheme() {
  const css = getComputedStyle(document.body);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--term-bg', '#10171a'),
    foreground: v('--term-fg', '#c8d6d8'),
    cursor: v('--accent', '#2563eb'),
    selectionBackground: '#2f4f57',
  };
}

/**
 * True for the Enter chords that mean "newline, not submit".
 *
 * Deliberately exact about modifiers: Ctrl/Cmd+Alt+Enter is the maximise-pane
 * accelerator, so a chord carrying both must fall through to the menu.
 */
function newlineChord(e: KeyboardEvent): boolean {
  const mods = [e.shiftKey, e.ctrlKey, e.altKey, e.metaKey].filter(Boolean);
  if (mods.length !== 1) return false;
  if (e.metaKey) return api.platform === 'darwin';
  return true;
}

/**
 * True for a bare Ctrl+C -- the chord that is copy-with-a-selection and
 * interrupt without one.
 *
 * Matched on `key` rather than `code` so it follows the user's layout, and
 * lower-cased because Caps Lock reports 'C'.
 */
function isCopyChord(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  return e.key.toLowerCase() === 'c';
}

/** True for a bare Ctrl+V, or Cmd+V on macOS. */
function isPasteChord(e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== 'v' || e.altKey || e.shiftKey) return false;
  if (e.metaKey) return !e.ctrlKey && api.platform === 'darwin';
  return e.ctrlKey;
}

/**
 * A pasted path, quoted only when it needs to be.
 *
 * Bare is what an agent's path detection expects; quoting unconditionally
 * would put quotes in front of every user who never had a space in a path.
 */
function quotedPath(target: string): string {
  return /\s/.test(target) ? `"${target}"` : target;
}

/**
 * The configured family, falling back to the stylesheet's own mono stack.
 * Read at call time rather than captured, so a theme that changes the stack
 * is picked up on the next apply.
 */
function terminalFontFamily(settings: Settings): string {
  const chosen = settings.terminalFontFamily.trim();
  const fallback = getComputedStyle(document.body)
    .getPropertyValue('--font-mono')
    .trim();
  return chosen ? `${chosen}, ${fallback}` : fallback;
}

/** E3 offers one list; xterm wants a style and a blink flag. */
function cursorOptions(style: Settings['terminalCursorStyle']): {
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
} {
  const blink = style.endsWith('-blink');
  const base = blink ? style.slice(0, -'-blink'.length) : style;
  return {
    cursorStyle: base as 'block' | 'bar' | 'underline',
    cursorBlink: blink,
  };
}
