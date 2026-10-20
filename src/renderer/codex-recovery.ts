import type { AdapterStatus, CodexRecovery } from '../shared/types';

/**
 * The way back when the Codex app server refused to start.
 *
 * Opened from the status bar's "Codex app server offline" and from a failed
 * Codex start in C1. It shows the refusal in the words of whatever made it --
 * the app server's own stderr -- and offers what can be done from here:
 *
 * - **Retry** restarts the app server, for a cause fixed outside Sertum (a
 *   reinstall, a trust granted in a terminal) without restarting the daemon
 *   and every session in it.
 * - **Trust and retry** appears only for a refusal the daemon recognises and
 *   knows the fix for -- today nvm for Windows' firewall rejecting a
 *   `codex.cmd` an update rewrote. It relaxes a check the user's own nvm is
 *   making, so it is never automatic: the commands it will run are shown
 *   here, and nothing runs until the button is pressed.
 *
 * Resolves true once the server is up.
 */
export function openCodexRecovery(status: AdapterStatus['codex']): Promise<boolean> {
  const api = window.sertum;
  return new Promise((resolve) => {
    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog codex-recovery');
    overlay.append(dlg);

    dlg.append(text('h3', 'Codex app server is not running', ''));
    dlg.append(
      text(
        'p',
        'Codex sessions are hosted by a private app server, and it did not start. ' +
          'This is what it said:',
        'dialog-sub',
      ),
    );
    const errorBox = text(
      'pre',
      status.error ?? 'It exited without saying why. ~/.sertum/sertumd.log may have more.',
      'codex-recovery-error',
    );
    dlg.append(errorBox);

    const repair = status.repair;
    if (repair?.kind === 'nvm-trust') {
      dlg.append(
        text(
          'p',
          `nvm's firewall refused '${repair.module}' because its shim changed since it ` +
            'was trusted -- which every update of it does. If you made that update, ' +
            'Sertum can run nvm\'s own fix:',
          'dialog-sub',
        ),
        text('pre', repair.commands.join('\n'), 'codex-recovery-commands'),
        text(
          'p',
          `This also adds '${repair.module}' to nvm's trusted modules, so later updates ` +
            'are re-shimmed automatically instead of being blocked. If you did not ' +
            'update it, do not trust it; find out what changed the file.',
          'confirm-warning',
        ),
      );
    }

    const note = el('div', 'note');
    dlg.append(note);

    const actions = el('div', 'dialog-actions');
    const close = button('Close', 'btn ghost', () => finish(false));
    const retry = button('Retry', repair ? 'btn' : 'btn primary', () =>
      void attempt(() => api.restartCodexServer(), 'Restarting the Codex app server…'),
    );
    actions.append(el('div', 'grow'), close, retry);
    if (repair) {
      actions.append(
        button('Trust and retry', 'btn primary', () =>
          void attempt(() => api.repairCodexServer(), 'Running nvm, then restarting…'),
        ),
      );
    }
    dlg.append(actions);

    async function attempt(run: () => Promise<CodexRecovery>, busy: string): Promise<void> {
      setBusy(true);
      setNote('', busy);
      let result: CodexRecovery;
      try {
        result = await run();
      } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      setBusy(false);
      if (result.ok) {
        finish(true);
        return;
      }
      // The new refusal replaces the old one; it may be a different problem.
      const reason = (result.reason ?? 'It is still not running.').replace(
        /^Codex app server is unavailable: /,
        '',
      );
      errorBox.textContent = reason;
      setNote('error', 'Still not running.');
    }

    function setBusy(busy: boolean): void {
      for (const b of actions.querySelectorAll('button')) b.disabled = busy;
    }

    function setNote(kind: '' | 'error', message: string): void {
      note.className = kind ? `note ${kind}` : 'note';
      note.textContent = message;
    }

    function finish(up: boolean): void {
      overlay.remove();
      resolve(up);
    }

    // Neither a backdrop click nor Escape is an answer: every route out of a
    // modal goes through one of its own buttons. See "Modals answer, they do
    // not vanish" in AGENTS.md.

    document.body.append(overlay);
    close.focus();
  });
}

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function text(tag: string, content: string, cls: string): HTMLElement {
  const node = el(tag, cls);
  node.textContent = content;
  return node;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}
