# Testing the AgentMeter Action

This document covers how to test the action locally and in CI before publishing.

---

## Unit tests

Run all unit tests with:

```bash
npm test
```

Run in watch mode during development:

```bash
npm run test:watch
```

The test suite covers:

- **`token-extractor.test.ts`** — JSON and regex-based token extraction, priority logic, edge cases
- **`context.test.ts`** — GitHub event → trigger type mapping, trigger ref extraction for all event types
- **`comment.test.ts`** — Markdown comment formatting, status emojis, cost formatting, multi-run accumulation
- **`ingest.test.ts`** — API client success/failure handling, retry logic, Authorization header

---

## Local integration test

To test the full compiled action against a real or mocked AgentMeter API:

### 1. Build the bundle

```bash
npm run build
```

This compiles TypeScript to `dist/` then bundles with `ncc` into `dist/index.js`.

### 2. Set environment variables

Create a test event payload file first:

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

Then export the required env vars:

```bash
export INPUT_API_KEY="am_sk_your_key_here"
export INPUT_MODEL="claude-sonnet-4-5"
export INPUT_STATUS="success"
export INPUT_ENGINE="claude"
export INPUT_POST_COMMENT="false"        # disable comment posting for local tests
export INPUT_API_URL="https://agentmeter.app"   # or your local API URL

# GitHub Actions context variables
export GITHUB_REPOSITORY="yourorg/your-repo"
export GITHUB_RUN_ID="12345678"
export GITHUB_WORKFLOW="agent-implement"
export GITHUB_EVENT_NAME="issues"
export GITHUB_EVENT_PATH="/tmp/event.json"
export GITHUB_TOKEN="your_github_pat"    # optional, only needed if post_comment=true
```

### 3. Run the compiled action

```bash
node dist/index.js
```

You should see output like:

```
::set-output name=run_id::clx1abc...
::set-output name=total_cost_usd::0.00
::set-output name=dashboard_url::https://agentmeter.app/dashboard/runs/clx1abc...
```

### 4. Test with token data

To test token extraction from JSON output:

```bash
export INPUT_AGENT_OUTPUT='{"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200,"cache_creation_input_tokens":100}}'
node dist/index.js
```

Or with explicit token counts:

```bash
export INPUT_INPUT_TOKENS="5000"
export INPUT_OUTPUT_TOKENS="2000"
export INPUT_CACHE_READ_TOKENS="15000"
export INPUT_CACHE_WRITE_TOKENS="3000"
export INPUT_TURNS="12"
node dist/index.js
```

---

## Testing against a local AgentMeter API

If you have the AgentMeter web app running locally:

```bash
export INPUT_API_URL="http://localhost:3000"
export INPUT_API_KEY="am_sk_your_local_key"
node dist/index.js
```

The action will POST to `http://localhost:3000/api/ingest`.

---

## Testing comment posting

To test that the comment posts correctly to a real GitHub issue or PR:

1. Set `INPUT_POST_COMMENT="true"`
2. Set `GITHUB_TOKEN` to a PAT with `issues:write` permission on the target repo
3. Set `GITHUB_EVENT_NAME` to `issues` and ensure the event payload has a real issue number
4. Run `node dist/index.js`

Check the GitHub issue for the posted comment.

---

## CI

The CI workflow (`.github/workflows/ci.yml`) runs on every push and PR:

1. `npm run lint` — Biome linting
2. `npm run type-check` — TypeScript strict mode check
3. `npm test` — Full test suite

The build workflow (`.github/workflows/build.yml`) runs on pushes to `main`:

1. Builds the dist bundle
2. Auto-commits any changes to `dist/` (required for the action to work when referenced via `uses: foo-software/agentmeter-action@v1`)

---

## Publishing a new version

1. Ensure all tests pass: `npm test`
2. Run type check: `npm run type-check`
3. Build the bundle: `npm run build`
4. Commit everything including `dist/`
5. Push to `main`
6. Create a GitHub release with a semver tag: `v1.0.0`
7. Also update the major version tag: `git tag -f v1 && git push -f origin v1`
8. In the GitHub release UI, check "Publish this Action to GitHub Marketplace"

> **Note:** The `dist/` directory must be committed to the repository. GitHub Actions checks out the repo at the referenced tag and runs `dist/index.js` directly — it does not run `npm install` or `npm run build`.
