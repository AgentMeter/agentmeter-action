import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import { submitRun } from '../src/ingest';

vi.mock('@actions/core');

const mockPayload = {
  githubRunId: 12345678,
  repoFullName: 'adam/test-repo',
  workflowName: 'agent-implement',
  triggerType: 'issue_labeled',
  triggerRef: '#45',
  triggerNumber: 45,
  engine: 'claude',
  model: 'claude-sonnet-4-5',
  status: 'success',
  prNumber: null,
  durationSeconds: 120,
  turns: 14,
  startedAt: '2026-03-08T10:00:00.000Z',
  completedAt: '2026-03-08T10:02:00.000Z',
};

describe('submitRun', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ingest response on success', async () => {
    const mockResponse = {
      id: 'run-abc123',
      totalCostCents: 452,
      dashboardUrl: 'https://agentmeter.app/dashboard/runs/run-abc123',
    };

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await submitRun({
      apiKey: 'am_sk_test',
      apiUrl: 'https://agentmeter.app',
      payload: mockPayload,
    });

    expect(result).toEqual(mockResponse);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it('returns null and warns on non-OK response', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid API key',
    } as Response);

    const result = await submitRun({
      apiKey: 'bad_key',
      apiUrl: 'https://agentmeter.app',
      payload: mockPayload,
    });

    expect(result).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('401'),
    );
  });

  it('returns null and warns on network failure', async () => {
    vi.mocked(global.fetch)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    const result = await submitRun({
      apiKey: 'am_sk_test',
      apiUrl: 'https://agentmeter.app',
      payload: mockPayload,
    });

    expect(result).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('AgentMeter ingest failed'),
    );
  });

  it('retries once on network failure before succeeding', async () => {
    const mockResponse = {
      id: 'run-retry',
      totalCostCents: 100,
      dashboardUrl: 'https://agentmeter.app/dashboard/runs/run-retry',
    };

    vi.mocked(global.fetch)
      .mockRejectedValueOnce(new Error('Transient error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

    const result = await submitRun({
      apiKey: 'am_sk_test',
      apiUrl: 'https://agentmeter.app',
      payload: mockPayload,
    });

    expect(result).toEqual(mockResponse);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('sends the correct Authorization header', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'x', totalCostCents: 0, dashboardUrl: '' }),
    } as Response);

    await submitRun({
      apiKey: 'am_sk_mykey',
      apiUrl: 'https://agentmeter.app',
      payload: mockPayload,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://agentmeter.app/api/ingest',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer am_sk_mykey',
        }),
      }),
    );
  });
});
