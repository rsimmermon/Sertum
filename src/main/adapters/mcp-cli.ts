import { spawn } from 'node:child_process';

const MCP_NAME = /^[\p{L}\p{N}_.:@/+ -]{1,200}$/u;

/**
 * Clear one server's credentials through the agent's own CLI.
 *
 * Neither structured protocol exposes logout today, while both CLIs do. The
 * name must have come from that session's own inventory and is restricted
 * again here before it can cross Windows' required cmd.exe boundary.
 */
export function clearMcpAuthentication(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  name: string,
): Promise<{ ok: boolean; message: string }> {
  if (!MCP_NAME.test(name)) {
    return Promise.resolve({
      ok: false,
      message: 'This server name cannot be passed safely to the agent’s logout command.',
    });
  }

  return new Promise((resolve) => {
    const shellCommand = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const file = shellCommand ? (process.env.ComSpec || 'cmd.exe') : command;
    const quoted = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const args = shellCommand
      ? ['/d', '/s', '/c', `${quoted(command)} mcp logout ${quoted(name)}`]
      : ['mcp', 'logout', name];
    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok, message });
    };
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      finish(false, `Could not start the agent’s logout command: ${String(error)}`);
      return;
    }
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-8_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => finish(false, `Could not clear authentication: ${error.message}`));
    child.on('exit', (code) => finish(
      code === 0,
      code === 0
        ? `Cleared authentication for ${name}.`
        : `The agent’s logout command for ${name} exited with code ${code}.`,
    ));
    timer = setTimeout(() => {
      child.kill();
      finish(false, 'The agent’s logout command did not finish in 30 seconds.');
    }, 30_000);
    timer.unref?.();
  });
}
