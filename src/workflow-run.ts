import * as core from '@actions/core';
import * as github from '@actions/github';
import { unzipSync } from 'fflate';
import type { AgentTokensArtifact, TokenCountsWithMeta } from './types';

/**
 * Data resolved from the triggering agent workflow run.
 */
export interface WorkflowRunData {
  /** ISO 8601 timestamp when the triggering run started, or null if unavailable */
  startedAt: string | null;
  /** ISO 8601 timestamp when the triggering run completed, or null if unavailable */
  completedAt: string | null;
  /** PR number associated with the triggering run, if any */
  triggerNumber: number | null;
  /** Event name of the triggering run (pull_request, issues, etc.) */
  triggerEvent: string;
  /** Normalized AgentMeter trigger type (pr_comment, pull_request, issues, etc.) */
  triggerType: string;
  /** Human-readable trigger ref (e.g. "PR #42", "#7") resolved from the triggering run */
  triggerRef: string | null;
  /** Token counts extracted from the agent-tokens artifact, if available */
  tokens: TokenCountsWithMeta | undefined;
  /**
   * Whether the action should proceed with ingesting this run.
   * False when the triggering workflow's terminal job hasn't completed yet
   * (gh-aw fires workflow_run for each of its 5 jobs — we only want the last).
   * Also false when the run was skipped (nothing to track).
   */
  shouldProceed: boolean;
  /** Normalized status string valid for the AgentMeter API */
  normalizedStatus: string;
  /** Name of the triggering agent workflow (not the companion tracking workflow) */
  workflowName: string;
}

/**
 * Fetches metadata and token data from the triggering agent workflow run.
 * Also checks whether the terminal job has completed (gate logic) and
 * normalizes the workflow conclusion to a valid API status value.
 * Never throws — logs warnings and returns partial data on failure.
 */
export async function resolveWorkflowRun({
  githubToken,
  owner,
  rawConclusion,
  repo,
  workflowRunId,
}: {
  /** GitHub token for API access */
  githubToken: string;
  /** Repository owner */
  owner: string;
  /** Raw workflow_run conclusion from the GitHub event payload */
  rawConclusion: string;
  /** Repository name */
  repo: string;
  /** Run ID of the triggering agent workflow */
  workflowRunId: number;
}): Promise<WorkflowRunData> {
  const octokit = github.getOctokit(githubToken);

  const normalizedStatus = normalizeConclusion(rawConclusion);

  // Skipped runs have nothing to track — bail immediately without API calls
  if (normalizedStatus === 'skip') {
    core.info('AgentMeter: triggering workflow was skipped — nothing to track.');
    return emptyResult({ shouldProceed: false, normalizedStatus });
  }

  // Gate: gh-aw fires workflow_run for each of its ~5 jobs. Only proceed when
  // the terminal "conclusion" job has completed, so we track exactly one record.
  const shouldProceed = await checkConclusionJobCompleted({
    octokit,
    owner,
    repo,
    workflowRunId,
  });

  if (!shouldProceed) {
    return emptyResult({ shouldProceed: false, normalizedStatus });
  }

  const run = await fetchRun({ octokit, owner, repo, workflowRunId });

  const startedAt = run?.run_started_at ?? null;
  const completedAt = run?.updated_at ?? null;

  const { triggerNumber, triggerEvent, triggerType, triggerRef } = await resolveTrigger({
    pullRequests: run?.pull_requests ?? [],
    headBranch: run?.head_branch ?? '',
    headSha: run?.head_sha ?? '',
    event: run?.event ?? '',
    octokit,
    owner,
    repo,
  });

  const tokens = await fetchAgentTokens({ octokit, owner, repo, workflowRunId });

  return {
    startedAt,
    completedAt,
    triggerNumber,
    triggerEvent,
    triggerType,
    triggerRef,
    tokens,
    shouldProceed: true,
    normalizedStatus,
    workflowName: run?.name ?? '',
  };
}

/**
 * Maps a raw GitHub step/workflow conclusion to a valid AgentMeter API status value.
 * Returns 'skip' for conclusions that should not be tracked.
 * GitHub step outcomes use 'failure'; the API expects 'failed'.
 */
