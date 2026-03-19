import * as core from '@actions/core';
import * as github from '@actions/github';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkflowRun } from '../src/workflow-run';

vi.mock('@actions/core');
vi.mock('@actions/github');

const mockGetOctokit = vi.mocked(github.getOctokit);

function makeOctokit({
  runData = {},
  artifacts = [],
  artifactZip = null,
  jobs = [{ name: 'conclusion', status: 'completed', conclusion: 'success' }],
}: {
  runData?: Record<string, unknown>;
  artifacts?: Array<{ name: string; id: number }>;
  artifactZip?: ArrayBuffer | null;
  jobs?: Array<{ name: string; status: string; conclusion?: string }>;
}) {
  const defaultRun = {
    run_started_at: '2026-03-09T10:00:00Z',
    updated_at: '2026-03-09T10:05:00Z',
    head_branch: 'feat/my-feature',
    event: 'pull_request',
    pull_requests: [
      {
        number: 42,
        url: '',
        head: { ref: '', sha: '', repo: { id: 0, url: '', name: '' } },
        base: { ref: '', sha: '', repo: { id: 0, url: '', name: '' } },
      },
    ],
    ...runData,
  };

  return {
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({ data: defaultRun }),
        listJobsForWorkflowRun: vi.fn().mockResolvedValue({ data: { jobs } }),
        listWorkflowRunArtifacts: vi.fn().mockResolvedValue({ data: { artifacts } }),
        downloadArtifact: vi.fn().mockResolvedValue({ data: artifactZip }),
      },
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    },
  };
}

/** Creates a real zip buffer containing agent-tokens.json with the given JSON content */
function makeTokenZip(json: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const zipped = zipSync({ 'agent-tokens.json': encoder.encode(json) });
  return zipped.buffer as ArrayBuffer;
}

const baseArgs = {
  githubToken: 'token',
  owner: 'adam',
  rawConclusion: 'success',
  repo: 'repo',
  workflowRunId: 123,
};

