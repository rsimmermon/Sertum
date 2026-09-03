import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createFabric } from './daemon/fabric';
import {
  DAEMON_PROTOCOL,
  daemonEndpoint,
  daemonLogFile,
  daemonStateFile,
  sertumHome,
  type DaemonFrame,
  type DaemonState,
} from './shared/daemon-protocol';

/**
 * sertumd — the session broker. Stage 3 of BROKER-HANDOFF.md.
 *
 * Owns every session, adapter and hook endpoint; the Sertum GUI is a
 * disposable client that connects over a named pipe (Windows) or unix
 * socket. Closing the GUI closes nothing here: agents keep running, for
 * every agent alike — the property the Claude-only `--bg` cut could not
 * generalise.
 *
 * Run under the app's own executable with ELECTRON_RUN_AS_NODE=1, so there
 * is no second runtime to install or version-skew against. The GUI spawns it
 * on demand; `daemon/stop` is the deliberate way to end it, and takes every
 * session with it after the same drain the GUI quit used to perform.
 */

const VERSION = process.env.SERTUM_VERSION ?? '0.0.0-dev';
const USER_DATA =
  process.env.SERTUM_USER_DATA ?? path.join(sertumHome(), 'data');

// The daemon has no terminal: its console goes to a log file, which is also
// where "the daemon died and nothing noticed" gets investigated.
fs.mkdirSync(sertumHome(), { recursive: true });
const log = fs.createWriteStream(daemonLogFile(), { flags: 'a' });
const stamp = () => new Date().toISOString();
for (const name of ['log', 'warn', 'error'] as const) {
  console[name] = (...args: unknown[]) => {
    log.write(`${stamp()} ${args.map(String).join(' ')}\n`);
  };
}

const fabric = createFabric({ userDataDir: USER_DATA });

interface Client {
  socket: net.Socket;
  buf: string;
  greeted: boolean;
}
const clients = new Set<Client>();

function send(client: Client, frame: DaemonFrame): void {
  if (client.socket.destroyed) return;
  client.socket.write(`${JSON.stringify(frame)}\n`);
}

fabric.onEvent((name, payload) => {
  for (const client of clients) {
    if (client.greeted) send(client, { t: 'event', name, payload });
  }
});

const server = net.createServer((socket) => {
  const client: Client = { socket, buf: '', greeted: false };
  clients.add(client);
  socket.setNoDelay(true);
  socket.on('data', (chunk) => {
    client.buf += chunk.toString('utf8');
    let at: number;
    while ((at = client.buf.indexOf('\n')) >= 0) {
      const line = client.buf.slice(0, at).trim();
      client.buf = client.buf.slice(at + 1);
      if (line) void handleFrame(client, line);
    }
  });
  const drop = () => clients.delete(client);
  socket.on('close', drop);
  socket.on('error', drop);
});

async function handleFrame(client: Client, line: string): Promise<void> {
  let frame: DaemonFrame;
  try {
    frame = JSON.parse(line) as DaemonFrame;
  } catch {
    return;
  }

  if (frame.t === 'hello') {
    // The handshake is the whole defence against version skew: a client
    // speaking another protocol gets a refusal it can show, never a
    // best-effort conversation that fails somewhere quieter.
    if (frame.protocol !== DAEMON_PROTOCOL) {
      send(client, {
        t: 'res',
        id: 0,
        ok: false,
        error: `protocol ${frame.protocol} != daemon protocol ${DAEMON_PROTOCOL} (daemon ${VERSION}); stop the daemon and let the app restart it`,
      });
      client.socket.end();
      return;
    }
    client.greeted = true;
    send(client, { t: 'hello', protocol: DAEMON_PROTOCOL, version: VERSION });
    return;
  }

  if (frame.t !== 'req' || !client.greeted) return;
  const { id, method, params } = frame;

  if (method === 'daemon/stop') {
    send(client, { t: 'res', id, ok: true, result: null });
    console.log('[sertumd] stop requested; shutting down');
    void stop(0);
    return;
  }
  if (method === 'daemon/ping') {
    send(client, {
      t: 'res',
      id,
      ok: true,
      result: { version: VERSION, pid: process.pid },
    });
    return;
  }

  try {
    const result = await fabric.handle(method, params);
    send(client, { t: 'res', id, ok: true, result: result ?? null });
  } catch (err) {
    send(client, {
      t: 'res',
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The drain the GUI quit used to perform, now owned by the process that owns
 * the PTYs: kill everything, give node-pty's exit callbacks a moment to land
 * in a live environment, then leave without running the teardown the race
 * needs. See QUIT_DRAIN_MS's history in AGENTS.md.
 */
const QUIT_DRAIN_MS = 250;
let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  await fabric.shutdown();
  try {
    fs.unlinkSync(daemonStateFile());
  } catch {
    // Never written, or already gone.
  }
  server.close();
  setTimeout(() => process.exit(code), QUIT_DRAIN_MS);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void stop(0));
}

const endpoint = daemonEndpoint();

server.on('error', (err) => {
  // Another daemon already holds the endpoint: this one is redundant, and
  // exiting quietly is what lets two GUIs race the spawn without harm.
  console.error('[sertumd] listen failed:', err.message);
  process.exit(0);
});

// A unix socket path left by a dead daemon refuses the bind; a live one is
// detected by the client before it ever spawns us, so unlinking is safe here.
if (process.platform !== 'win32') {
  try {
    fs.unlinkSync(endpoint);
  } catch {
    // Not there.
  }
}

server.listen(endpoint, () => {
  const state: DaemonState = {
    protocol: DAEMON_PROTOCOL,
    version: VERSION,
    pid: process.pid,
    endpoint,
    startedAt: Date.now(),
  };
  fs.writeFileSync(daemonStateFile(), JSON.stringify(state, null, 2));
  console.log(
    `[sertumd] v${VERSION} protocol ${DAEMON_PROTOCOL} listening on ${endpoint}`,
  );
  void fabric.start();
});
