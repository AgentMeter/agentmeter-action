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
exports.run = run;
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const inputs_1 = require("./inputs");
const context_1 = require("./context");
const token_extractor_1 = require("./token-extractor");
const ingest_1 = require("./ingest");
const comment_1 = require("./comment");
/**
 * Core run logic — orchestrates all steps of the AgentMeter Action.
 */
async function run() {
    const startedAt = new Date().toISOString();
    const inputs = (0, inputs_1.parseInputs)();
    const ctx = (0, context_1.extractContext)();
    const tokens = (0, token_extractor_1.resolveTokens)({
        agentOutput: inputs.agentOutput,
        inputTokensOverride: inputs.inputTokens,
        outputTokensOverride: inputs.outputTokens,
        cacheReadTokensOverride: inputs.cacheReadTokens,
        cacheWriteTokensOverride: inputs.cacheWriteTokens,
    });
    const completedAt = new Date().toISOString();
    const durationSeconds = Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000);
    const result = await (0, ingest_1.submitRun)({
        apiKey: inputs.apiKey,
        apiUrl: inputs.apiUrl,
        payload: {
            githubRunId: ctx.runId,
            repoFullName: ctx.repoFullName,
            workflowName: ctx.workflowName,
            triggerType: ctx.triggerType,
            triggerRef: ctx.triggerRef,
            triggerNumber: ctx.triggerNumber,
            engine: inputs.engine,
            model: inputs.model,
            status: inputs.status,
            prNumber: inputs.prNumber,
            durationSeconds,
            turns: inputs.turns,
            startedAt,
            completedAt,
            tokens,
        },
    });
    if (result) {
        core.setOutput('run_id', result.id);
        core.setOutput('total_cost_usd', (result.totalCostCents / 100).toFixed(2));
        core.setOutput('dashboard_url', result.dashboardUrl);
        if (inputs.postComment && ctx.triggerNumber !== null) {
            const githubToken = process.env['GITHUB_TOKEN'] ?? '';
            if (!githubToken) {
                core.warning('AgentMeter: GITHUB_TOKEN not set, skipping comment posting.');
                return;
            }
            const octokit = github.getOctokit(githubToken);
            await (0, comment_1.upsertComment)({
                octokit,
                owner: ctx.owner,
                repo: ctx.repo,
                issueOrPrNumber: ctx.triggerNumber,
                runData: {
                    workflowName: ctx.workflowName,
                    status: inputs.status,
                    totalCostCents: result.totalCostCents,
                    tokens,
                    model: inputs.model,
                    turns: inputs.turns,
                    dashboardUrl: result.dashboardUrl,
                },
            });
        }
    }
}
