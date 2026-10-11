import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { buildUserAgent } from '../src/user-agent';
import { ACTION_VERSION } from '../src/version';

describe('ACTION_VERSION', () => {
  it('matches package.json', () => {
    expect(ACTION_VERSION).toBe(pkg.version);
  });
});

describe('buildUserAgent', () => {
  it('includes the pinned ref when present', () => {
    expect(buildUserAgent({ ref: 'v1' })).toBe(`agentmeter-action/${ACTION_VERSION} (ref v1)`);
  });

  it('omits the ref when the action runs from a local checkout', () => {
    expect(buildUserAgent({ ref: '' })).toBe(`agentmeter-action/${ACTION_VERSION}`);
    expect(buildUserAgent({})).toBe(`agentmeter-action/${ACTION_VERSION}`);
  });
});
