import * as core from '@actions/core';
import * as github from '@actions/github';
import { upsertComment } from './comment';
import { extractContext } from './context';
import { submitRun } from './ingest';
import { parseInputs } from './inputs';
import { resolveTokens } from './token-extractor';

/**
 * Builds a human-readable trigger ref string from a number and event name.
 */
function buildTriggerRef(number: number, eventName: string): string {
  if (eventName === 'pull_request' || eventName === 'pull_request_review_comment') {
    return `PR #${number}`;
  }
  return `#${number}`;
}

/**
 * Core run logic — orchestrates all steps of the AgentMeter Action.
 */
export async function run(): Promise<void> {
  const startedAt = new Date().toISOString();

  const inputs = parseInputs();
  const ctx = extractContext();

  // When running via workflow_run, GitHub context won't carry the original
  // issue/PR number. Use explicit trigger_number + trigger_event inputs instead.
  const triggerNumber = inputs.triggerNumber ?? ctx.triggerNumber;
  const triggerEvent = inputs.triggerEvent || ctx.triggerType;
  const triggerRef =
    inputs.triggerNumber !== null
      ? buildTriggerRef(inputs.triggerNumber, inputs.triggerEvent)
      : ctx.triggerRef;

  const tokens = resolveTokens({
    agentOutput: inputs.agentOutput,
    inputTokensOverride: inputs.inputTokens,
    outputTokensOverride: inputs.outputTokens,
    cacheReadTokensOverride: inputs.cacheReadTokens,
    cacheWriteTokensOverride: inputs.cacheWriteTokens,
  });

  const completedAt = new Date().toISOString();
  const durationSeconds = Math.round(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
  );

  const result = await submitRun({
    apiKey: inputs.apiKey,
    apiUrl: inputs.apiUrl,
    payload: {
      githubRunId: ctx.runId,
      repoFullName: ctx.repoFullName,
      workflowName: ctx.workflowName,
      triggerType: triggerEvent,
      triggerRef,
      triggerNumber,
      engine: inputs.engine,
      model: inputs.model,
      status: inputs.status,
      prNumber: inputs.prNumber,
      durationSeconds,
      turns: inputs.turns,
      startedAt,
      completedAt,
      tokens,
    },
  });

  if (result) {
    core.setOutput('run_id', result.id);
    core.setOutput('total_cost_usd', (result.totalCostCents / 100).toFixed(2));
    core.setOutput('dashboard_url', result.dashboardUrl);

    if (inputs.postComment && triggerNumber !== null) {
      const githubToken = process.env['GITHUB_TOKEN'] ?? '';
      if (!githubToken) {
        core.warning('AgentMeter: GITHUB_TOKEN not set, skipping comment posting.');
        return;
      }
      const octokit = github.getOctokit(githubToken);
      await upsertComment({
        octokit,
        owner: ctx.owner,
        repo: ctx.repo,
        issueOrPrNumber: triggerNumber,
        runData: {
          workflowName: ctx.workflowName,
          status: inputs.status,
          totalCostCents: result.totalCostCents,
          tokens,
          model: inputs.model,
          turns: inputs.turns,
          dashboardUrl: result.dashboardUrl,
        },
      });
    }
  }
}
