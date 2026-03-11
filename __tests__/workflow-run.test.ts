import * as core from '@actions/core';
import * as github from '@actions/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkflowRun } from '../src/workflow-run';

vi.mock('@actions/core');
vi.mock('@actions/github');

const mockGetOctokit = vi.mocked(github.getOctokit);

function makeOctokit({
  runData = {},
  artifacts = [],
  artifactZip = null,
}: {
  runData?: Record<string, unknown>;
  artifacts?: Array<{ name: string; id: number }>;
  artifactZip?: ArrayBuffer | null;
}) {
  const defaultRun = {
    run_started_at: '2026-03-09T10:00:00Z',
    updated_at: '2026-03-09T10:05:00Z',
    head_branch: 'feat/my-feature',
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
        listWorkflowRunArtifacts: vi.fn().mockResolvedValue({ data: { artifacts } }),
        downloadArtifact: vi.fn().mockResolvedValue({ data: artifactZip }),
      },
    },
  };
}

/** Creates a minimal zip-like buffer containing the JSON payload */
function makeTokenZip(json: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return encoder.encode(json).buffer as ArrayBuffer;
}

describe('resolveWorkflowRun', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves timestamps from the workflow run', async () => {
    const octokit = makeOctokit({});
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

    expect(result.startedAt).toBe('2026-03-09T10:00:00Z');
    expect(result.completedAt).toBe('2026-03-09T10:05:00Z');
  });

  it('resolves trigger number from pull_requests array', async () => {
    const octokit = makeOctokit({});
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

    expect(result.triggerNumber).toBe(42);
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

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

    expect(result.triggerNumber).toBe(99);
    expect(result.triggerEvent).toBe('issues');
  });

  it('returns null triggerNumber when branch has no issue pattern and no PRs', async () => {
    const octokit = makeOctokit({
      runData: {
        run_started_at: '2026-03-09T10:00:00Z',
        updated_at: '2026-03-09T10:05:00Z',
        head_branch: 'main',
        pull_requests: [],
      },
    });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

    expect(result.triggerNumber).toBeNull();
    expect(result.triggerEvent).toBe('');
  });

  it('returns undefined tokens when no agent-tokens artifact exists', async () => {
    const octokit = makeOctokit({ artifacts: [] });
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

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

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

    expect(result.tokens).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 100,
      isApproximate: false,
    });
  });

  it('warns and returns partial data when workflow run API fails', async () => {
    const octokit = makeOctokit({});
    octokit.rest.actions.getWorkflowRun = vi.fn().mockRejectedValue(new Error('API error'));
    mockGetOctokit.mockReturnValue(octokit as never);

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

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

    const result = await resolveWorkflowRun({
      githubToken: 'token',
      owner: 'adam',
      repo: 'repo',
      workflowRunId: 123,
    });

    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('failed to fetch agent-tokens artifact')
    );
    expect(result.tokens).toBeUndefined();
  });
});
