import { describe, expect, it } from 'vitest';
import { extractTokensFromOutput, resolveTokens } from '../src/token-extractor';

describe('extractTokensFromOutput', () => {
  it('returns null for empty output', () => {
    expect(extractTokensFromOutput('')).toBeNull();
  });

  it('parses valid JSON with top-level usage', () => {
    const output = JSON.stringify({
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    });
    const result = extractTokensFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(1000);
    expect(result!.tokens.outputTokens).toBe(500);
    expect(result!.tokens.cacheReadTokens).toBe(200);
    expect(result!.tokens.cacheWriteTokens).toBe(100);
    expect(result!.isApproximate).toBe(false);
  });

  it('parses JSON with nested result.usage', () => {
    const output = JSON.stringify({
      result: {
        usage: {
          input_tokens: 2000,
          output_tokens: 800,
        },
      },
    });
    const result = extractTokensFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(2000);
    expect(result!.tokens.outputTokens).toBe(800);
    expect(result!.isApproximate).toBe(false);
  });

  it('returns null for JSON without usage fields', () => {
    const output = JSON.stringify({ status: 'success', message: 'done' });
    expect(extractTokensFromOutput(output)).toBeNull();
  });

  it('extracts approximate data from plain text output', () => {
    const output = 'Completed. Input tokens: 5000, Output tokens: 2000';
    const result = extractTokensFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(5000);
    expect(result!.tokens.outputTokens).toBe(2000);
    expect(result!.isApproximate).toBe(true);
  });

  it('returns null for plain text with no token mentions', () => {
    const output = 'Agent completed the task successfully.';
    expect(extractTokensFromOutput(output)).toBeNull();
  });

  it('handles malformed JSON gracefully, falling back to regex', () => {
    const output = '{bad json input_tokens: 3000 output_tokens: 1500';
    const result = extractTokensFromOutput(output);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(3000);
    expect(result!.isApproximate).toBe(true);
  });

  it('defaults missing cache fields to zero in JSON', () => {
    const output = JSON.stringify({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = extractTokensFromOutput(output);
    expect(result!.tokens.cacheReadTokens).toBe(0);
    expect(result!.tokens.cacheWriteTokens).toBe(0);
  });
});

describe('resolveTokens', () => {
  it('uses explicit overrides when inputTokensOverride is provided', () => {
    const result = resolveTokens({
      agentOutput: '',
      inputTokensOverride: 500,
      outputTokensOverride: 300,
      cacheReadTokensOverride: 100,
      cacheWriteTokensOverride: 50,
    });
    expect(result).toBeDefined();
    expect(result!.inputTokens).toBe(500);
    expect(result!.outputTokens).toBe(300);
    expect(result!.isApproximate).toBe(false);
  });

  it('falls back to zero for missing explicit token fields', () => {
    const result = resolveTokens({
      agentOutput: '',
      inputTokensOverride: 100,
      outputTokensOverride: null,
      cacheReadTokensOverride: null,
      cacheWriteTokensOverride: null,
    });
    expect(result!.outputTokens).toBe(0);
    expect(result!.cacheReadTokens).toBe(0);
    expect(result!.cacheWriteTokens).toBe(0);
  });

  it('extracts from agentOutput when no explicit overrides', () => {
    const agentOutput = JSON.stringify({
      usage: { input_tokens: 999, output_tokens: 111 },
    });
    const result = resolveTokens({
      agentOutput,
      inputTokensOverride: null,
      outputTokensOverride: null,
      cacheReadTokensOverride: null,
      cacheWriteTokensOverride: null,
    });
    expect(result!.inputTokens).toBe(999);
    expect(result!.outputTokens).toBe(111);
  });

  it('returns undefined when no data available', () => {
    const result = resolveTokens({
      agentOutput: '',
      inputTokensOverride: null,
      outputTokensOverride: null,
      cacheReadTokensOverride: null,
      cacheWriteTokensOverride: null,
    });
    expect(result).toBeUndefined();
  });
});
