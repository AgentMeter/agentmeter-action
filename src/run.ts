import * as core from '@actions/core';
import * as github from '@actions/github';
import { upsertComment } from './comment';
import { extractContext } from './context';
import { submitRun } from './ingest';
import { parseInputs } from './inputs';
import { fetchPricing } from './pricing';
import { resolveTokens } from './token-extractor';
import { normalizeConclusion, resolveWorkflowRun } from './workflow-run';

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
  let resolvedTriggerRef: string | null = null;
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
      resolvedTriggerRef = runData.triggerRef;
      if (runData.workflowName) resolvedWorkflowName = runData.workflowName;
      workflowRunTokens = runData.tokens;
    }
  }

  // Token resolution priority: explicit inputs > workflow_run artifact > agent_output extraction.
  // Merge per-field so a partial explicit override (e.g. only input_tokens) still falls back to
  // the artifact or extracted value for the fields that were not explicitly provided.
  const extractedTokens = resolveTokens({
    agentOutput: inputs.agentOutput,
    cacheReadTokensOverride: null,
    cacheWriteTokensOverride: null,
    inputTokensOverride: null,
    outputTokensOverride: null,
  });
  const baseTokens = workflowRunTokens ?? extractedTokens;
  const hasAnyExplicit =
    inputs.inputTokens !== null ||
    inputs.outputTokens !== null ||
    inputs.cacheReadTokens !== null ||
    inputs.cacheWriteTokens !== null;
  const tokens =
    hasAnyExplicit || baseTokens !== undefined
      ? {
          cacheReadTokens: inputs.cacheReadTokens ?? baseTokens?.cacheReadTokens ?? 0,
          cacheWriteTokens: inputs.cacheWriteTokens ?? baseTokens?.cacheWriteTokens ?? 0,
          inputTokens: inputs.inputTokens ?? baseTokens?.inputTokens ?? 0,
          isApproximate: baseTokens?.isApproximate ?? false,
          outputTokens: inputs.outputTokens ?? baseTokens?.outputTokens ?? 0,
        }
      : undefined;

  // Prefer ctx.triggerRef (inline runs — context.ts already resolved PR vs issue correctly).
  // Fall back to resolvedTriggerRef from resolveTrigger (companion workflow_run mode — it knows
  // whether a PR was found regardless of the triggering event name, e.g. issue_comment on a PR).
  // Last resort: buildTriggerRef from the event name and number.
  const triggerRef =
    ctx.triggerRef ??
    resolvedTriggerRef ??
    (resolvedTriggerNumber !== null
      ? buildTriggerRef({ eventName: resolvedTriggerEvent, number: resolvedTriggerNumber })
      : null);

  const triggerType = resolvedTriggerEvent || ctx.triggerType || 'other';

  const startMs = new Date(resolvedStartedAt).getTime();
  const endMs = new Date(resolvedCompletedAt).getTime();
  const durationSeconds =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.round((endMs - startMs) / 1000) : 0;

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
      status: normalizeConclusion(inputs.status),
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
          status: normalizeConclusion(inputs.status),
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
