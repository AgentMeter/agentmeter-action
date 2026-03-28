import { describe, expect, it } from 'vitest';
import {
  extractTokensFromOutput,
  extractTurnsFromOutput,
  resolveTokens,
} from '../src/token-extractor';

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

  it('parses Codex JSONL token_count event', () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'message_start' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 8408,
              output_tokens: 712,
              cached_input_tokens: 1664,
            },
          },
        },
      }),
    ].join('\n');

    const result = extractTokensFromOutput(jsonlOutput);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(8408);
    expect(result!.tokens.outputTokens).toBe(712);
    expect(result!.tokens.cacheReadTokens).toBe(1664);
    expect(result!.tokens.cacheWriteTokens).toBe(0);
    expect(result!.isApproximate).toBe(false);
  });

  it('uses the last Codex token_count event when multiple are present', () => {
    const jsonlOutput = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 500, output_tokens: 200, cached_input_tokens: 300 },
          },
        },
      }),
    ].join('\n');

    const result = extractTokensFromOutput(jsonlOutput);
    expect(result!.tokens.inputTokens).toBe(500);
    expect(result!.tokens.outputTokens).toBe(200);
    expect(result!.tokens.cacheReadTokens).toBe(300);
  });

  it('returns null for Codex JSONL with no token_count events', () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'message_start' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'message_stop' } }),
    ].join('\n');
    expect(extractTokensFromOutput(jsonlOutput)).toBeNull();
  });

  it('parses codex exec --json turn.completed event', () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 },
      }),
    ].join('\n');

    const result = extractTokensFromOutput(jsonlOutput);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(24763);
    expect(result!.tokens.outputTokens).toBe(122);
    expect(result!.tokens.cacheReadTokens).toBe(24448);
    expect(result!.tokens.cacheWriteTokens).toBe(0);
    expect(result!.isApproximate).toBe(false);
  });

  it('sums multiple turn.completed events across turns', () => {
    const jsonlOutput = [
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 50 },
      }),
    ].join('\n');

    const result = extractTokensFromOutput(jsonlOutput);
    expect(result!.tokens.inputTokens).toBe(1500);
    expect(result!.tokens.outputTokens).toBe(150);
    expect(result!.tokens.cacheReadTokens).toBe(1000);
  });

  it('returns null for --json output with no turn.completed events', () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }),
    ].join('\n');
    expect(extractTokensFromOutput(jsonlOutput)).toBeNull();
  });

  it('handles missing usage fields in turn.completed gracefully', () => {
    const jsonlOutput = JSON.stringify({ type: 'turn.completed', usage: {} });
    const result = extractTokensFromOutput(jsonlOutput);
    expect(result).not.toBeNull();
    expect(result!.tokens.inputTokens).toBe(0);
    expect(result!.tokens.outputTokens).toBe(0);
    expect(result!.tokens.cacheReadTokens).toBe(0);
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

describe('extractTurnsFromOutput', () => {
  it('returns null for empty output', () => {
    expect(extractTurnsFromOutput('')).toBeNull();
  });

  it('extracts num_turns from Claude Code JSON output', () => {
    const output = JSON.stringify({
      num_turns: 7,
      usage: { input_tokens: 1000, output_tokens: 200 },
    });
    expect(extractTurnsFromOutput(output)).toBe(7);
  });

  it('returns null for Claude Code JSON without num_turns', () => {
    const output = JSON.stringify({
      usage: { input_tokens: 1000, output_tokens: 200 },
    });
    expect(extractTurnsFromOutput(output)).toBeNull();
  });

  it('returns null for Claude Code JSON with num_turns of 0', () => {
    const output = JSON.stringify({ num_turns: 0 });
    expect(extractTurnsFromOutput(output)).toBeNull();
  });

  it('counts turn.completed events from Codex exec JSONL', () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 80 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 150, output_tokens: 60 } }),
    ].join('\n');
    expect(extractTurnsFromOutput(jsonlOutput)).toBe(3);
  });

  it('returns null for Codex JSONL with no turn.completed events', () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'item.started' }),
    ].join('\n');
    expect(extractTurnsFromOutput(jsonlOutput)).toBeNull();
  });

  it('extracts turns from "turns: 12" regex pattern', () => {
    expect(extractTurnsFromOutput('Agent completed. turns: 12')).toBe(12);
  });

  it('extracts turns from "12 turns" regex pattern', () => {
    expect(extractTurnsFromOutput('Finished in 12 turns.')).toBe(12);
  });

  it('extracts total turns from "turn N of <total>" regex pattern', () => {
    expect(extractTurnsFromOutput('Processing turn 5 of 10...')).toBe(10);
  });

  it('returns null for plain text with no turn patterns', () => {
    expect(extractTurnsFromOutput('Agent completed the task successfully.')).toBeNull();
  });

  it('prefers Claude JSON num_turns over Codex JSONL when both present', () => {
    // JSON.parse succeeds on a valid JSON string — Claude path runs first
    const output = JSON.stringify({ num_turns: 4 });
    expect(extractTurnsFromOutput(output)).toBe(4);
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
