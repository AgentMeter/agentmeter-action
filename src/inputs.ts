import * as core from '@actions/core';
import type { ActionInputs } from './types';

/**
 * Parses and validates all GitHub Action inputs.
 * Returns a typed ActionInputs object.
 */
export function parseInputs(): ActionInputs {
  const apiKey = core.getInput('api_key', { required: true });
  const engine = core.getInput('engine') || 'claude';
  const modelRaw = core.getInput('model');
  const agentOutput = core.getInput('agent_output');
  const inputTokensRaw = core.getInput('input_tokens');
  const outputTokensRaw = core.getInput('output_tokens');
  const cacheReadTokensRaw = core.getInput('cache_read_tokens');
  const cacheWriteTokensRaw = core.getInput('cache_write_tokens');
  const turnsRaw = core.getInput('turns');
  const status = core.getInput('status') || 'success';
  const prNumberRaw = core.getInput('pr_number');
  const apiUrl = core.getInput('api_url') || 'https://agentmeter.app';
  const postCommentRaw = core.getInput('post_comment');

  return {
    apiKey,
    engine,
    model: modelRaw || null,
    agentOutput,
    inputTokens: parseIntOrNull(inputTokensRaw),
    outputTokens: parseIntOrNull(outputTokensRaw),
    cacheReadTokens: parseIntOrNull(cacheReadTokensRaw),
    cacheWriteTokens: parseIntOrNull(cacheWriteTokensRaw),
    turns: parseIntOrNull(turnsRaw),
    status,
    prNumber: parseIntOrNull(prNumberRaw),
    apiUrl,
    postComment: postCommentRaw.toLowerCase() !== 'false',
  };
}

/**
 * Parses a string to an integer, returning null for empty/invalid values.
 */
function parseIntOrNull(value: string): number | null {
  if (!value || value.trim() === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
