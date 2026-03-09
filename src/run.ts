import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseInputs } from './inputs';
import { extractContext } from './context';
import { resolveTokens } from './token-extractor';
import { submitRun } from './ingest';
import { upsertComment } from './comment';

/**
 * Core run logic — orchestrates all steps of the AgentMeter Action.
 */
export async function run(): Promise<void> {
  const startedAt = new Date().toISOString();

  const inputs = parseInputs();
  const ctx = extractContext();

  const tokens = resolveTokens({
    agentOutput: inputs.agentOutput,
    inputTokensOverride: inputs.inputTokens,
    outputTokensOverride: inputs.outputTokens,
    cacheReadTokensOverride: inputs.cacheReadTokens,
    cacheWriteTokensOverride: inputs.cacheWriteTokens,
  });

  const completedAt = new Date().toISOString();
  const durationSeconds = Math.round(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
  );

  const result = await submitRun({
    apiKey: inputs.apiKey,
    apiUrl: inputs.apiUrl,
    payload: {
      githubRunId: ctx.runId,
      repoFullName: ctx.repoFullName,
      workflowName: ctx.workflowName,
      triggerType: ctx.triggerType,
      triggerRef: ctx.triggerRef,
      triggerNumber: ctx.triggerNumber,
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

    if (inputs.postComment && ctx.triggerNumber !== null) {
      const githubToken = process.env['GITHUB_TOKEN'] ?? '';
      if (!githubToken) {
        core.warning(
          'AgentMeter: GITHUB_TOKEN not set, skipping comment posting.',
        );
        return;
      }
      const octokit = github.getOctokit(githubToken);
      await upsertComment({
        octokit,
        owner: ctx.owner,
        repo: ctx.repo,
        issueOrPrNumber: ctx.triggerNumber,
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
