import * as core from '@actions/core';

/**
 * Per-model token pricing in USD per 1M tokens.
 */
export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
  /** USD per 1M cache write tokens */
  cacheWritePer1M: number;
  /** USD per 1M cache read tokens */
  cacheReadPer1M: number;
}

/**
 * Fallback pricing table used when the API is unreachable.
 * Keyed by model name prefix for broad coverage.
 */
const FALLBACK_PRICING: Array<{ prefix: string } & ModelPricing> = [
  {
    prefix: 'claude-opus-4',
    inputPer1M: 15,
    outputPer1M: 75,
    cacheWritePer1M: 18.75,
    cacheReadPer1M: 1.5,
  },
  {
    prefix: 'claude-sonnet-4',
    inputPer1M: 3,
    outputPer1M: 15,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.3,
  },
  {
    prefix: 'claude-haiku-4',
    inputPer1M: 0.8,
    outputPer1M: 4,
    cacheWritePer1M: 1,
    cacheReadPer1M: 0.08,
  },
  {
    prefix: 'claude-opus-3',
    inputPer1M: 15,
    outputPer1M: 75,
    cacheWritePer1M: 18.75,
    cacheReadPer1M: 1.5,
  },
  {
    prefix: 'claude-sonnet-3',
    inputPer1M: 3,
    outputPer1M: 15,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.3,
  },
  {
    prefix: 'claude-haiku-3',
    inputPer1M: 0.25,
    outputPer1M: 1.25,
    cacheWritePer1M: 0.3,
    cacheReadPer1M: 0.03,
  },
  // OpenAI models — no cache write charge; cacheReadPer1M is 50% of input by default
  {
    prefix: 'o3',
    inputPer1M: 10,
    outputPer1M: 40,
    cacheWritePer1M: 0,
    cacheReadPer1M: 2.5,
  },
  {
    prefix: 'o4-mini',
    inputPer1M: 1.1,
    outputPer1M: 4.4,
    cacheWritePer1M: 0,
    cacheReadPer1M: 0.275,
  },
  {
    prefix: 'gpt-4.1-mini',
    inputPer1M: 0.4,
    outputPer1M: 1.6,
    cacheWritePer1M: 0,
    cacheReadPer1M: 0.1,
  },
  {
    prefix: 'gpt-4.1',
    inputPer1M: 2,
    outputPer1M: 8,
    cacheWritePer1M: 0,
    cacheReadPer1M: 0.5,
  },
  {
    prefix: 'gpt-4o',
    inputPer1M: 2.5,
    outputPer1M: 10,
    cacheWritePer1M: 0,
    cacheReadPer1M: 1.25,
  },
];

/**
 * Validates that a value looks like a valid model pricing entry from the API.
 */
function isValidModelEntry(v: unknown): v is {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheWritePerMillionTokens: number;
  cacheReadPerMillionTokens: number;
} {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['inputPerMillionTokens'] === 'number' &&
    typeof o['outputPerMillionTokens'] === 'number' &&
    typeof o['cacheWritePerMillionTokens'] === 'number' &&
    typeof o['cacheReadPerMillionTokens'] === 'number'
  );
}

/**
 * Validates that the API response has the expected shape.
 */
function isValidPricingResponse(data: unknown): data is { models: Record<string, unknown> } {
  if (typeof data !== 'object' || data === null) return false;
  const o = data as Record<string, unknown>;
  return typeof o['models'] === 'object' && o['models'] !== null;
}

/**
 * Fetches the pricing table from the AgentMeter API.
 * Falls back to the built-in table on any error — never throws.
 */
export async function fetchPricing({
  apiUrl,
}: {
  /** AgentMeter API base URL */
  apiUrl: string;
}): Promise<Record<string, ModelPricing>> {
  try {
    const res = await fetch(`${apiUrl}/api/models/pricing`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (!isValidPricingResponse(data)) throw new Error('Unexpected response shape');
    const result: Record<string, ModelPricing> = {};
    for (const [model, entry] of Object.entries(data.models)) {
      if (!isValidModelEntry(entry)) continue;
      result[model.toLowerCase()] = {
        inputPer1M: entry.inputPerMillionTokens,
        outputPer1M: entry.outputPerMillionTokens,
        cacheWritePer1M: entry.cacheWritePerMillionTokens,
        cacheReadPer1M: entry.cacheReadPerMillionTokens,
      };
    }
    return result;
  } catch (error) {
    core.info(`AgentMeter: could not fetch pricing from API (${error}) — using built-in fallback.`);
    return {};
  }
}

/**
 * Looks up pricing for a model name.
 * Checks the API-fetched exact-match table first, then falls back to prefix matching.
 * Returns null if no match is found.
 */
export function getPricing({
  apiPricing,
  model,
}: {
  /** Pricing fetched from the API (may be empty on fetch failure) */
  apiPricing: Record<string, ModelPricing>;
  /** Model identifier string */
  model: string | null;
}): ModelPricing | null {
  if (!model) return null;
  const lower = model.toLowerCase();

  // Exact match from API
  const exact = apiPricing[lower];
  if (exact != null) return exact;

  // Prefix fallback
  return FALLBACK_PRICING.find((p) => lower.startsWith(p.prefix)) ?? null;
}
