import fs from 'node:fs';
import path from 'node:path';
import type { PermissionDecision, PermissionRule } from '../shared/types';

/**
 * Permission rules — wireframe E2, and the store B5's "Always allow" writes to.
 *
 * This is the tool gate made selective. The gate already proves the
 * mechanism: Claude's `PreToolUse` hook is a structured decision point that
 * accepts `allow` or `deny` and attributes to exactly one session, so rules
 * need no new channel — only a matcher in front of the answer.
 *
 * Kept in its own file rather than in `settings.json`. Rules are a growing
 * list with their own lifecycle, and a corrupt or hand-edited entry should
 * cost the user that rule rather than every display preference they have set.
 */
let cached: PermissionRule[] | null = null;

/**
 * Where the rules file lives. Injected rather than asked of Electron: rules
 * are evaluated in sertumd, which is not an Electron app. The daemon sets
 * this at boot from the directory the GUI hands it, so the file stays where
 * it always was — the GUI's userData folder.
 */
let storageDir: string | null = null;

export function setRulesDir(dir: string): void {
  storageDir = dir;
  cached = null;
}

function file(): string {
  if (!storageDir) throw new Error('permission-rules: storage dir not set');
  return path.join(storageDir, 'permission-rules.json');
}

export function getRules(): PermissionRule[] {
  if (cached) return cached;
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    // First run, or a file we cannot use. No rules is always valid.
  }
  cached = Array.isArray(parsed) ? parsed.flatMap(sanitize) : [];
  return cached;
}

export function setRules(rules: PermissionRule[]): PermissionRule[] {
  cached = rules.flatMap(sanitize);
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cached, null, 2));
  } catch (err) {
    console.error('[sertum] could not save permission rules:', err);
  }
  return cached;
}

export function addRule(rule: Omit<PermissionRule, 'id'>): PermissionRule[] {
  return setRules([
    ...getRules(),
    { ...rule, id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  ]);
}

export function removeRule(id: string): PermissionRule[] {
  return setRules(getRules().filter((rule) => rule.id !== id));
}

/**
 * What the rules say about one tool call.
 *
 * **Deny wins.** When several rules match, a single deny beats any number of
 * allows, and no match at all is `ask`. A permission control that resolves
 * ambiguity by permitting is not a permission control; the cost of failing
 * closed is one extra prompt, and the cost of failing open is the command the
 * user wrote a rule to stop.
 */
export function evaluate(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): { decision: PermissionDecision; rule: PermissionRule | null } {
  const subject = subjectOf(toolName, toolInput);
  const matches = getRules().filter(
    (rule) =>
      matchesTool(rule.tool, toolName) &&
      inScope(rule.scope, cwd) &&
      matchesPattern(rule.pattern, subject),
  );
  if (!matches.length) return { decision: 'ask', rule: null };

  const deny = matches.find((rule) => rule.decision === 'deny');
  if (deny) return { decision: 'deny', rule: deny };
  const allow = matches.find((rule) => rule.decision === 'allow');
  if (allow) return { decision: 'allow', rule: allow };
  return { decision: 'ask', rule: matches[0] };
}

/**
 * The string a pattern is matched against.
 *
 * A rule about `dotnet build *` is about the command, not about the word
 * "Bash", so each tool contributes the field a person would actually write a
 * rule against. Anything without an obvious one matches on its tool name
 * alone, which a bare `*` pattern still covers.
 */
export function subjectOf(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const pick = (key: string): string | null =>
    typeof toolInput[key] === 'string' ? (toolInput[key] as string) : null;
  return (
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('url') ??
    toolName
  );
}

/** `*` matches any tool, otherwise an exact (case-insensitive) name. */
function matchesTool(rule: string, toolName: string): boolean {
  return rule === '*' || rule.toLowerCase() === toolName.toLowerCase();
}

/**
 * A rule is either global or bound to one repository, matched by prefix so it
 * covers the worktrees beneath it too.
 */
function inScope(scope: string, cwd: string): boolean {
  if (scope === '*') return true;
  const rel = path.relative(path.resolve(scope), path.resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Glob matching, deliberately limited to `*`.
 *
 * Full regex in a permission rule is a foot-gun: the character that makes a
 * pattern broader than intended is invisible in a settings row. `*` spans any
 * run of characters and every other character is literal, so what a rule
 * covers can be read off the row.
 */
export function matchesPattern(pattern: string, subject: string): boolean {
  if (!pattern || pattern === '*') return true;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(subject.trim());
}

function sanitize(raw: unknown): PermissionRule[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const decision = r.decision;
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') return [];
  const pattern = typeof r.pattern === 'string' ? r.pattern.trim() : '';
  if (!pattern) return [];
  return [
    {
      id: typeof r.id === 'string' && r.id ? r.id : `rule-${Math.random().toString(36).slice(2)}`,
      tool: typeof r.tool === 'string' && r.tool.trim() ? r.tool.trim() : '*',
      pattern,
      scope: typeof r.scope === 'string' && r.scope.trim() ? r.scope.trim() : '*',
      decision,
    },
  ];
}
