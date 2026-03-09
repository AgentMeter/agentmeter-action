import { describe, expect, it } from 'vitest';
import { buildCommentBody } from '../src/comment';
import type { RunCommentData } from '../src/types';

const baseRun: RunCommentData = {
  workflowName: 'agent-implement',
  status: 'success',
  totalCostCents: 452,
  dashboardUrl: 'https://agentmeter.app/dashboard/runs/abc123',
  model: 'claude-sonnet-4-5',
  turns: 14,
  tokens: {
    inputTokens: 42318,
    outputTokens: 18204,
    cacheReadTokens: 128400,
    cacheWriteTokens: 31000,
    isApproximate: false,
  },
};

describe('buildCommentBody', () => {
  it('contains the agentmeter comment marker', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('<!-- agentmeter -->');
  });

  it('contains the AgentMeter heading', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('⚡ AgentMeter');
  });

  it('formats cost correctly', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('$4.52');
  });

  it('shows success emoji for successful run', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('✅');
  });

  it('shows failure emoji for failed run', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, status: 'failed', totalCostCents: 610 },
    });
    expect(body).toContain('❌');
  });

  it('shows timed_out emoji', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, status: 'timed_out' },
    });
    expect(body).toContain('⏱');
  });

  it('shows cancelled emoji', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, status: 'cancelled' },
    });
    expect(body).toContain('🚫');
  });

  it('shows needs_human emoji', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, status: 'needs_human' },
    });
    expect(body).toContain('👤');
  });

  it('includes workflow name', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('agent-implement');
  });

  it('includes dashboard link', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('https://agentmeter.app/dashboard/runs/abc123');
    expect(body).toContain('View in AgentMeter →');
  });

  it('includes token breakdown details section', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('<details>');
    expect(body).toContain('Token breakdown');
    expect(body).toContain('42,318');
    expect(body).toContain('18,204');
  });

  it('includes model and turns in token breakdown', () => {
    const body = buildCommentBody({ existingBody: null, runData: baseRun });
    expect(body).toContain('claude-sonnet-4-5');
    expect(body).toContain('14 turns');
  });

  it('shows approximate warning when isApproximate is true', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: {
        ...baseRun,
        tokens: { ...baseRun.tokens!, isApproximate: true },
      },
    });
    expect(body).toContain('approximate');
  });

  it('skips token details when tokens are not provided', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, tokens: undefined },
    });
    expect(body).not.toContain('<details>');
  });

  it('appends new run to existing comment and shows total', () => {
    const firstBody = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, workflowName: 'implement', totalCostCents: 452 },
    });
    const updatedBody = buildCommentBody({
      existingBody: firstBody,
      runData: {
        ...baseRun,
        workflowName: 'review',
        totalCostCents: 87,
        dashboardUrl: 'https://agentmeter.app/dashboard/runs/def456',
      },
    });
    expect(updatedBody).toContain('implement');
    expect(updatedBody).toContain('review');
    expect(updatedBody).toContain('**Total**');
  });
});
