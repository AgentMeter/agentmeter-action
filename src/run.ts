import * as core from '@actions/core';
import * as github from '@actions/github';
import { upsertComment } from './comment';
import { extractContext } from './context';
import { submitRun } from './ingest';
import { parseInputs } from './inputs';
import { resolveTokens } from './token-extractor';
import { resolveWorkflowRun } from './workflow-run';

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
  const selfStartedAt = new Date().toISOString();

  let inputs = parseInputs();
  const ctx = extractContext();

  const githubToken = process.env['GITHUB_TOKEN'] ?? '';

  // When workflow_run_id is provided, resolve all workflow-run data automatically:
  // timestamps, trigger number, and agent-tokens artifact. This removes the need
  // for manual pre-steps in the caller's companion workflow.
  let workflowRunTokens: ReturnType<typeof resolveTokens>;
  let resolvedTriggerNumber = inputs.triggerNumber ?? ctx.triggerNumber;
  let resolvedTriggerEvent = inputs.triggerEvent || ctx.triggerType;
  let resolvedStartedAt = inputs.startedAt || selfStartedAt;
  let resolvedCompletedAt = inputs.completedAt || new Date().toISOString();
  let resolvedWorkflowName = ctx.workflowName;

  if (inputs.workflowRunId !== null) {
    if (!githubToken) {
      core.warning(
        'AgentMeter: workflow_run_id provided but GITHUB_TOKEN not set — skipping auto-resolution.'
      );
    } else {
      const runData = await resolveWorkflowRun({
        githubToken,
        owner: ctx.owner,
        rawConclusion: inputs.status,
        repo: ctx.repo,
        workflowRunId: inputs.workflowRunId,
      });

      if (!runData.shouldProceed) {
        core.info('AgentMeter: skipping ingest for this workflow_run firing.');
        return;
      }

      // Use normalized status from the run data
      inputs = { ...inputs, status: runData.normalizedStatus };

      // Only override with resolved values when explicit inputs aren't set
      if (!inputs.startedAt) resolvedStartedAt = runData.startedAt;
      if (!inputs.completedAt) resolvedCompletedAt = runData.completedAt;
      if (inputs.triggerNumber === null) resolvedTriggerNumber = runData.triggerNumber;
      if (!inputs.triggerEvent) resolvedTriggerEvent = runData.triggerEvent;
      if (runData.workflowName) resolvedWorkflowName = runData.workflowName;
      workflowRunTokens = runData.tokens;
    }
  }

  // Token resolution priority: explicit inputs > workflow_run artifact > agent_output extraction
  const tokens =
    resolveTokens({
      agentOutput: inputs.agentOutput,
      inputTokensOverride: inputs.inputTokens,
      outputTokensOverride: inputs.outputTokens,
      cacheReadTokensOverride: inputs.cacheReadTokens,
      cacheWriteTokensOverride: inputs.cacheWriteTokens,
    }) ?? workflowRunTokens;

  const triggerRef =
    resolvedTriggerNumber !== null
      ? buildTriggerRef(resolvedTriggerNumber, resolvedTriggerEvent)
      : ctx.triggerRef;

  const durationSeconds = Math.round(
    (new Date(resolvedCompletedAt).getTime() - new Date(resolvedStartedAt).getTime()) / 1000
  );

  const result = await submitRun({
    apiKey: inputs.apiKey,
    apiUrl: inputs.apiUrl,
    payload: {
      githubRunId: ctx.runId,
      repoFullName: ctx.repoFullName,
      workflowName: resolvedWorkflowName,
      triggerType: resolvedTriggerEvent,
      triggerRef,
      triggerNumber: resolvedTriggerNumber,
      engine: inputs.engine,
      model: inputs.model,
      status: inputs.status,
      prNumber: inputs.prNumber,
      durationSeconds,
      turns: inputs.turns,
      startedAt: resolvedStartedAt,
      completedAt: resolvedCompletedAt,
      tokens,
    },
  });

  if (result) {
    core.setOutput('run_id', result.id);
    core.setOutput('total_cost_usd', (result.totalCostCents / 100).toFixed(2));
    core.setOutput('dashboard_url', result.dashboardUrl);

    if (inputs.postComment && resolvedTriggerNumber !== null) {
      if (!githubToken) {
        core.warning('AgentMeter: GITHUB_TOKEN not set, skipping comment posting.');
        return;
      }
      const octokit = github.getOctokit(githubToken);
      await upsertComment({
        octokit,
        owner: ctx.owner,
        repo: ctx.repo,
        issueOrPrNumber: resolvedTriggerNumber,
        runData: {
          workflowName: resolvedWorkflowName,
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
