import * as core from '@actions/core';
import type { IngestPayload, IngestResponse } from './types';

/**
 * Makes a fetch call with one retry on network failure.
 * Does not retry on 4xx/5xx HTTP responses.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
    return fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  }
}

/**
 * Submits run data to the AgentMeter ingest API.
 * Returns the API response or null if the submission fails.
 * Never throws — failures are logged as warnings.
 */
export async function submitRun({
  apiKey,
  apiUrl,
  payload,
}: {
  /** AgentMeter API key */
  apiKey: string;
  /** AgentMeter API base URL */
  apiUrl: string;
  /** Run data to submit */
  payload: IngestPayload;
}): Promise<IngestResponse | null> {
  try {
    const response = await fetchWithRetry(`${apiUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      core.warning(
        `AgentMeter ingest returned ${response.status}: ${body}. Continuing.`,
      );
      return null;
    }

    return (await response.json()) as IngestResponse;
  } catch (error) {
    core.warning(`AgentMeter ingest failed: ${error}. Continuing.`);
    return null;
  }
}
