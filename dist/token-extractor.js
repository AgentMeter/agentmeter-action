"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTokensFromOutput = extractTokensFromOutput;
exports.resolveTokens = resolveTokens;
/**
 * Attempts to extract token counts from agent stdout.
 * Tries JSON parsing first, then falls back to regex extraction.
 * Returns null if no token data can be found.
 */
function extractTokensFromOutput(agentOutput) {
    if (!agentOutput)
        return null;
    const jsonResult = tryExtractFromJson(agentOutput);
    if (jsonResult)
        return jsonResult;
    return tryExtractFromText(agentOutput);
}
/**
 * Tries to parse agent output as JSON and extract usage data.
 */
function tryExtractFromJson(agentOutput) {
    try {
        const parsed = JSON.parse(agentOutput);
        const usage = parsed.usage ?? parsed.result?.usage;
        if (!usage)
            return null;
        return {
            tokens: {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            },
            isApproximate: false,
        };
    }
    catch {
        return null;
    }
}
/**
 * Tries to extract token counts from plain-text agent output using regex.
 * Marks extracted data as approximate since regex is not precise.
 */
function tryExtractFromText(agentOutput) {
    const inputMatch = agentOutput.match(/input[_\s]tokens?:\s*(\d+)/i);
    const outputMatch = agentOutput.match(/output[_\s]tokens?:\s*(\d+)/i);
    if (!inputMatch && !outputMatch)
        return null;
    return {
        tokens: {
            inputTokens: inputMatch ? parseInt(inputMatch[1] ?? '0', 10) : 0,
            outputTokens: outputMatch ? parseInt(outputMatch[1] ?? '0', 10) : 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        },
        isApproximate: true,
    };
}
/**
 * Resolves the final token counts to use, following priority order:
 * 1. Explicit inputs (input_tokens / output_tokens)
 * 2. Extracted from agent_output JSON
 * 3. Extracted from agent_output text (approximate)
 * 4. Undefined (no data)
 */
function resolveTokens({ agentOutput, inputTokensOverride, outputTokensOverride, cacheReadTokensOverride, cacheWriteTokensOverride, }) {
    if (inputTokensOverride !== null) {
        return {
            inputTokens: inputTokensOverride,
            outputTokens: outputTokensOverride ?? 0,
            cacheReadTokens: cacheReadTokensOverride ?? 0,
            cacheWriteTokens: cacheWriteTokensOverride ?? 0,
            isApproximate: false,
        };
    }
    if (agentOutput) {
        const extracted = extractTokensFromOutput(agentOutput);
        if (extracted) {
            return { ...extracted.tokens, isApproximate: extracted.isApproximate };
        }
    }
    return undefined;
}