export function normalizeConclusion(conclusion: string): string {
  const map: Record<string, string> = {
    success: 'success',
    failure: 'failed',
    timed_out: 'timed_out',
    cancelled: 'cancelled',
    skipped: 'skip',
  };
  // Preserve unrecognized values as-is so custom statuses (e.g. 'needs_human') are not
  // silently replaced with 'failed'. Only normalize the known GitHub conclusion strings.
  return map[conclusion] ?? conclusion;
}

/**
 * Returns a default WorkflowRunData with shouldProceed=false.
 */
function emptyResult({
  normalizedStatus,
  shouldProceed,
}: {
  /** Normalized status */
  normalizedStatus: string;
  /** Whether to proceed */
  shouldProceed: boolean;
}): WorkflowRunData {
  return {
    startedAt: null,
    completedAt: null,
    triggerNumber: null,
    triggerEvent: '',
    triggerType: 'other',
    triggerRef: null,
    tokens: undefined,
    shouldProceed,
    normalizedStatus,
    workflowName: '',
  };
}

/**
 * Checks whether the terminal "conclusion" job in a gh-aw workflow run has
 * completed. workflow_run fires for each job completion (~5 times per run),
 * so we use this to ensure we only ingest once per agent run.
 */
async function checkConclusionJobCompleted({
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
}): Promise<boolean> {
  try {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: workflowRunId,
    });
    const conclusionJob = data.jobs.find((j) => j.name === 'conclusion');
    if (!conclusionJob) {
      // No conclusion job means this is not a gh-aw workflow — proceed without gating.
      core.info('AgentMeter: no conclusion job found — not a gh-aw workflow, proceeding.');
      return true;
    }
    if (conclusionJob.status !== 'completed') {
      core.info('AgentMeter: conclusion job not yet completed — skipping this firing.');
      return false;
    }
    core.info(`AgentMeter: conclusion job completed (${conclusionJob.conclusion}) — proceeding.`);
    return true;
  } catch (error) {
    // Fail closed on API errors — proceeding on a failed gate check risks double-ingest.
    // A missing conclusion job (non-gh-aw workflow) is handled above as a successful
    // API call that returns no matching job, not as an exception.
    core.warning(`AgentMeter: could not check conclusion job status: ${error}. Skipping.`);
    return false;
  }
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
  head_sha?: string | null;
  event?: string | null;
  name?: string | null;
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
      head_sha: data.head_sha,
      event: data.event,
      name: data.name,
      pull_requests: (data.pull_requests ?? []).map((pr) => ({ number: pr.number })),
    };
  } catch (error) {
    core.warning(`AgentMeter: failed to fetch workflow run ${workflowRunId}: ${error}`);
    return null;
  }
}

/**
 * Resolves the trigger PR/issue number and event name from the workflow run.
 * Checks the pull_requests array first, then falls back to a PR list lookup
 * by head branch (handles the common case where GitHub leaves pull_requests[]
 * empty for workflow_run events), then the branch name convention for issues.
 */
