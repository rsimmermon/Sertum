// Timing and memory for the transcript store against real transcripts on this
// machine. Read-only, and prints sizes and counts, never content.
//
//   npx esbuild scripts/measure-conversation-store.ts --bundle --platform=node \
//     --format=esm --outfile=<tmp>/measure.mjs && node --expose-gc <tmp>/measure.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readConversation,
  readConversationPage,
} from '../src/main/adapters/conversation';
import type { AgentKind, ConversationSnapshot } from '../src/shared/types';

function walk(dir: string, found: Array<{ file: string; size: number }>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name.endsWith('.jsonl')) found.push({ file: full, size: fs.statSync(full).size });
  }
}

const biggest = (dir: string, count: number) => {
  const found: Array<{ file: string; size: number }> = [];
  walk(path.join(os.homedir(), dir), found);
  return found.sort((a, b) => b.size - a.size).slice(0, count);
};

const heap = () => {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().rss / 1048576;
};

for (const [agent, dir] of [['claude', '.claude/projects'], ['codex', '.codex/sessions']] as Array<[AgentKind, string]>) {
  for (const { file, size } of biggest(dir, 3)) {
    const before = heap();
    let worstStall = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      worstStall = Math.max(worstStall, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    const first = await readConversation(agent, file) as ConversationSnapshot;
    const parseMs = performance.now() - started;
    clearInterval(ticker);
    const firstJson = JSON.stringify(first).length;

    const again = performance.now();
    const poll = await readConversation(agent, file, { known: first.version, start: first.start, end: first.total, follow: true });
    const pollMs = performance.now() - again;

    let pages = 0;
    let biggestPage = 0;
    let start = first.start;
    let seen = first.items.length;
    while (start > 0) {
      const page = await readConversationPage(agent, file, { before: start });
      biggestPage = Math.max(biggestPage, JSON.stringify(page).length);
      seen += page.items.length;
      start = page.start;
      pages += 1;
    }
    console.log(JSON.stringify({
      agent,
      fileMB: +(size / 1048576).toFixed(1),
      items: first.total,
      reachable: seen === first.total,
      firstParseMs: Math.round(parseMs),
      worstEventLoopStallMs: Math.round(worstStall),
      firstAnswerMB: +(firstJson / 1048576).toFixed(2),
      idlePollMs: +pollMs.toFixed(1),
      idlePollAnswer: 'unchanged' in poll ? 'unchanged' : 'data',
      pages,
      biggestPageMB: +(biggestPage / 1048576).toFixed(2),
      rssGrowthMB: Math.round(heap() - before),
    }));
  }
}
