import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentTokensArtifact, TokenCountsWithMeta } from './types';

/**
 * Data resolved from the triggering agent workflow run.
 */
export interface WorkflowRunData {
  /** ISO 8601 timestamp when the triggering run started */
  startedAt: string;
  /** ISO 8601 timestamp when the triggering run completed */
  completedAt: string;
  /** PR number associated with the triggering run, if any */
  triggerNumber: number | null;
  /** Event name of the triggering run (pull_request, issues, etc.) */
  triggerEvent: string;
  /** Token counts extracted from the agent-tokens artifact, if available */
  tokens: TokenCountsWithMeta | undefined;
}

/**
 * Fetches metadata and token data from the triggering agent workflow run.
 * Uses the GitHub API to read run timestamps, associated PRs, and the
 * agent-tokens artifact — so callers don't need manual pre-steps for any of
 * these. Never throws; logs warnings and returns partial data on failure.
 */
export async function resolveWorkflowRun({
  githubToken,
  owner,
  repo,
  workflowRunId,
}: {
  /** GitHub token for API access */
  githubToken: string;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Run ID of the triggering agent workflow */
  workflowRunId: number;
}): Promise<WorkflowRunData> {
  const octokit = github.getOctokit(githubToken);

  const run = await fetchRun({ octokit, owner, repo, workflowRunId });

  const startedAt = run?.run_started_at ?? new Date().toISOString();
  const completedAt = run?.updated_at ?? new Date().toISOString();

  const { triggerNumber, triggerEvent } = resolveTrigger({
    pullRequests: run?.pull_requests ?? [],
    headBranch: run?.head_branch ?? '',
  });

  const tokens = await fetchAgentTokens({ octokit, owner, repo, workflowRunId });

  return { startedAt, completedAt, triggerNumber, triggerEvent, tokens };
}

/**
 * Fetches the workflow run object from the GitHub API.
 */
async function fetchRun({
  octokit,
  owner,
  repo,
  workflowRunId,
}: {
  /** Authenticated Octokit instance */
  octokit: ReturnType<typeof github.getOctokit>;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Workflow run ID */
  workflowRunId: number;
}): Promise<{
  run_started_at?: string | null;
  updated_at?: string | null;
  head_branch?: string | null;
  pull_requests?: Array<{ number: number }>;
} | null> {
  try {
    const { data } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: workflowRunId,
    });
    return {
      run_started_at: data.run_started_at,
      updated_at: data.updated_at,
      head_branch: data.head_branch,
      pull_requests: (data.pull_requests ?? []).map((pr) => ({ number: pr.number })),
    };
  } catch (error) {
    core.warning(`AgentMeter: failed to fetch workflow run ${workflowRunId}: ${error}`);
    return null;
  }
}

/**
 * Resolves the trigger PR/issue number and event name from the workflow run.
 * Checks the pull_requests array first, then falls back to branch name convention.
 */
function resolveTrigger({
  headBranch,
  pullRequests,
}: {
  /** Head branch name of the triggering run */
  headBranch: string;
  /** Pull requests associated with the triggering run */
  pullRequests: Array<{ number: number }>;
}): { triggerNumber: number | null; triggerEvent: string } {
  if (pullRequests.length > 0 && pullRequests[0]) {
    return {
      triggerNumber: pullRequests[0].number,
      triggerEvent: 'pull_request',
    };
  }

  // gh-aw issue branches are named agent/issue-N
  const issueMatch = headBranch.match(/issue[/-](\d+)/i);
  if (issueMatch?.[1]) {
    return {
      triggerNumber: parseInt(issueMatch[1], 10),
      triggerEvent: 'issues',
    };
  }

  return { triggerNumber: null, triggerEvent: '' };
}

/**
 * Downloads and parses the agent-tokens artifact from the triggering workflow run.
 * Returns undefined if the artifact doesn't exist or can't be parsed.
 */
async function fetchAgentTokens({
  octokit,
  owner,
  repo,
  workflowRunId,
}: {
  /** Authenticated Octokit instance */
  octokit: ReturnType<typeof github.getOctokit>;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Workflow run ID */
  workflowRunId: number;
}): Promise<TokenCountsWithMeta | undefined> {
  try {
    // List artifacts for the run and find agent-tokens
    const { data: artifactList } = await octokit.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: workflowRunId,
    });

    const artifact = artifactList.artifacts.find((a) => a.name === 'agent-tokens');
    if (!artifact) {
      core.info('AgentMeter: no agent-tokens artifact found — token data will be omitted.');
      return undefined;
    }

    // Download the artifact as a zip (GitHub returns a redirect URL)
    const { data: downloadData } = await octokit.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: 'zip',
    });

    // downloadData is the zip bytes as an ArrayBuffer
    const parsed = await parseAgentTokensZip(downloadData as ArrayBuffer);
    if (!parsed) return undefined;

    return {
      inputTokens: parsed.input_tokens,
      outputTokens: parsed.output_tokens,
      cacheReadTokens: parsed.cache_read_tokens,
      cacheWriteTokens: parsed.cache_write_tokens,
      isApproximate: false,
    };
  } catch (error) {
    core.warning(`AgentMeter: failed to fetch agent-tokens artifact: ${error}`);
    return undefined;
  }
}

/**
 * Extracts and parses agent-tokens.json from a zip ArrayBuffer.
 * Uses the JSZip-free approach: the artifact zip for a single JSON file
 * is small enough to locate the JSON by scanning for the file signature.
 */
async function parseAgentTokensZip(zipData: ArrayBuffer): Promise<AgentTokensArtifact | null> {
  try {
    // GitHub artifact zips contain the file content after the local file header.
    // We locate the JSON by searching for the opening brace after the filename.
    const bytes = new Uint8Array(zipData);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    // Find agent-tokens.json content: look for {"input_tokens": pattern
    const jsonMatch = text.match(/\{"input_tokens"[\s\S]*?\}/);
    if (!jsonMatch) {
      core.warning('AgentMeter: could not locate JSON in agent-tokens artifact zip.');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as AgentTokensArtifact;

    // Validate it has the expected shape
    if (typeof parsed.input_tokens !== 'number') {
      core.warning('AgentMeter: agent-tokens artifact has unexpected structure.');
      return null;
    }

    return parsed;
  } catch (error) {
    core.warning(`AgentMeter: failed to parse agent-tokens zip: ${error}`);
    return null;
  }
}
