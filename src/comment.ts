import * as core from '@actions/core';
import type { Octokit } from '@octokit/core';
import { getPricing, type ModelPricing } from './pricing';
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
 * Formats a token cost in USD (e.g. 0.004521 → "$0.0045").
 */
function formatTokenCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

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
  apiPricing,
  existingBody,
  runData,
}: {
  /** Pricing fetched from the AgentMeter API */
  apiPricing: Record<string, ModelPricing>;
  /** Existing comment body to update, if any */
  existingBody: string | null;
  /** New run data to append */
  runData: RunCommentData;
}): string {
  const existingRuns = existingBody ? parseExistingRuns(existingBody) : [];
  const allRuns = [...existingRuns, runData];

  const tableRows = allRuns
    .map((run, i) => {
      const icon = STATUS_EMOJI[run.status] ?? '❓';
      const model = run.model ?? '—';
      return `| ${i + 1} | ${run.workflowName} | ${model} | ${icon} | ${formatCost(run.totalCostCents)} | ${formatDuration(run.durationSeconds)} |`;
    })
    .join('\n');

  const totalCostCents = allRuns.reduce((sum, r) => sum + r.totalCostCents, 0);
  const totalRow =
    allRuns.length > 1 ? `| **Total** | | | | **${formatCost(totalCostCents)}** | |` : '';

  const latestRun = runData;
  const tokenDetails = buildTokenDetails({ apiPricing, run: latestRun });

  const lines = [
    COMMENT_MARKER,
    '## ⚡ AgentMeter',
    '',
    '| # | Workflow | Model | Status | Cost | Duration |',
    '|---|----------|-------|--------|------|----------|',
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
function buildTokenDetails({
  apiPricing,
  run,
}: {
  /** Pricing fetched from the AgentMeter API */
  apiPricing: Record<string, ModelPricing>;
  /** Run data */
  run: RunCommentData;
}): string | null {
  const { tokens, model, turns } = run;
  if (!tokens) return null;

  const cacheHitRate =
    tokens.cacheReadTokens + tokens.inputTokens > 0
      ? Math.round((tokens.cacheReadTokens / (tokens.cacheReadTokens + tokens.inputTokens)) * 100)
      : 0;

  const pricing = getPricing({ apiPricing, model });
  const perM = (count: number, pricePerM: number | undefined): string => {
    if (!pricing || pricePerM == null) return '—';
    return formatTokenCost((count / 1_000_000) * pricePerM);
  };

  const rows = [
    `| Input | ${formatNumber(tokens.inputTokens)} | ${perM(tokens.inputTokens, pricing?.inputPer1M)} |`,
    `| Output | ${formatNumber(tokens.outputTokens)} | ${perM(tokens.outputTokens, pricing?.outputPer1M)} |`,
    `| Cache writes | ${formatNumber(tokens.cacheWriteTokens)} | ${perM(tokens.cacheWriteTokens, pricing?.cacheWritePer1M)} |`,
    `| Cache reads | ${formatNumber(tokens.cacheReadTokens)} | ${perM(tokens.cacheReadTokens, pricing?.cacheReadPer1M)} |`,
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

/**
 * Parses a duration string back to seconds (e.g. "4m" → 240, "0s" → 0, "—" → null).
 */
function parseDuration(str: string): number | null {
  if (!str || str === '—') return null;
  const mMatch = str.match(/(\d+)m(?:\s+(\d+)s)?/);
  if (mMatch) return parseInt(mMatch[1], 10) * 60 + parseInt(mMatch[2] ?? '0', 10);
  const sMatch = str.match(/(\d+)s/);
  if (sMatch) return parseInt(sMatch[1], 10);
  return null;
}

/** Minimal shape of a parsed run row from an existing comment */
interface ParsedRun {
  workflowName: string;
  status: string;
  totalCostCents: number;
  durationSeconds: number | null;
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

        // Support both old (5-col) and new (6-col) format:
        // Old: # | Workflow | Status | Cost | Duration
        // New: # | Workflow | Model  | Status | Cost | Duration
        const hasModelCol = cells.length >= 6;
        const workflowName = cells[1] ?? '';
        const model = hasModelCol && cells[2] && cells[2] !== '—' ? cells[2] : null;
        const statusEmoji = (hasModelCol ? cells[3] : cells[2]) ?? '';
        const costStr = ((hasModelCol ? cells[4] : cells[3]) ?? '').replace(/[$*]/g, '');
        const totalCostCents = Math.round(parseFloat(costStr) * 100);
        const durationSeconds = parseDuration((hasModelCol ? cells[5] : cells[4]) ?? '');

        const status =
          Object.entries(STATUS_EMOJI).find(([, emoji]) => emoji === statusEmoji)?.[0] ?? 'other';

        const parsed: ParsedRun = {
          workflowName,
          status,
          totalCostCents: Number.isNaN(totalCostCents) ? 0 : totalCostCents,
          durationSeconds,
          dashboardUrl: '',
          model,
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
  apiPricing,
  octokit,
  owner,
  repo,
  issueOrPrNumber,
  runData,
}: {
  /** Pricing fetched from the AgentMeter API */
  apiPricing: Record<string, ModelPricing>;
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
      apiPricing,
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
