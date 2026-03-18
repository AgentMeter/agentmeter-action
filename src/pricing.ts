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
];

/**
 * Expected shape of the /api/models/pricing response.
 */
interface PricingApiResponse {
  models: Record<
    string,
    {
      inputPerMillionTokens: number;
      outputPerMillionTokens: number;
      cacheWritePerMillionTokens: number;
      cacheReadPerMillionTokens: number;
    }
  >;
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
    const data = (await res.json()) as PricingApiResponse;
    const result: Record<string, ModelPricing> = {};
    for (const [model, p] of Object.entries(data.models)) {
      result[model] = {
        inputPer1M: p.inputPerMillionTokens,
        outputPer1M: p.outputPerMillionTokens,
        cacheWritePer1M: p.cacheWritePerMillionTokens,
        cacheReadPer1M: p.cacheReadPerMillionTokens,
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
  if (apiPricing[lower]) return apiPricing[lower] ?? null;

  // Prefix fallback
  return FALLBACK_PRICING.find((p) => lower.startsWith(p.prefix)) ?? null;
}
