/**
 * Live end-to-end probe for `thinking-level`, through the public daemon
 * handlers rather than the hosts underneath them.
 *
 * `smoke-model-switch.ts`'s twin, and deliberately shaped like it: create a
 * conversation session, read `session/efforts` from the agent's own
 * catalogue, switch to a level the session is not already on, and check that
 * what the session reports afterwards is that level.
 *
 * The one extra thing checked here has no equivalent on the model side.
 * Claude Code accepts an unusable level over `apply_flag_settings` with a
 * plain success and then ignores it -- verified against 2.1.266, where
 * `effortLevel: "bogus"` answered `{"subtype":"success"}` with the level
 * unchanged -- so `ClaudeChatHost.setEffort` reads the level back and calls
 * an unchanged one a refusal. That read-back is the load-bearing part of this
 * feature, so the probe asserts a level really moved rather than trusting the
 * success it was handed.
 *
 * For Grok only the two halves are checked, for the same reason the model
 * probe checks only those: a turn needs a signed-in account and a real TUI.
 * The catalogue is read from Grok's own `models_cache.json`, and the switch
 * is verified as bytes reaching a live PTY. `/model <name> <effort>` was
 * verified directly against Grok 1.0.13 (see `GrokAdapter.setEffort`).
 *
 * Run under Electron's ELECTRON_RUN_AS_NODE for node-pty's ABI:
 *
 *   npx esbuild scripts/smoke-effort-switch.ts --bundle --platform=node \
 *     --format=cjs --external:node-pty --outfile=.temp/smoke-effort.cjs &&
 *   ELECTRON_RUN_AS_NODE=1 npx electron .temp/smoke-effort.cjs
 *
 * SMOKE_ONLY=claude|codex|grok runs one leg.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFabric } from '../src/daemon/fabric';
import type {
  AgentEffortList,
  EffortChangeResult,
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
    label: `effort probe (${agent})`,
  })) as SessionSnapshot;
  assert.equal(session.transport, 'stream');
  console.log(`created ${session.id}; effort at start = ${session.effort}`);

  const listed = (await fabric.handle('session/efforts', session.id)) as AgentEffortList;
  assert(listed.ok, `session/efforts refused: ${listed.ok ? '' : listed.reason}`);
  assert(listed.efforts.length > 1, 'a ladder with one rung cannot be switched');
  console.log('catalogue:', listed.efforts.map((e) => e.id).join(', '));

  // A level this session is demonstrably not already on, so "it reports the
  // new one" cannot pass by accident.
  const before = current.get(session.id)?.effort ?? session.effort;
  const target = listed.efforts.find((e) => e.id !== before);
  assert(target, `every listed level is the current one (${before})`);
  console.log(`switching from ${before} to ${target.id}`);

  const change = (await fabric.handle('session/effort', {
    id: session.id,
    effort: target.id,
  })) as EffortChangeResult;
  assert(change.ok, `session/effort refused: ${change.ok ? '' : change.reason}`);
  assert.equal(change.appliesToNextTurn, false, 'an idle session has no turn to defer to');
  // The level the adapter read back, which is the whole point of reading it
  // back: a success that left the session where it was is not a switch.
  assert.notEqual(change.effort, before, 'the reported level did not move');
  console.log('switch accepted, session now reports', change.effort);
  assert.equal(
    current.get(session.id)?.effort,
    change.effort,
    `snapshot did not record the switch: ${current.get(session.id)?.effort}`,
  );

  // A level nobody offered must be refused rather than passed through --
  // which is exactly the case Claude answers with a bare success.
  const bogus = (await fabric.handle('session/effort', {
    id: session.id,
    effort: 'definitely-not-a-level-9',
  })) as EffortChangeResult;
  assert(!bogus.ok, 'an unlisted level was accepted');
  console.log('unlisted level refused:', bogus.reason);

  // The claim that matters: the agent itself runs the new level next turn,
  // and a turn does not put the old one back.
  assert(await fabric.handle('chat/send', { id: session.id, text: 'Say OK and nothing else.' }));
  await waitIdle(current, session.id);
  await sleep(9000);
  const after = current.get(session.id)?.effort ?? null;
  console.log('after the transcript poll, the session reports effort =', after);
  assert.equal(after, change.effort, `session reported ${after} after switching to ${change.effort}`);

  await fabric.handle('session/kill', session.id);
  console.log(`PASS: ${agent} switched thinking level mid-session and kept it across a turn.`);
}

/**
 * Grok's two halves, checked where each one lives.
 *
 * Its level is set by naming it alongside the model in one `/model` command,
 * so this leg also covers the precondition that has no equivalent elsewhere:
 * with no model reported, there is no command to write, and the adapter says
 * so rather than inventing a model name.
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
    label: 'effort probe (grok)',
  })) as SessionSnapshot;
  assert.equal(session.transport, 'pty', 'grok keeps a PTY');
  console.log(`created ${session.id}`);

  // Before a turn has named a model there is no ladder to read, because the
  // ladder belongs to a model. Saying so is the correct answer.
  const early = (await fabric.handle('session/efforts', session.id)) as AgentEffortList;
  if (!early.ok) console.log('with no model reported yet:', early.reason);

  // Give the TUI its prompt, and plane 2 a chance to name the model.
  await sleep(8000);
  const model = current.get(session.id)?.model ?? null;
  if (!model) {
    console.log('SKIP: grok has not named a model for this session, so there is no ladder yet.');
    await fabric.handle('session/kill', session.id);
    return;
  }

  const listed = (await fabric.handle('session/efforts', session.id)) as AgentEffortList;
  assert(listed.ok, `session/efforts refused: ${listed.ok ? '' : listed.reason}`);
  console.log('catalogue:', listed.efforts.map((e) => `${e.id} (${e.label})`).join(', '));
  assert(listed.efforts.length > 0, 'catalogue was empty');

  const target = listed.efforts.find((e) => e.id !== current.get(session.id)?.effort);
  assert(target, 'every listed level is the current one');
  const change = (await fabric.handle('session/effort', {
    id: session.id,
    effort: target.id,
  })) as EffortChangeResult;
  assert(change.ok, `session/effort refused: ${change.ok ? '' : change.reason}`);
  console.log(`command delivered to the PTY for ${change.effort}`);

  await fabric.handle('session/kill', session.id);
  console.log('PASS: grok listed its own ladder and took the switch on its prompt.');
}

async function main(): Promise<void> {
  const root = path.resolve('.temp/effort-probe');
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
