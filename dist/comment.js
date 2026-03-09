"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCommentBody = buildCommentBody;
exports.upsertComment = upsertComment;
const core = __importStar(require("@actions/core"));
const COMMENT_MARKER = '<!-- agentmeter -->';
/** Status emoji mapping */
const STATUS_EMOJI = {
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
function formatCost(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}
/**
 * Formats a duration in seconds to a human-readable string (e.g. 1102 → "18m").
 */
function formatDuration(seconds) {
    if (seconds == null)
        return '—';
    if (seconds < 60)
        return `${seconds}s`;
    return `${Math.round(seconds / 60)}m`;
}
/**
 * Formats a number with comma separators.
 */
function formatNumber(n) {
    return n.toLocaleString('en-US');
}
/**
 * Builds the Markdown comment body for a PR/issue.
 * Parses any existing comment to extract previous run rows and append the new one.
 */
function buildCommentBody({ existingBody, runData, }) {
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
    const totalRow = allRuns.length > 1
        ? `| **Total** | | | **${formatCost(totalCostCents)}** | |`
        : '';
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
function buildTokenDetails(run) {
    const { tokens, model, turns } = run;
    if (!tokens)
        return null;
    const cacheHitRate = tokens.cacheReadTokens + tokens.inputTokens > 0
        ? Math.round((tokens.cacheReadTokens /
            (tokens.cacheReadTokens + tokens.inputTokens)) *
            100)
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
/**
 * Parses run rows out of an existing AgentMeter comment body.
 * Returns an empty array if parsing fails or comment is malformed.
 */
function parseExistingRuns(body) {
    try {
        const tableMatch = body.match(/\| #.*?\n\|[-|: ]+\n((?:\|.*?\n)*)/s);
        if (!tableMatch?.[1])
            return [];
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
            if (cells.length < 4)
                return null;
            const workflowName = cells[1] ?? '';
            const statusEmoji = cells[2] ?? '';
            const costStr = (cells[3] ?? '').replace(/[$*]/g, '');
            const totalCostCents = Math.round(parseFloat(costStr) * 100);
            const status = Object.entries(STATUS_EMOJI).find(([, emoji]) => emoji === statusEmoji)?.[0] ?? 'other';
            const parsed = {
                workflowName,
                status,
                totalCostCents: Number.isNaN(totalCostCents) ? 0 : totalCostCents,
                dashboardUrl: '',
                model: null,
                turns: null,
            };
            return parsed;
        })
            .filter((r) => r !== null);
    }
    catch {
        return [];
    }
}
/**
 * Finds an existing AgentMeter comment on a PR/issue by looking for the comment marker.
 * Returns the comment ID if found, or null.
 */
async function findExistingComment({ octokit, owner, repo, issueOrPrNumber, }) {
    try {
        const { data: comments } = await octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: issueOrPrNumber,
            per_page: 100,
        });
        const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
        if (!existing)
            return null;
        return { id: existing.id, body: existing.body ?? '' };
    }
    catch {
        return null;
    }
}
/**
 * Creates or updates the AgentMeter cost comment on a PR/issue.
 * Never throws — failures are logged as warnings.
 */
async function upsertComment({ octokit, owner, repo, issueOrPrNumber, runData, }) {
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
        const gh = octokit;
        if (existing) {
            await gh.rest.issues.updateComment({
                owner,
                repo,
                comment_id: existing.id,
                body,
            });
        }
        else {
            await gh.rest.issues.createComment({
                owner,
                repo,
                issue_number: issueOrPrNumber,
                body,
            });
        }
    }
    catch (error) {
        core.warning(`AgentMeter: failed to post comment: ${error}`);
    }
}