describe('resolveWorkflowRun', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('proceeds and resolves timestamps when conclusion job is completed', async () => {
    const octokit = makeOctokit({});
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.shouldProceed).toBe(true);
    expect(result.startedAt).toBe('2026-03-09T10:00:00Z');
    expect(result.completedAt).toBe('2026-03-09T10:05:00Z');
  });

  it('skips when conclusion job is not yet completed', async () => {
    const octokit = makeOctokit({
      jobs: [{ name: 'conclusion', status: 'in_progress' }],
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.shouldProceed).toBe(false);
  });

  it('proceeds when no conclusion job exists (non-gh-aw workflow)', async () => {
    const octokit = makeOctokit({
      jobs: [{ name: 'agent', status: 'completed' }],
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.shouldProceed).toBe(true);
  });

  it('skips immediately for skipped conclusion without API calls', async () => {
    const octokit = makeOctokit({});
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun({ ...baseArgs, rawConclusion: 'skipped' });

    expect(result.shouldProceed).toBe(false);
    expect(result.normalizedStatus).toBe('skip');
    expect(octokit.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
  });

  it('normalizes failure → failed', async () => {
    const octokit = makeOctokit({});
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun({ ...baseArgs, rawConclusion: 'failure' });

    expect(result.normalizedStatus).toBe('failed');
  });

  it('normalizes success → success', async () => {
    const octokit = makeOctokit({});
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.normalizedStatus).toBe('success');
  });

  it('resolves trigger number from pull_requests array', async () => {
    const octokit = makeOctokit({});
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.triggerNumber).toBe(42);
    expect(result.triggerEvent).toBe('pull_request');
  });

  it('resolves trigger number via PR list API when pull_requests array is empty', async () => {
    const octokit = makeOctokit({
      runData: {
        run_started_at: '2026-03-09T10:00:00Z',
        updated_at: '2026-03-09T10:05:00Z',
        head_branch: 'chore/cleanup',
        event: 'pull_request',
        pull_requests: [],
      },
    });
    octokit.rest.pulls.list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.triggerNumber).toBe(7);
    expect(result.triggerEvent).toBe('pull_request');
  });

  it('resolves trigger number from branch name when no pull_requests', async () => {
    const octokit = makeOctokit({
      runData: {
        run_started_at: '2026-03-09T10:00:00Z',
        updated_at: '2026-03-09T10:05:00Z',
        head_branch: 'agent/issue-99',
        pull_requests: [],
      },
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.triggerNumber).toBe(99);
    expect(result.triggerEvent).toBe('issues');
  });

  it('returns null triggerNumber when branch has no issue pattern and no PRs', async () => {
    const octokit = makeOctokit({
      runData: {
        run_started_at: '2026-03-09T10:00:00Z',
        updated_at: '2026-03-09T10:05:00Z',
        head_branch: 'main',
        event: 'push',
        pull_requests: [],
      },
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.triggerNumber).toBeNull();
    expect(result.triggerEvent).toBe('push');
  });

  it('returns undefined tokens when no agent-tokens artifact exists', async () => {
    const octokit = makeOctokit({ artifacts: [] });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.tokens).toBeUndefined();
  });

  it('parses token counts from artifact zip', async () => {
    const json =
      '{"input_tokens":1000,"output_tokens":200,"cache_read_tokens":500,"cache_write_tokens":100}';
    const zip = makeTokenZip(json);

    const octokit = makeOctokit({
      artifacts: [{ name: 'agent-tokens', id: 999 }],
      artifactZip: zip,
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.tokens).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 100,
      isApproximate: false,
    });
  });

  it('defaults output_tokens to 0 when missing from artifact', async () => {
    const zip = makeTokenZip(
      '{"input_tokens":1000,"cache_read_tokens":500,"cache_write_tokens":100}'
    );
    const octokit = makeOctokit({
      artifacts: [{ name: 'agent-tokens', id: 999 }],
      artifactZip: zip,
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.tokens?.inputTokens).toBe(1000);
    expect(result.tokens?.outputTokens).toBe(0);
  });

  it('defaults cache_read_tokens to 0 when missing from artifact', async () => {
    const zip = makeTokenZip('{"input_tokens":1000,"output_tokens":200,"cache_write_tokens":100}');
    const octokit = makeOctokit({
      artifacts: [{ name: 'agent-tokens', id: 999 }],
      artifactZip: zip,
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.tokens?.inputTokens).toBe(1000);
    expect(result.tokens?.cacheReadTokens).toBe(0);
  });

  it('defaults cache_write_tokens to 0 when non-numeric in artifact', async () => {
    const zip = makeTokenZip(
      '{"input_tokens":1000,"output_tokens":200,"cache_read_tokens":500,"cache_write_tokens":"bad"}'
    );
    const octokit = makeOctokit({
      artifacts: [{ name: 'agent-tokens', id: 999 }],
      artifactZip: zip,
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.tokens?.inputTokens).toBe(1000);
    expect(result.tokens?.cacheWriteTokens).toBe(0);
  });

  it('skips when listJobsForWorkflowRun fails (fail closed to prevent double-ingest)', async () => {
    const octokit = makeOctokit({});
    octokit.rest.actions.listJobsForWorkflowRun = vi
      .fn()
      .mockRejectedValue(new Error('403 forbidden'));
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(result.shouldProceed).toBe(false);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('could not check conclusion job status')
    );
  });

  it('warns and returns partial data when workflow run API fails', async () => {
    const octokit = makeOctokit({});
    octokit.rest.actions.getWorkflowRun = vi.fn().mockRejectedValue(new Error('API error'));
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('failed to fetch workflow run')
    );
    expect(result.triggerNumber).toBeNull();
    expect(result.tokens).toBeUndefined();
  });

  it('warns and returns undefined tokens when artifact download fails', async () => {
    const octokit = makeOctokit({
      artifacts: [{ name: 'agent-tokens', id: 999 }],
    });
    octokit.rest.actions.downloadArtifact = vi.fn().mockRejectedValue(new Error('download error'));
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun(baseArgs);

    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('failed to fetch agent-tokens artifact')
    );
    expect(result.tokens).toBeUndefined();
  });
});
