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
 * Validates that a value looks like a valid model pricing entry from the API.
 * cacheReadPerMillionTokens may be null for models that don't support prompt caching.
 */
function isValidModelEntry(v: unknown): v is {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheWritePerMillionTokens: number;
  cacheReadPerMillionTokens: number | null;
} {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['inputPerMillionTokens'] === 'number' &&
    typeof o['outputPerMillionTokens'] === 'number' &&
    typeof o['cacheWritePerMillionTokens'] === 'number' &&
    (typeof o['cacheReadPerMillionTokens'] === 'number' || o['cacheReadPerMillionTokens'] === null)
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
 * Returns an empty object on any error — cost will show as — in comments.
 * Never throws.
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
        cacheReadPer1M: entry.cacheReadPerMillionTokens ?? 0,
      };
    }
    core.info(
      `AgentMeter: fetched pricing for ${Object.keys(result).length} models: ${Object.keys(result).join(', ')}`
    );
    return result;
  } catch (error) {
    core.info(`AgentMeter: could not fetch pricing from API (${error}) — cost will show as —.`);
    return {};
  }
}

/**
 * Looks up pricing for a model name using the API-fetched table.
 * Returns null if not found — callers should show — for cost in that case.
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
  const exact = apiPricing[lower];
  return exact ?? null;
}