async function resolveTrigger({
  headBranch,
  headSha,
  event,
  octokit,
  owner,
  pullRequests,
  repo,
}: {
  /** Head branch name of the triggering run */
  headBranch: string;
  /** Head commit SHA of the triggering run — used to validate the PR fallback match */
  headSha: string;
  /** Event that triggered the original workflow run */
  event: string;
  /** Authenticated Octokit instance */
  octokit: ReturnType<typeof github.getOctokit>;
  /** Repository owner */
  owner: string;
  /** Pull requests associated with the triggering run */
  pullRequests: Array<{ number: number }>;
  /** Repository name */
  repo: string;
}): Promise<{
  triggerNumber: number | null;
  triggerEvent: string;
  triggerType: string;
  triggerRef: string | null;
}> {
  if (pullRequests.length > 0 && pullRequests[0]) {
    const num = pullRequests[0].number;
    return {
      triggerNumber: num,
      triggerEvent: event,
      triggerType: normalizeTriggerType({ event, isPR: true }),
      triggerRef: `PR #${num}`,
    };
  }

  // GitHub frequently leaves pull_requests[] empty for workflow_run events even when the
  // triggering workflow ran on a PR. Also covers issue_comment / pull_request_review_comment
  // triggered workflows. Use state: 'all' + sort by updated so we find recently-merged PRs
  // in case the companion workflow fires after the PR closes; most-recently-updated PR wins.
  const prLikeEvents = new Set(['issue_comment', 'pull_request', 'pull_request_review_comment']);
  if (prLikeEvents.has(event) && headBranch) {
    try {
      const { data: prs } = await octokit.rest.pulls.list({
        direction: 'desc',
        // Omit owner prefix so forked PRs are also matched (fork owner differs from base owner)
        head: headBranch,
        owner,
        per_page: 5,
        repo,
        sort: 'updated',
        state: 'all',
      });
      // Validate by head SHA when available to avoid matching the wrong PR when multiple
      // PRs share the same branch name (e.g. reused or fork branches).
      // When headSha is provided but no PR matches, return null rather than guessing.
      const shaMatch = headSha ? prs.find((pr) => pr.head.sha === headSha) : null;
      const match = shaMatch ?? (headSha ? null : prs[0]);
      if (match) {
        return {
          triggerNumber: match.number,
          triggerEvent: event,
          triggerType: normalizeTriggerType({ event, isPR: true }),
          triggerRef: `PR #${match.number}`,
        };
      }
    } catch (error) {
      core.warning(`AgentMeter: could not look up PR for branch ${headBranch}: ${error}`);
    }
  }

  // gh-aw issue branches are named agent/issue-N — require the full prefix to
  // avoid mismatching unrelated branches like feature/fix-issue-12-auth.
  const issueMatch = headBranch.match(/\bagent\/issue-(\d+)\b/);
  if (issueMatch?.[1]) {
    const num = parseInt(issueMatch[1], 10);
    return {
      triggerNumber: num,
      triggerEvent: 'issues',
      triggerType: 'issues',
      triggerRef: `#${num}`,
    };
  }

  return {
    triggerNumber: null,
    triggerEvent: event || '',
    triggerType: event || 'other',
    triggerRef: null,
  };
}

/**
 * Maps a raw GitHub event name to a normalized AgentMeter trigger type for companion
 * workflow_run mode, where the full payload is unavailable. Uses isPR to distinguish
 * issue_comment on a PR from issue_comment on a plain issue.
 */
function normalizeTriggerType({
  event,
  isPR,
}: {
  /** Raw GitHub event name */
  event: string;
  /** Whether the run was associated with a PR */
  isPR: boolean;
}): string {
  if (event === 'issue_comment' || event === 'pull_request_review_comment') {
    return isPR ? 'pr_comment' : 'issue_comment';
  }
  return event || 'other';
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
 * Extracts and parses agent-tokens.json from a zip ArrayBuffer using fflate.
 */
async function parseAgentTokensZip(zipData: ArrayBuffer): Promise<AgentTokensArtifact | null> {
  try {
    const unzipped = unzipSync(new Uint8Array(zipData));
    const file = unzipped['agent-tokens.json'];
    if (!file) {
      core.warning('AgentMeter: agent-tokens.json not found inside artifact zip.');
      return null;
    }
    const parsed = JSON.parse(new TextDecoder().decode(file)) as AgentTokensArtifact;
    if (typeof parsed.input_tokens !== 'number') {
      core.warning('AgentMeter: agent-tokens artifact has unexpected structure.');
      return null;
    }
    return {
      cache_read_tokens:
        typeof parsed.cache_read_tokens === 'number' ? parsed.cache_read_tokens : 0,
      cache_write_tokens:
        typeof parsed.cache_write_tokens === 'number' ? parsed.cache_write_tokens : 0,
      input_tokens: parsed.input_tokens,
      output_tokens: typeof parsed.output_tokens === 'number' ? parsed.output_tokens : 0,
    };
  } catch (error) {
    core.warning(`AgentMeter: failed to parse agent-tokens zip: ${error}`);
    return null;
  }
}
