import type { WebhookPayload } from '@actions/github/lib/interfaces';
import { describe, expect, it } from 'vitest';
import { extractTriggerRef, mapEventToTriggerType } from '../src/context';

describe('mapEventToTriggerType', () => {
  it('returns issue_labeled for issues labeled action', () => {
    const payload = { action: 'labeled' } as WebhookPayload;
    expect(mapEventToTriggerType('issues', payload)).toBe('issue_labeled');
  });

  it('returns other for issues opened action', () => {
    const payload = { action: 'opened' } as WebhookPayload;
    expect(mapEventToTriggerType('issues', payload)).toBe('other');
  });

  it('returns pr_opened for pull_request opened action', () => {
    const payload = { action: 'opened' } as WebhookPayload;
    expect(mapEventToTriggerType('pull_request', payload)).toBe('pr_opened');
  });

  it('returns pr_synchronize for pull_request synchronize action', () => {
    const payload = { action: 'synchronize' } as WebhookPayload;
    expect(mapEventToTriggerType('pull_request', payload)).toBe('pr_synchronize');
  });

  it('returns other for unknown pull_request action', () => {
    const payload = { action: 'closed' } as WebhookPayload;
    expect(mapEventToTriggerType('pull_request', payload)).toBe('other');
  });

  it('returns pr_comment for issue_comment on a PR', () => {
    const payload = { issue: { number: 5, pull_request: { url: 'x' } } } as WebhookPayload;
    expect(mapEventToTriggerType('issue_comment', payload)).toBe('pr_comment');
  });

  it('returns issue_comment for issue_comment on a plain issue', () => {
    const payload = { issue: { number: 5 } } as WebhookPayload;
    expect(mapEventToTriggerType('issue_comment', payload)).toBe('issue_comment');
  });

  it('returns pr_comment for pull_request_review_comment event', () => {
    expect(mapEventToTriggerType('pull_request_review_comment', {})).toBe('pr_comment');
  });

  it('returns schedule for schedule event', () => {
    expect(mapEventToTriggerType('schedule', {})).toBe('schedule');
  });

  it('returns workflow_dispatch for workflow_dispatch event', () => {
    expect(mapEventToTriggerType('workflow_dispatch', {})).toBe('workflow_dispatch');
  });

  it('returns other for unknown events', () => {
    expect(mapEventToTriggerType('push', {})).toBe('other');
  });
});

describe('extractTriggerRef', () => {
  it('extracts issue number from issues event', () => {
    const payload = { issue: { number: 45 } } as WebhookPayload;
    const result = extractTriggerRef('issues', payload);
    expect(result.triggerRef).toBe('#45');
    expect(result.triggerNumber).toBe(45);
  });

  it('extracts PR number from pull_request event', () => {
    const payload = { pull_request: { number: 38 } } as WebhookPayload;
    const result = extractTriggerRef('pull_request', payload);
    expect(result.triggerRef).toBe('PR #38');
    expect(result.triggerNumber).toBe(38);
  });

  it('extracts PR number from pull_request_review_comment event', () => {
    const payload = { pull_request: { number: 12 } } as WebhookPayload;
    const result = extractTriggerRef('pull_request_review_comment', payload);
    expect(result.triggerRef).toBe('PR #12');
    expect(result.triggerNumber).toBe(12);
  });

  it('extracts PR ref from issue_comment on a PR', () => {
    const payload = {
      issue: { number: 99, pull_request: {} },
    } as WebhookPayload;
    const result = extractTriggerRef('issue_comment', payload);
    expect(result.triggerRef).toBe('PR #99');
    expect(result.triggerNumber).toBe(99);
  });

  it('extracts issue ref from issue_comment on an issue', () => {
    const payload = { issue: { number: 55 } } as WebhookPayload;
    const result = extractTriggerRef('issue_comment', payload);
    expect(result.triggerRef).toBe('#55');
    expect(result.triggerNumber).toBe(55);
  });

  it('returns null for schedule event', () => {
    const result = extractTriggerRef('schedule', {});
    expect(result.triggerRef).toBeNull();
    expect(result.triggerNumber).toBeNull();
  });

  it('returns null for workflow_dispatch event', () => {
    const result = extractTriggerRef('workflow_dispatch', {});
    expect(result.triggerRef).toBeNull();
    expect(result.triggerNumber).toBeNull();
  });
});
