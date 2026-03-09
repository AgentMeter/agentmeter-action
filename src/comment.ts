import * as core from '@actions/core';
import type { Octokit } from '@octokit/core';
import type { RunCommentData, TokenCountsWithMeta } from './types';

const COMMENT_MARKER = '<!-- agentmeter -->';

/** Status emoji mapping */
const STATUS_EMOJI: Record<string, string> = {
  success: '✅',
  failed: '❌',
  timed_out: '⏱',
  cancelled: '🚫',
  needs_human: '👤',
  running: '⏳',
};

/**
 * Formats cents to a USD dollar string (e.g. 452 → "$4.52").
 */
function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Formats a duration in seconds to a human-readable string (e.g. 1102 → "18m").
 */
function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * Formats a number with comma separators.
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Builds the Markdown comment body for a PR/issue.
 * Parses any existing comment to extract previous run rows and append the new one.
 */
export function buildCommentBody({
  existingBody,
  runData,
}: {
  /** Existing comment body to update, if any */
  existingBody: string | null;
  /** New run data to append */
  runData: RunCommentData;
}): string {
  const existingRuns = existingBody ? parseExistingRuns(existingBody) : [];
  const allRuns = [...existingRuns, runData];

  const statusIcon = STATUS_EMOJI[runData.status] ?? '❓';
  void statusIcon;

  const tableRows = allRuns
    .map((run, i) => {
      const icon = STATUS_EMOJI[run.status] ?? '❓';
      return `| ${i + 1} | ${run.workflowName} | ${icon} | ${formatCost(run.totalCostCents)} | ${formatDuration(undefined)} |`;
    })
    .join('\n');

  const totalCostCents = allRuns.reduce((sum, r) => sum + r.totalCostCents, 0);
  const totalRow =
    allRuns.length > 1 ? `| **Total** | | | **${formatCost(totalCostCents)}** | |` : '';

  const latestRun = runData;
  const tokenDetails = buildTokenDetails(latestRun);

  const lines = [
    COMMENT_MARKER,
    '## ⚡ AgentMeter',
    '',
    '| # | Workflow | Status | Cost | Duration |',
    '|---|----------|--------|------|----------|',
    tableRows,
    ...(totalRow ? [totalRow] : []),
    '',
    ...(tokenDetails ? [tokenDetails, ''] : []),
    `[View in AgentMeter →](${latestRun.dashboardUrl})`,
  ];

  return lines.join('\n');
}

/**
 * Builds the collapsible token breakdown section for the latest run.
 */
function buildTokenDetails(run: RunCommentData): string | null {
  const { tokens, model, turns } = run;
  if (!tokens) return null;

  const cacheHitRate =
    tokens.cacheReadTokens + tokens.inputTokens > 0
      ? Math.round((tokens.cacheReadTokens / (tokens.cacheReadTokens + tokens.inputTokens)) * 100)
      : 0;

  const rows = [
    `| Input | ${formatNumber(tokens.inputTokens)} | — |`,
    `| Output | ${formatNumber(tokens.outputTokens)} | — |`,
    `| Cache writes | ${formatNumber(tokens.cacheWriteTokens)} | — |`,
    `| Cache reads | ${formatNumber(tokens.cacheReadTokens)} | — |`,
  ].join('\n');

  const meta = [
    model ? `Model: ${model}` : null,
    turns ? `${turns} turns` : null,
    tokens.cacheReadTokens > 0 ? `${cacheHitRate}% cache hit rate` : null,
    tokens.isApproximate ? '_(token data is approximate)_' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return [
    '<details>',
    '<summary>Token breakdown</summary>',
    '',
    '| Type | Tokens | Cost |',
    '|------|--------|------|',
    rows,
    '',
    ...(meta ? [meta] : []),
    '</details>',
  ].join('\n');
}

/** Minimal shape of a parsed run row from an existing comment */
interface ParsedRun {
  workflowName: string;
  status: string;
  totalCostCents: number;
  dashboardUrl: string;
  tokens?: TokenCountsWithMeta;
  model: string | null;
  turns: number | null;
}

/**
 * Parses run rows out of an existing AgentMeter comment body.
 * Returns an empty array if parsing fails or comment is malformed.
 */
function parseExistingRuns(body: string): ParsedRun[] {
  try {
    const tableMatch = body.match(/\| #.*?\n\|[-|: ]+\n((?:\|.*?\n)*)/s);
    if (!tableMatch?.[1]) return [];

    const rows = tableMatch[1]
      .trim()
      .split('\n')
      .filter((r) => r.startsWith('|') && !r.includes('**Total**'));

    return rows
      .map((row) => {
        const cells = row
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean);
        if (cells.length < 4) return null;

        const workflowName = cells[1] ?? '';
        const statusEmoji = cells[2] ?? '';
        const costStr = (cells[3] ?? '').replace(/[$*]/g, '');
        const totalCostCents = Math.round(parseFloat(costStr) * 100);

        const status =
          Object.entries(STATUS_EMOJI).find(([, emoji]) => emoji === statusEmoji)?.[0] ?? 'other';

        const parsed: ParsedRun = {
          workflowName,
          status,
          totalCostCents: Number.isNaN(totalCostCents) ? 0 : totalCostCents,
          dashboardUrl: '',
          model: null,
          turns: null,
        };
        return parsed;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null) as ParsedRun[];
  } catch {
    return [];
  }
}

/**
 * Finds an existing AgentMeter comment on a PR/issue by looking for the comment marker.
 * Returns the comment ID if found, or null.
 */
async function findExistingComment({
  octokit,
  owner,
  repo,
  issueOrPrNumber,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  issueOrPrNumber: number;
}): Promise<{ id: number; body: string } | null> {
  try {
    const { data: comments } = await (
      octokit as ReturnType<typeof import('@actions/github').getOctokit>
    ).rest.issues.listComments({
      owner,
      repo,
      issue_number: issueOrPrNumber,
      per_page: 100,
    });

    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (!existing) return null;
    return { id: existing.id, body: existing.body ?? '' };
  } catch {
    return null;
  }
}

/**
 * Creates or updates the AgentMeter cost comment on a PR/issue.
 * Never throws — failures are logged as warnings.
 */
export async function upsertComment({
  octokit,
  owner,
  repo,
  issueOrPrNumber,
  runData,
}: {
  /** GitHub Octokit instance */
  octokit: Octokit;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Issue or PR number to comment on */
  issueOrPrNumber: number;
  /** Run data for the new comment row */
  runData: RunCommentData;
}): Promise<void> {
  try {
    const existing = await findExistingComment({
      octokit,
      owner,
      repo,
      issueOrPrNumber,
    });

    const body = buildCommentBody({
      existingBody: existing?.body ?? null,
      runData,
    });

    const gh = octokit as ReturnType<typeof import('@actions/github').getOctokit>;

    if (existing) {
      await gh.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await gh.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueOrPrNumber,
        body,
      });
    }
  } catch (error) {
    core.warning(`AgentMeter: failed to post comment: ${error}`);
  }
}
