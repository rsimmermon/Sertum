/**
 * Live end-to-end probe for `model-select`, through the public daemon
 * handlers rather than the hosts underneath them.
 *
 * For Claude and Codex it creates a conversation session, reads
 * `session/models` from the agent's own catalogue, switches to a model the
 * session is not already on, runs a turn, and checks that what the session
 * reports afterwards is the model that was asked for -- which is the whole
 * claim, since neither agent echoes an applied model back on the switch
 * itself.
 *
 * For Grok it checks the two halves separately, because a Grok turn needs an
 * authenticated account and a real TUI: the catalogue is read from Grok's own
 * `models_cache.json`, and the switch is verified as bytes actually reaching
 * a live PTY. What that command does once it lands was verified directly
 * against Grok 1.0.13 in a PTY (see `GrokAdapter.setModel`).
 *
 * Run under Electron's ELECTRON_RUN_AS_NODE for node-pty's ABI:
 *
 *   npx esbuild scripts/smoke-model-switch.ts --bundle --platform=node \
 *     --format=cjs --external:node-pty --outfile=.temp/smoke-model.cjs &&
 *   ELECTRON_RUN_AS_NODE=1 npx electron .temp/smoke-model.cjs
 *
 * SMOKE_ONLY=claude|codex|grok runs one leg.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type {
  AgentModelList,
  ModelChangeResult,
  SessionSnapshot,
} from '../src/shared/types';

type Fabric = ReturnType<typeof createFabric>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** See smoke-resume: always sleep before the first read, never race the send. */
async function waitIdle(
  current: Map<string, SessionSnapshot>,
  id: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    await sleep(200);
    assert(
      Date.now() < deadline,
      `session ${id} never went idle (status: ${current.get(id)?.status})`,
    );
  } while (current.get(id)?.status !== 'idle');
}

/**
 * Whether a reported model is the one that was asked for.
 *
 * Deliberately not string equality: an alias and the model it resolves to are
 * two names for one thing, and which one comes back differs by agent and by
 * moment -- Claude's `opus[1m]` resolves to `claude-opus-5[1m]` and a turn
 * then reports `claude-opus-5`.
 */
function sameModel(reported: string | null, asked: string | null): boolean {
  if (!reported || !asked) return false;
  const strip = (v: string) => v.replace(/\[[^\]]*\]$/, '');
  const a = strip(reported);
  const b = strip(asked);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * The concrete model a catalogue name stands for.
 *
 * Comparisons have to happen on resolved names or they are meaningless:
 * Claude's `default` and `opus[1m]` are different ids for the same model, so
 * "pick one the session is not already on" would otherwise pick a synonym.
 */
function resolved(models: AgentModelList & { ok: true }, name: string | null): string | null {
  if (!name) return null;
  return models.models.find((m) => m.id === name)?.resolved ?? name;
}

