import type { TokenCounts } from './types';

/**
 * Sums all four token types into the same total the AgentMeter API reports as `totalTokens`.
 */
export function sumTokens(tokens: TokenCounts): number {
  return (
    tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  );
}
