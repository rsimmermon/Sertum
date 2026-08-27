import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { SessionSnapshot } from '../shared/types';

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

  constructor(readonly session: SessionSnapshot) {
    this.element = document.createElement('div');
    this.element.className = 'term-host';

    this.term = new Terminal({
      fontFamily: getComputedStyle(document.body)
        .getPropertyValue('--font-mono')
        .trim(),
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: readTerminalTheme(),
    });

    this.fit = new FitAddon();
    this.serialize = new SerializeAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.serialize);

    // Keystrokes go straight to the PTY.
    this.disposers.push(
      this.term.onData((data) => api.write(this.session.id, data)).dispose,
    );

    // Every xterm resize must be mirrored to the PTY or the agent's TUI
    // redraws against stale geometry.
    this.disposers.push(
      this.term.onResize(({ cols, rows }) =>
        api.resize(this.session.id, { cols, rows }),
      ).dispose,
    );

    this.resizeObserver = new ResizeObserver(() => this.refit());
  }

  /** Mount into the DOM. Safe to call repeatedly. */
  mount(parent: HTMLElement): void {
    parent.appendChild(this.element);
    if (!this.attached) {
      this.term.open(this.element);
      try {
        this.term.loadAddon(new WebglAddon());
      } catch {
        // Canvas fallback is automatic; nothing to do.
      }
      this.attached = true;
      this.resizeObserver.observe(this.element);
    }
    this.refit();
    this.term.focus();
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

  /** Scrollback as text, for restoring a pane later. */
  snapshot(): string {
    return this.serialize.serialize();
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
