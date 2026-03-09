"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseInputs = parseInputs;
const core = __importStar(require("@actions/core"));
/**
 * Parses and validates all GitHub Action inputs.
 * Returns a typed ActionInputs object.
 */
function parseInputs() {
    const apiKey = core.getInput('api_key', { required: true });
    const engine = core.getInput('engine') || 'claude';
    const modelRaw = core.getInput('model');
    const agentOutput = core.getInput('agent_output');
    const inputTokensRaw = core.getInput('input_tokens');
    const outputTokensRaw = core.getInput('output_tokens');
    const cacheReadTokensRaw = core.getInput('cache_read_tokens');
    const cacheWriteTokensRaw = core.getInput('cache_write_tokens');
    const turnsRaw = core.getInput('turns');
    const status = core.getInput('status') || 'success';
    const prNumberRaw = core.getInput('pr_number');
    const apiUrl = core.getInput('api_url') || 'https://agentmeter.app';
    const postCommentRaw = core.getInput('post_comment');
    return {
        apiKey,
        engine,
        model: modelRaw || null,
        agentOutput,
        inputTokens: parseIntOrNull(inputTokensRaw),
        outputTokens: parseIntOrNull(outputTokensRaw),
        cacheReadTokens: parseIntOrNull(cacheReadTokensRaw),
        cacheWriteTokens: parseIntOrNull(cacheWriteTokensRaw),
        turns: parseIntOrNull(turnsRaw),
        status,
        prNumber: parseIntOrNull(prNumberRaw),
        apiUrl,
        postComment: postCommentRaw.toLowerCase() !== 'false',
    };
}
/**
 * Parses a string to an integer, returning null for empty/invalid values.
 */
function parseIntOrNull(value) {
    if (!value || value.trim() === '')
        return null;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}
