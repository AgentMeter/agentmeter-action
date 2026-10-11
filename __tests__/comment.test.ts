import { describe, expect, it } from 'vitest';
import { buildCommentBody } from '../src/comment';
import type { RunCommentData } from '../src/types';

const baseRun: RunCommentData = {
  workflowName: 'agent-implement',
  status: 'success',
  totalTokens: 219_922,
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
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('<!-- agentmeter -->');
  });

  it('contains the AgentMeter heading', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('⚡ AgentMeter');
  });

  it('shows the run total in the Tokens column, with no dollar amounts', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('| Tokens |');
    expect(body).toContain('| ✅ | 219,922 |');
    expect(body).not.toContain('$');
  });

  it('shows — when the run total is unknown', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, tokens: undefined, totalTokens: null },
    });
    expect(body).toContain('| ✅ | — |');
  });

  it('shows each token type share and a total in the breakdown', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('| Type | Tokens | Share |');
    // 128400 / 219922 ≈ 58%
    expect(body).toContain('| Cache reads | 128,400 | 58% |');
    expect(body).toContain('| **Total** | **219,922** | |');
  });

  it('shows success emoji for successful run', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('✅');
  });

  it('shows failure emoji for failed run', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, status: 'failed', totalTokens: 610 },
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
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('agent-implement');
  });

  it('includes model name in table row', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('claude-sonnet-4-5');
  });

  it('includes dashboard link', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('https://agentmeter.app/dashboard/runs/abc123');
    expect(body).toContain('View in AgentMeter →');
  });

  it('includes token breakdown details section', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
    expect(body).toContain('<details>');
    expect(body).toContain('Token breakdown');
    expect(body).toContain('42,318');
    expect(body).toContain('18,204');
  });

  it('includes model and turns in token breakdown', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: baseRun,
    });
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

  it('calculates cache hit rate using reads / (reads + writes + input)', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: {
        ...baseRun,
        tokens: {
          inputTokens: 50,
          outputTokens: 2172,
          cacheWriteTokens: 55569,
          cacheReadTokens: 124794,
          isApproximate: false,
        },
      },
    });
    // 124794 / (50 + 55569 + 124794) = 124794 / 180413 ≈ 69%
    expect(body).toContain('69% cache hit rate');
  });

  it('does not show cache hit rate when cacheReadTokens is 0', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: {
        ...baseRun,
        tokens: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          isApproximate: false,
        },
      },
    });
    expect(body).not.toContain('cache hit rate');
  });

  it('skips token details when tokens are not provided', () => {
    const body = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, tokens: undefined },
    });
    expect(body).not.toContain('<details>');
  });

  it('correctly parses an existing comment written in the old 5-column format', () => {
    const oldFormatBody = [
      '<!-- agentmeter -->',
      '## ⚡ AgentMeter',
      '',
      '| # | Workflow | Status | Cost | Duration |',
      '|---|----------|--------|------|----------|',
      '| 1 | AgentMeter — Inline Test | ✅ | $0.01 | 11s |',
      '',
      '[View in AgentMeter →](https://agentmeter.app/dashboard/runs/abc)',
    ].join('\n');

    const updatedBody = buildCommentBody({
      existingBody: oldFormatBody,
      runData: { ...baseRun, workflowName: 'Agent: Code Review', totalTokens: 3300 },
    });
    expect(updatedBody).toContain('AgentMeter — Inline Test');
    expect(updatedBody).toContain('Agent: Code Review');
    // Legacy cost cells have no token equivalent, so the old row shows — and the total is a lower bound
    expect(updatedBody).toContain('| AgentMeter — Inline Test | — | ✅ | — | 11s |');
    expect(updatedBody).toContain('| **Total** | | | | **≥ 3,300** | |');
    expect(updatedBody).not.toContain('$');
  });

  it('drops dollar costs from a comment written in the 6-column cost format', () => {
    const costFormatBody = [
      '<!-- agentmeter -->',
      '## ⚡ AgentMeter',
      '',
      '| # | Workflow | Model | Status | Cost | Duration |',
      '|---|----------|-------|--------|------|----------|',
      '| 1 | implement | claude-sonnet-4-5 | ✅ | $4.52 | 18m |',
      '',
      '[View in AgentMeter →](https://agentmeter.app/dashboard/runs/abc)',
    ].join('\n');

    const updatedBody = buildCommentBody({
      existingBody: costFormatBody,
      runData: { ...baseRun, workflowName: 'review', totalTokens: 1000 },
    });
    expect(updatedBody).toContain('| 2 | implement | claude-sonnet-4-5 | ✅ | — | 18m |');
    expect(updatedBody).not.toContain('$');
  });

  it('shows newest run first (row #1)', () => {
    const firstBody = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, workflowName: 'first-run' },
    });
    const secondBody = buildCommentBody({
      existingBody: firstBody,
      runData: { ...baseRun, workflowName: 'second-run' },
    });
    const rows = secondBody.match(/\| \d+ \| .+? \|/g) ?? [];
    expect(rows[0]).toContain('second-run');
    expect(rows[1]).toContain('first-run');
  });

  it('shows all runs inline when count is at or below the limit', () => {
    let body: string | null = null;
    for (let i = 0; i < 5; i++) {
      body = buildCommentBody({
        existingBody: body,
        runData: { ...baseRun, workflowName: `run-${i}` },
      });
    }
    // No "All N runs" collapsible should appear
    expect(body).not.toContain('All 5 runs');
    expect(body).not.toContain('All 6 runs');
  });

  it('shows only 5 most recent runs and adds collapsible when over limit', () => {
    let body: string | null = null;
    for (let i = 1; i <= 7; i++) {
      body = buildCommentBody({
        existingBody: body,
        runData: { ...baseRun, workflowName: `run-${i}` },
      });
    }
    // Collapsible should exist
    expect(body).toContain('All 7 runs');
    // Latest 5 visible in main table (runs 7, 6, 5, 4, 3)
    const mainTableSection = body!.split('<details>')[0];
    expect(mainTableSection).toContain('run-7');
    expect(mainTableSection).toContain('run-3');
    expect(mainTableSection).not.toContain('run-2');
    expect(mainTableSection).not.toContain('run-1');
    // All runs present inside collapsible
    expect(body).toContain('run-1');
    expect(body).toContain('run-2');
  });

  it('appends new run to existing comment and shows total', () => {
    const firstBody = buildCommentBody({
      existingBody: null,
      runData: { ...baseRun, workflowName: 'implement', totalTokens: 452_000 },
    });
    const updatedBody = buildCommentBody({
      existingBody: firstBody,
      runData: {
        ...baseRun,
        workflowName: 'review',
        totalTokens: 87_000,
        dashboardUrl: 'https://agentmeter.app/dashboard/runs/def456',
      },
    });
    expect(updatedBody).toContain('implement');
    expect(updatedBody).toContain('review');
    // Exact counts round-trip through the comment, so the total is precise
    expect(updatedBody).toContain('| **Total** | | | | **539,000** | |');
  });
});
