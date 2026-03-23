import type {
  ClaudeCodeOutput,
  CodexExecTurnCompleted,
  CodexTokenEvent,
  TokenCounts,
  TokenCountsWithMeta,
} from './types';

/**
 * Attempts to extract token counts from agent stdout.
 * Tries Claude JSON, Codex JSONL, then falls back to regex extraction.
 * Returns null if no token data can be found.
 */
export function extractTokensFromOutput(
  agentOutput: string
): { tokens: TokenCounts; isApproximate: boolean } | null {
  if (!agentOutput) return null;

  const jsonResult = tryExtractFromJson(agentOutput);
  if (jsonResult) return jsonResult;

  const codexExecResult = tryExtractFromCodexExecJsonl(agentOutput);
  if (codexExecResult) return codexExecResult;

  const codexResult = tryExtractFromCodexJsonl(agentOutput);
  if (codexResult) return codexResult;

  return tryExtractFromText(agentOutput);
}

/**
 * Tries to parse agent output as JSON and extract usage data.
 */
function tryExtractFromJson(
  agentOutput: string
): { tokens: TokenCounts; isApproximate: boolean } | null {
  try {
    const parsed = JSON.parse(agentOutput) as ClaudeCodeOutput;
    const usage = parsed.usage ?? parsed.result?.usage;

    if (!usage) return null;

    return {
      tokens: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
      isApproximate: false,
    };
  } catch {
    return null;
  }
}

/**
 * Tries to extract token counts from `codex exec --json` stdout.
 * Sums `usage` fields across all `turn.completed` events.
 *
 * Field mapping:
 *   input_tokens        → inputTokens
 *   output_tokens       → outputTokens
 *   cached_input_tokens → cacheReadTokens
 */
function tryExtractFromCodexExecJsonl(
  agentOutput: string
): { tokens: TokenCounts; isApproximate: boolean } | null {
  const lines = agentOutput.split('\n');
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let found = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes('"turn.completed"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const obj =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
      if (obj?.['type'] !== 'turn.completed') continue;
      const usage = obj['usage'];
      if (typeof usage !== 'object' || usage === null) continue;
      const u = usage as CodexExecTurnCompleted['usage'];
      inputTokens += u.input_tokens ?? 0;
      outputTokens += u.output_tokens ?? 0;
      cacheReadTokens += u.cached_input_tokens ?? 0;
      found = true;
    } catch {
      // not valid JSON, skip line
    }
  }

  if (!found) return null;

  return {
    tokens: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
    },
    isApproximate: false,
  };
}

/**
 * Tries to extract token counts from Codex CLI JSONL streaming output.
 * Looks for `token_count` events emitted by `codex exec` and takes the last one,
 * which reflects cumulative totals for the full session.
 *
 * Codex field mapping:
 *   input_tokens        → inputTokens
 *   output_tokens       → outputTokens
 *   cached_input_tokens → cacheReadTokens  (prompt cache hits)
 *   (no cache write field — OpenAI does not bill separately for cache writes)
 */
function tryExtractFromCodexJsonl(
  agentOutput: string
): { tokens: TokenCounts; isApproximate: boolean } | null {
  const lines = agentOutput.split('\n');
  let lastTokenEvent: CodexTokenEvent | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes('"token_count"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const obj =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
      if (obj?.['type'] === 'event_msg') {
        const payload = obj['payload'];
        if (typeof payload === 'object' && payload !== null) {
          const p = payload as Record<string, unknown>;
          if (p['type'] === 'token_count') {
            lastTokenEvent = parsed as CodexTokenEvent;
          }
        }
      }
    } catch {
      // not valid JSON, skip line
    }
  }

  if (!lastTokenEvent) return null;

  const usage = lastTokenEvent.payload?.info?.total_token_usage;
  if (!usage) return null;

  return {
    tokens: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cached_input_tokens ?? 0,
      cacheWriteTokens: 0,
    },
    isApproximate: false,
  };
}

/**
 * Tries to extract token counts from plain-text agent output using regex.
 * Marks extracted data as approximate since regex is not precise.
 */
