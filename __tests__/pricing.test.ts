import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPricing, getPricing } from '../src/pricing';

vi.mock('@actions/core', () => ({ info: vi.fn(), warning: vi.fn() }));

const validApiResponse = {
  models: {
    'claude-sonnet-4-5': {
      inputPerMillionTokens: 3,
      outputPerMillionTokens: 15,
      cacheWritePerMillionTokens: 3.75,
      cacheReadPerMillionTokens: 0.3,
    },
    'claude-haiku-4-5': {
      inputPerMillionTokens: 0.8,
      outputPerMillionTokens: 4,
      cacheWritePerMillionTokens: 1,
      cacheReadPerMillionTokens: 0.08,
    },
  },
  sources: [{ provider: 'anthropic', url: 'https://www.anthropic.com/pricing' }],
};

describe('fetchPricing', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => validApiResponse,
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed pricing from the API', async () => {
    const result = await fetchPricing({ apiUrl: 'https://example.com' });
    expect(result['claude-sonnet-4-5']).toEqual({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheWritePer1M: 3.75,
      cacheReadPer1M: 0.3,
    });
    expect(result['claude-haiku-4-5']).toEqual({
      inputPer1M: 0.8,
      outputPer1M: 4,
      cacheWritePer1M: 1,
      cacheReadPer1M: 0.08,
    });
  });

  it('returns empty object on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await fetchPricing({ apiUrl: 'https://example.com' });
    expect(result).toEqual({});
  });

  it('returns empty object on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await fetchPricing({ apiUrl: 'https://example.com' });
    expect(result).toEqual({});
  });

  it('returns empty object when response is not valid JSON shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: true }),
      })
    );
    const result = await fetchPricing({ apiUrl: 'https://example.com' });
    expect(result).toEqual({});
  });

  it('lowercases model keys from the API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: {
            'Claude-Sonnet-4-5': validApiResponse.models['claude-sonnet-4-5'],
          },
        }),
      })
    );
    const result = await fetchPricing({ apiUrl: 'https://example.com' });
    expect(result['claude-sonnet-4-5']).toBeDefined();
    expect(result['Claude-Sonnet-4-5']).toBeUndefined();
  });

  it('treats null cacheReadPerMillionTokens as 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: {
            'gpt-4o': {
              inputPerMillionTokens: 2.5,
              outputPerMillionTokens: 10,
              cacheWritePerMillionTokens: 0,
              cacheReadPerMillionTokens: null,
            },
          },
        }),
      })
    );
    const result = await fetchPricing({ apiUrl: 'https://example.com' });
    expect(result['gpt-4o']?.cacheReadPer1M).toBe(0);
  });

  it('skips malformed model entries without crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: {
            'claude-sonnet-4-5': validApiResponse.models['claude-sonnet-4-5'],
            'bad-model': { inputPerMillionTokens: 'not-a-number' },
          },
        }),
      })
    );
    const result = await fetchPricing({ apiUrl: 'https://example.com' });
    expect(result['claude-sonnet-4-5']).toBeDefined();
    expect(result['bad-model']).toBeUndefined();
  });
});

describe('getPricing', () => {
  const apiPricing = {
    'claude-sonnet-4-5': {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheWritePer1M: 3.75,
      cacheReadPer1M: 0.3,
    },
  };

  it('returns exact API match when available', () => {
    const result = getPricing({ apiPricing, model: 'claude-sonnet-4-5' });
    expect(result?.inputPer1M).toBe(3);
  });

  it('is case-insensitive for API lookup', () => {
    const result = getPricing({ apiPricing, model: 'Claude-Sonnet-4-5' });
    expect(result?.inputPer1M).toBe(3);
  });

  it('falls back to prefix table when model not in API response', () => {
    const result = getPricing({ apiPricing: {}, model: 'claude-sonnet-4-99' });
    expect(result?.inputPer1M).toBe(3);
    expect(result?.outputPer1M).toBe(15);
  });

  it('returns null for unknown model', () => {
    const result = getPricing({ apiPricing: {}, model: 'unknown-model-xyz' });
    expect(result).toBeNull();
  });

  it('returns null when model is null', () => {
    const result = getPricing({ apiPricing, model: null });
    expect(result).toBeNull();
  });
});
