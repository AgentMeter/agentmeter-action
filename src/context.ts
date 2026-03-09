import * as github from '@actions/github';
import type { WebhookPayload } from '@actions/github/lib/interfaces';
import type { ActionContext } from './types';

/**
 * Extracts the GitHub Actions context for the current workflow run.
 */
export function extractContext(): ActionContext {
  const ctx = github.context;
  const { owner, repo } = ctx.repo;
  const repoFullName = `${owner}/${repo}`;
  const eventName = ctx.eventName;
  const payload = ctx.payload;

  const triggerType = mapEventToTriggerType(eventName, payload);
  const { triggerRef, triggerNumber } = extractTriggerRef(eventName, payload);

  return {
    runId: ctx.runId,
    repoFullName,
    owner,
    repo,
    workflowName: ctx.workflow,
    triggerType,
    triggerRef,
    triggerNumber,
  };
}

/**
 * Maps a GitHub event name and payload to an AgentMeter trigger type string.
 */
export function mapEventToTriggerType(
  eventName: string,
  payload: WebhookPayload,
): string {
  if (eventName === 'issues') {
    if (payload.action === 'labeled') return 'issue_labeled';
    return 'other';
  }
  if (eventName === 'pull_request') {
    if (payload.action === 'opened') return 'pr_opened';
    if (payload.action === 'synchronize') return 'pr_synchronize';
    return 'other';
  }
  if (
    eventName === 'issue_comment' ||
    eventName === 'pull_request_review_comment'
  ) {
    return 'pr_comment';
  }
  if (eventName === 'schedule') return 'schedule';
  if (eventName === 'workflow_dispatch') return 'workflow_dispatch';
  return 'other';
}

/**
 * Extracts the trigger reference (e.g. "#45", "PR #38") and numeric trigger number
 * from the GitHub event payload.
 */
export function extractTriggerRef(
  eventName: string,
  payload: WebhookPayload,
): { triggerRef: string | null; triggerNumber: number | null } {
  if (eventName === 'issues' && payload.issue) {
    return {
      triggerRef: `#${payload.issue.number}`,
      triggerNumber: payload.issue.number,
    };
  }
  if (
    (eventName === 'pull_request' ||
      eventName === 'pull_request_review_comment') &&
    payload.pull_request
  ) {
    return {
      triggerRef: `PR #${payload.pull_request.number}`,
      triggerNumber: payload.pull_request.number,
    };
  }
  if (eventName === 'issue_comment' && payload.issue) {
    const isPR = !!payload.issue.pull_request;
    return {
      triggerRef: isPR
        ? `PR #${payload.issue.number}`
        : `#${payload.issue.number}`,
      triggerNumber: payload.issue.number,
    };
  }
  return { triggerRef: null, triggerNumber: null };
}
