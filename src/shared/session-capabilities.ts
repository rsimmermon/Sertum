import type { AgentCapabilities, AgentCapability, CapabilityAnswer, SessionSnapshot } from './types';

/** Stream denotes structured ownership, independent of the agent or wire protocol. */
export function hasStructuredTransport(s: Pick<SessionSnapshot, 'transport'>): boolean {
  return s.transport === 'stream';
}

/** One answer shared by the daemon and every control surface. */
export function sessionCapability(
  s: SessionSnapshot,
  capabilities: AgentCapabilities | undefined,
  capability: AgentCapability,
): CapabilityAnswer {
  const answer = capabilities?.[capability];
  if (!answer) return { ok: false, reason: 'Agent capabilities are still loading.' };
  if (!answer.ok) return answer;
  if (s.exitCode !== null) return { ok: false, reason: 'The session has exited.' };
  if (s.origin !== 'owned') return { ok: false, reason: 'Sertum does not own this session.' };
  if (answer.requires === 'structured-conversation' && !hasStructuredTransport(s)) {
    return { ok: false, reason: 'This control requires a structured conversation session. Use the agent’s terminal controls for this session.' };
  }
  return answer;
}
