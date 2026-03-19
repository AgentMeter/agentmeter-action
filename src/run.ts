import * as core from '@actions/core';
import * as github from '@actions/github';
import { upsertComment } from './comment';
import { extractContext } from './context';
import { submitRun } from './ingest';
import { parseInputs } from './inputs';
import { fetchPricing } from './pricing';
import { resolveTokens } from './token-extractor';
import { resolveWorkflowRun } from './workflow-run';

/**
 * Builds a human-readable trigger ref string from a number and event name.
 * Covers both raw GitHub event names and the mapped triggerType values from context.ts.
 */
function buildTriggerRef({
  eventName,
  number,
}: {
  /** Raw GitHub event name or mapped triggerType from context.ts */
  eventName: string;
  /** PR or issue number */
  number: number;
}): string {
  const prEvents = new Set([
    'pull_request',
    'pull_request_review_comment',
    'pr_comment',
    'pr_opened',
    'pr_synchronize',
    'pr_reopened',
  ]);
  return prEvents.has(eventName) ? `PR #${number}` : `#${number}`;
}

/**
 * Core run logic — orchestrates all steps of the AgentMeter Action.
 */
export async function run(): Promise<void> {
  const selfStartedAt = new Date().toISOString();

  let inputs = parseInputs();
  const ctx = extractContext();

  const githubToken = core.getInput('github_token') || process.env['GITHUB_TOKEN'] || '';

  const apiPricing = await fetchPricing({ apiUrl: inputs.apiUrl });

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

  // Token resolution priority: explicit inputs > workflow_run artifact > agent_output extraction.
  // Split into two resolveTokens calls so the artifact wins over stdout extraction.
  const tokens =
    resolveTokens({
      agentOutput: '',
      inputTokensOverride: inputs.inputTokens,
      outputTokensOverride: inputs.outputTokens,
      cacheReadTokensOverride: inputs.cacheReadTokens,
      cacheWriteTokensOverride: inputs.cacheWriteTokens,
    }) ??
    workflowRunTokens ??
    resolveTokens({
      agentOutput: inputs.agentOutput,
      inputTokensOverride: null,
      outputTokensOverride: null,
      cacheReadTokensOverride: null,
      cacheWriteTokensOverride: null,
    });

  // Prefer ctx.triggerRef (correctly set for inline runs including issue vs PR distinction).
  // Fall back to buildTriggerRef only for companion workflow_run mode where ctx.triggerRef is null.
  const triggerRef =
    ctx.triggerRef ??
    (resolvedTriggerNumber !== null
      ? buildTriggerRef({ eventName: resolvedTriggerEvent, number: resolvedTriggerNumber })
      : null);

  const triggerType = resolvedTriggerEvent || ctx.triggerType || 'other';

  const durationSeconds = Math.round(
    (new Date(resolvedCompletedAt).getTime() - new Date(resolvedStartedAt).getTime()) / 1000
  );

  const result = await submitRun({
    apiKey: inputs.apiKey,
    apiUrl: inputs.apiUrl,
    payload: {
      githubRunId: inputs.workflowRunId ?? ctx.runId,
      repoFullName: ctx.repoFullName,
      workflowName: resolvedWorkflowName,
      triggerType,
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
        apiPricing,
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
          durationSeconds,
          dashboardUrl: result.dashboardUrl,
        },
      });
    }
  }
}
