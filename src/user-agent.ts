import { ACTION_VERSION } from './version';

/**
 * User-Agent sent to the AgentMeter API so it can tell which action versions (and pinned
 * refs) are still in use, e.g. before removing deprecated response fields.
 */
export function buildUserAgent({
  ref,
}: {
  /** GITHUB_ACTION_REF — the ref the workflow pinned (e.g. "v1", "main"); empty for `uses: ./` */
  ref?: string;
}): string {
  const base = `agentmeter-action/${ACTION_VERSION}`;
  return ref ? `${base} (ref ${ref})` : base;
}