function tryExtractFromText(
  agentOutput: string
): { tokens: TokenCounts; isApproximate: boolean } | null {
  const inputMatch = agentOutput.match(/input[_\s]tokens?:\s*(\d+)/i);
  const outputMatch = agentOutput.match(/output[_\s]tokens?:\s*(\d+)/i);

  if (!inputMatch && !outputMatch) return null;

  return {
    tokens: {
      inputTokens: inputMatch ? parseInt(inputMatch[1] ?? '0', 10) : 0,
      outputTokens: outputMatch ? parseInt(outputMatch[1] ?? '0', 10) : 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    isApproximate: true,
  };
}

/**
 * Extracts the number of agent turns from agent stdout.
 *
 * Tries in order:
 * 1. Claude Code JSON — top-level `num_turns` field (emitted with --output-format json)
 * 2. Codex exec JSONL — counts `turn.completed` events (each event = one turn)
 * 3. Regex fallback — matches patterns like "turns: 12" or "turn 12 of" in plain text
 *
 * Returns null if nothing is found.
 */
export function extractTurnsFromOutput(agentOutput: string): number | null {
  if (!agentOutput) return null;

  // 1. Claude Code JSON: top-level num_turns
  try {
    const parsed = JSON.parse(agentOutput) as ClaudeCodeOutput;
    if (typeof parsed.num_turns === 'number' && parsed.num_turns > 0) {
      return parsed.num_turns;
    }
  } catch {
    // not JSON — fall through
  }

  // 2. Codex exec --json JSONL: count turn.completed events
  if (agentOutput.includes('"turn.completed"')) {
    const lines = agentOutput.split('\n');
    let turnCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.includes('"turn.completed"')) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const obj =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
        if (obj?.['type'] === 'turn.completed') turnCount++;
      } catch {
        // not valid JSON, skip line
      }
    }
    if (turnCount > 0) return turnCount;
  }

  // 3. Regex fallback: "turns: 12", "12 turns", "turn N of <total>" (captures total)
  const patterns = [/\bturns?:\s*(\d+)/i, /\b(\d+)\s+turns?\b/i, /\bturn\s+\d+\s+of\s+(\d+)/i];
  for (const pattern of patterns) {
    const match = agentOutput.match(pattern);
    if (match?.[1]) {
      const n = parseInt(match[1], 10);
      if (n > 0) return n;
    }
  }

  return null;
}

/**
 * Resolves the final token counts to use, following priority order:
 * 1. Explicit inputs (input_tokens / output_tokens)
 * 2. Extracted from agent_output JSON
 * 3. Extracted from agent_output text (approximate)
 * 4. Undefined (no data)
 */
export function resolveTokens({
  agentOutput,
  inputTokensOverride,
  outputTokensOverride,
  cacheReadTokensOverride,
  cacheWriteTokensOverride,
}: {
  /** Raw agent stdout */
  agentOutput: string;
  /** Explicit input token count override */
  inputTokensOverride: number | null;
  /** Explicit output token count override */
  outputTokensOverride: number | null;
  /** Explicit cache read token count override */
  cacheReadTokensOverride: number | null;
  /** Explicit cache write token count override */
  cacheWriteTokensOverride: number | null;
}): TokenCountsWithMeta | undefined {
  const hasAnyOverride =
    inputTokensOverride !== null ||
    outputTokensOverride !== null ||
    cacheReadTokensOverride !== null ||
    cacheWriteTokensOverride !== null;

  if (hasAnyOverride) {
    return {
      inputTokens: inputTokensOverride ?? 0,
      outputTokens: outputTokensOverride ?? 0,
      cacheReadTokens: cacheReadTokensOverride ?? 0,
      cacheWriteTokens: cacheWriteTokensOverride ?? 0,
      isApproximate: false,
    };
  }

  if (agentOutput) {
    const extracted = extractTokensFromOutput(agentOutput);
    if (extracted) {
      return { ...extracted.tokens, isApproximate: extracted.isApproximate };
    }
  }

  return undefined;
}
