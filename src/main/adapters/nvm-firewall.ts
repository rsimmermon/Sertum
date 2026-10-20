import { spawn } from 'node:child_process';
import path from 'node:path';
import { firstExecutable, resolveOnWindowsPath } from './binary-resolve';
import { inspectProcessTree } from '../process-tree';
import type { CodexRepair } from '../../shared/types';

/**
 * nvm for Windows' module firewall, as it meets the Codex app server.
 *
 * That nvm fingerprints every global package's shim when it is trusted and
 * refuses to run one that has changed since -- which is precisely what
 * `npm i -g @openai/codex` does to `codex.cmd` on every update. The refusal is
 * printed on stderr and the process exits 1, so after any Codex update the
 * app server never starts until someone re-trusts it:
 *
 *   NVM Firewall: Untrusted module 'codex' changed after running. ...
 *   File: C:\...\nvm\installs\v20.20.2\codex.cmd
 *   Reason: delegated script changed since it was trusted
 *   Event code: NVM4306
 *
 * The repair is nvm's own: `nvm reshim` re-trusts the current entrypoints,
 * and `nvm firewall trust module add` puts the module on the allow list that
 * nvm re-shims automatically after a self-update, so the next Codex update
 * does not repeat this. Both relax a check the user's nvm is making on their
 * behalf, so they only ever run from an explicit confirmation in the UI --
 * never because a start failed.
 */

const EVENT_CODE = /Event code:\s*NVM4306/;
const MODULE = /Untrusted module '([^']+)'/;
const SHIM_FILE = /^File:\s*(.+)$/m;
/** The question itself, as a process: `nvm.exe firewall prompt-trust codex`. */
const PROMPT = /nvm(?:\.exe)?"?\s+firewall\s+prompt-trust\s+"?([^\s"]+)/i;
const NVM_EXE = /"([^"]*\\nvm\.exe)"/i;

/**
 * Finds nvm's trust question waiting under a process that never answered.
 *
 * That refusal only reaches stderr when nvm has a console to ask in. Under
 * the headless daemon it has none: nvm's `codex.exe` shim starts
 * `nvm.exe firewall prompt-trust codex`, which waits for a [y/N] nobody can
 * see, and the app server simply never comes up -- no output, no exit. The
 * waiting process is the only evidence, so it is read from the process
 * table, the same structured source the reaper uses; nothing is inferred from
 * output going quiet.
 *
 * Returns a message in the shape `nvmFirewallRepair` recognises, or null.
 */
export async function nvmTrustPromptUnder(rootPid: number | null): Promise<string | null> {
  if (process.platform !== 'win32' || rootPid === null) return null;
  const tree = await inspectProcessTree(rootPid);
  const waiting = tree.find((p) => PROMPT.test(p.command));
  if (!waiting) return null;
  const module = PROMPT.exec(waiting.command)?.[1] ?? 'codex';
  return (
    `nvm's firewall is asking whether to trust '${module}', which changed since it ` +
    'was last trusted (an update does this), and is waiting for a [y/N] answer ' +
    'in a console that a background process does not have.\n' +
    `Waiting on: ${waiting.command}`
  );
}

/** The repair for a refusal this module recognises, or null for anything else. */
export function nvmFirewallRepair(stderr: string | null): CodexRepair | null {
  if (!stderr) return null;
  const module = EVENT_CODE.test(stderr)
    ? MODULE.exec(stderr)?.[1]
    : PROMPT.exec(stderr)?.[1];
  // The name is fed back to nvm as an argument, so only a plain package name
  // or scope is accepted -- never whatever the message happened to contain.
  if (!module || !/^[@a-z0-9][\w./@-]*$/i.test(module)) return null;
  return {
    kind: 'nvm-trust',
    module,
    commands: [`nvm firewall trust module add ${module}`, 'nvm reshim'],
  };
}

/** Runs the repair's commands in order, stopping at the first that fails. */
export async function runNvmRepair(
  repair: CodexRepair,
  stderr: string,
): Promise<{ ok: boolean; reason?: string }> {
  const nvm = resolveNvm(stderr);
  if (!nvm) return { ok: false, reason: 'nvm.exe could not be found on PATH.' };
  const steps: string[][] = [
    ['firewall', 'trust', 'module', 'add', repair.module],
    ['reshim'],
  ];
  for (const args of steps) {
    const result = await runQuiet(nvm, args);
    if (result.code !== 0) {
      const said = result.output.trim();
      return {
        ok: false,
        reason: `nvm ${args.join(' ')} failed${said ? `: ${said}` : ` (exit ${result.code})`}`,
      };
    }
  }
  return { ok: true };
}

/**
 * nvm.exe from PATH, else the one seen asking, else from the shim path the
 * refusal names -- nvm keeps its installs beside itself, as
 * `<nvm>\installs\<version>\codex.cmd`.
 */
function resolveNvm(stderr: string): string | null {
  const onPath = resolveOnWindowsPath('nvm');
  if (onPath) return onPath;
  const seen = NVM_EXE.exec(stderr)?.[1];
  if (seen && firstExecutable([seen])) return seen;
  const shim = SHIM_FILE.exec(stderr)?.[1]?.trim();
  if (!shim) return null;
  return firstExecutable([path.join(path.dirname(shim), '..', '..', 'nvm.exe')]);
}

/**
 * stdin is closed rather than piped: nvm asks "[y/N]" when it can, and a
 * question nobody can see would hold this call until the timeout.
 */
function runQuiet(
  file: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, output: (err as Error).message });
      return;
    }
    const collect = (d: Buffer) => { output = (output + d.toString()).slice(-2_000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