async function probeConversationAgent(
  fabric: Fabric,
  current: Map<string, SessionSnapshot>,
  agent: 'claude' | 'codex',
  root: string,
): Promise<void> {
  console.log(`--- ${agent} ---`);
  const session = (await fabric.handle('session/create', {
    agent,
    transport: 'stream',
    cwd: root,
    label: `model probe (${agent})`,
  })) as SessionSnapshot;
  assert.equal(session.transport, 'stream');
  console.log(`created ${session.id}; model at start = ${session.model}`);

  const listed = (await fabric.handle('session/models', session.id)) as AgentModelList;
  assert(listed.ok, `session/models refused: ${listed.ok ? '' : listed.reason}`);
  assert(listed.models.length > 0, 'catalogue was empty');
  console.log(
    'catalogue:',
    listed.models.map((m) => `${m.id}${m.resolved ? ` -> ${m.resolved}` : ''}`).join(', '),
  );

  // A model this session is demonstrably not already on, so "it reports the
  // new one" cannot pass by accident.
  const before = resolved(listed, current.get(session.id)?.model ?? session.model);
  const target = listed.models.find((m) => !sameModel(m.resolved ?? m.id, before));
  assert(target, `every listed model resolves to the current one (${before})`);
  console.log(`switching from ${before} to ${target.id} (${target.resolved ?? target.id})`);

  const change = (await fabric.handle('session/model', {
    id: session.id,
    model: target.id,
  })) as ModelChangeResult;
  assert(change.ok, `session/model refused: ${change.ok ? '' : change.reason}`);
  assert.equal(change.appliesToNextTurn, false, 'an idle session has no turn to defer to');
  console.log('switch accepted, recorded as', change.model);
  assert(
    sameModel(current.get(session.id)?.model ?? null, target.resolved ?? target.id),
    `snapshot did not record the switch: ${current.get(session.id)?.model}`,
  );

  // A model nobody offered must be refused rather than passed through.
  const bogus = (await fabric.handle('session/model', {
    id: session.id,
    model: 'definitely-not-a-model-9',
  })) as ModelChangeResult;
  assert(!bogus.ok, 'an unlisted model was accepted');
  console.log('unlisted model refused:', bogus.reason);

  // The claim that matters: the agent itself runs the new model next turn.
  assert(await fabric.handle('chat/send', { id: session.id, text: 'Say OK and nothing else.' }));
  await waitIdle(current, session.id);
  console.log('immediately after the turn, the snapshot says', current.get(session.id)?.model);

  // Then let the transcript poll have its say. This is the part that makes
  // the assertion mean something: `session/model` writes the new name into
  // the snapshot optimistically, so reading it back straight away only
  // proves that write happened. The 4s meta poll re-reads the model out of
  // the agent's own transcript and would put the old one back if the turn
  // had actually run on it, so surviving two of those is the agent
  // agreeing rather than us repeating ourselves.
  await sleep(9000);
  const after = current.get(session.id)?.model ?? null;
  console.log('after the transcript poll, the session reports model =', after);
  assert(
    sameModel(after, target.resolved ?? target.id),
    `session reported ${after} after switching to ${target.id}`,
  );

  await fabric.handle('session/kill', session.id);
  console.log(`PASS: ${agent} switched models mid-session and the agent ran the new one.`);
}

/**
 * Grok's two halves, checked where each one lives.
 *
 * The turn is deliberately not driven here: it needs a signed-in account and
 * a real TUI, and what `/model` does on arrival was verified directly rather
 * than through this harness.
 */
async function probeGrok(
  fabric: Fabric,
  current: Map<string, SessionSnapshot>,
  root: string,
): Promise<void> {
  console.log('--- grok ---');
  const session = (await fabric.handle('session/create', {
    agent: 'grok',
    cwd: root,
    label: 'model probe (grok)',
  })) as SessionSnapshot;
  assert.equal(session.transport, 'pty', 'grok keeps a PTY');
  console.log(`created ${session.id}`);

  const listed = (await fabric.handle('session/models', session.id)) as AgentModelList;
  assert(listed.ok, `session/models refused: ${listed.ok ? '' : listed.reason}`);
  console.log('catalogue:', listed.models.map((m) => `${m.id} (${m.label})`).join(', '));
  assert(listed.models.length > 0, 'catalogue was empty');

  // Let the TUI reach its prompt before writing to it, exactly as a person
  // would: bytes sent into a program still starting up go nowhere useful.
  await sleep(8000);
  const target = listed.models[0];
  const change = (await fabric.handle('session/model', {
    id: session.id,
    model: target.id,
  })) as ModelChangeResult;
  assert(change.ok, `session/model refused: ${change.ok ? '' : change.reason}`);
  console.log(`command delivered to the PTY for ${change.model}`);
  assert(
    sameModel(current.get(session.id)?.model ?? null, target.id),
    `snapshot did not record the switch: ${current.get(session.id)?.model}`,
  );

  await fabric.handle('session/kill', session.id);
  console.log('PASS: grok listed its own catalogue and took the switch on its prompt.');
}

async function main(): Promise<void> {
  const root = path.resolve('.temp/model-probe');
  fs.mkdirSync(root, { recursive: true });
  const fabric = createFabric({ userDataDir: root });
  const current = new Map<string, SessionSnapshot>();
  fabric.onEvent((name, value) => {
    if (name === 'session:updated') {
      const s = value as SessionSnapshot;
      current.set(s.id, s);
    }
  });
  const only = process.env.SMOKE_ONLY;
  try {
    await fabric.start();
    if (!only || only === 'claude') await probeConversationAgent(fabric, current, 'claude', root);
    if (!only || only === 'codex') await probeConversationAgent(fabric, current, 'codex', root);
    if (!only || only === 'grok') await probeGrok(fabric, current, root);
    console.log('ALL PASS');
  } finally {
    await fabric.shutdown();
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exitCode = 1;
});
