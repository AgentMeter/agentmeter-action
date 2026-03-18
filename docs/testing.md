# Testing the AgentMeter Action

---

## Unit tests

```bash
npm test
```

Watch mode during development:

```bash
npm run test:watch
```

The test suite covers:

- **`token-extractor.test.ts`** — JSON and regex-based token extraction, priority logic, edge cases
- **`context.test.ts`** — GitHub event → trigger type mapping, trigger ref extraction for all event types
- **`comment.test.ts`** — Markdown comment formatting, status emojis, cost formatting, multi-run accumulation, old/new column format compatibility
- **`ingest.test.ts`** — API client success/failure handling, retry logic, Authorization header
- **`workflow-run.test.ts`** — `workflow_run_id` auto-resolution: gate logic, status normalization, trigger number fallback, zip artifact parsing
- **`pricing.test.ts`** — `fetchPricing` success/failure/timeout/malformed-response handling, `getPricing` exact and prefix matching, case insensitivity

---

## Local integration test

To test the full compiled action against a real or mocked AgentMeter API:

### 1. Build the bundle

```bash
npm run build
```

### 2. Set environment variables

Create a test event payload file:

```bash
cat > /tmp/event.json << 'EOF'
{
  "action": "labeled",
  "issue": {
    "number": 1,
    "pull_request": null
  },
  "label": {
    "name": "agent"
  }
}
EOF
```

Export the required env vars:

```bash
export INPUT_API_KEY="am_sk_your_key_here"
export INPUT_MODEL="claude-sonnet-4-5"
export INPUT_STATUS="success"
export INPUT_ENGINE="claude"
export INPUT_POST_COMMENT="false"
export INPUT_API_URL="http://localhost:3000"   # or https://agentmeter.app

export GITHUB_REPOSITORY="yourorg/your-repo"
export GITHUB_RUN_ID="12345678"
export GITHUB_WORKFLOW="agent-implement"
export GITHUB_EVENT_NAME="issues"
export GITHUB_EVENT_PATH="/tmp/event.json"
export GITHUB_TOKEN="your_github_pat"   # only needed if post_comment=true
```

### 3. Run the compiled action

```bash
node dist/index.js
```

### 4. Test with explicit token counts

```bash
export INPUT_INPUT_TOKENS="5000"
export INPUT_OUTPUT_TOKENS="2000"
export INPUT_CACHE_READ_TOKENS="15000"
export INPUT_CACHE_WRITE_TOKENS="3000"
export INPUT_TURNS="12"
node dist/index.js
```

### 5. Test with JSON agent output (auto-extraction)

```bash
export INPUT_AGENT_OUTPUT='{"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200,"cache_creation_input_tokens":100}}'
node dist/index.js
```

---

## Testing against a local AgentMeter API

```bash
export INPUT_API_URL="http://localhost:3000"
export INPUT_API_KEY="am_sk_your_local_key"
node dist/index.js
```

---

## Testing on a PR branch (inline test workflow)

The repo includes `.github/workflows/agentmeter-inline-test.yml` which fires on every `pull_request` event and runs the action directly from the branch code (`uses: ./.`). This is the primary way to test action changes without merging to `main` first.

It uses hardcoded synthetic token counts and a `sleep 10` step so the reported duration is non-zero.

---

## CI

`.github/workflows/ci.yml` runs on every push and PR:

1. `npm run lint` — Biome linting
2. `npm run type-check` — TypeScript strict mode
3. `npm test` — Full test suite

---

## Publishing a new version

1. Ensure all tests pass: `npm test`
2. Run type check: `npm run type-check`
3. Build: `npm run build`
4. Commit everything including `dist/`
5. Push to `main`
6. Create a GitHub release with a semver tag: `v1.0.0`
7. Update the major version tag: `git tag -f v1 && git push -f origin v1`
8. In the GitHub release UI, check "Publish this Action to GitHub Marketplace"

> **Note:** `dist/` must be committed. GitHub Actions checks out the repo at the referenced tag and runs `dist/index.js` directly — it does not run `npm install` or `npm run build`.
