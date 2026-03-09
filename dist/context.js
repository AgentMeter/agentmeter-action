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
exports.extractContext = extractContext;
exports.mapEventToTriggerType = mapEventToTriggerType;
exports.extractTriggerRef = extractTriggerRef;
const github = __importStar(require("@actions/github"));
/**
 * Extracts the GitHub Actions context for the current workflow run.
 */
function extractContext() {
    const ctx = github.context;
    const { owner, repo } = ctx.repo;
    const repoFullName = `${owner}/${repo}`;
    const eventName = ctx.eventName;
    const payload = ctx.payload;
    const triggerType = mapEventToTriggerType(eventName, payload);
    const { triggerRef, triggerNumber } = extractTriggerRef(eventName, payload);
    return {
        runId: ctx.runId,
        repoFullName,
        owner,
        repo,
        workflowName: ctx.workflow,
        triggerType,
        triggerRef,
        triggerNumber,
    };
}
/**
 * Maps a GitHub event name and payload to an AgentMeter trigger type string.
 */
function mapEventToTriggerType(eventName, payload) {
    if (eventName === 'issues') {
        if (payload.action === 'labeled')
            return 'issue_labeled';
        return 'other';
    }
    if (eventName === 'pull_request') {
        if (payload.action === 'opened')
            return 'pr_opened';
        if (payload.action === 'synchronize')
            return 'pr_synchronize';
        return 'other';
    }
    if (eventName === 'issue_comment' ||
        eventName === 'pull_request_review_comment') {
        return 'pr_comment';
    }
    if (eventName === 'schedule')
        return 'schedule';
    if (eventName === 'workflow_dispatch')
        return 'workflow_dispatch';
    return 'other';
}
/**
 * Extracts the trigger reference (e.g. "#45", "PR #38") and numeric trigger number
 * from the GitHub event payload.
 */
function extractTriggerRef(eventName, payload) {
    if (eventName === 'issues' && payload.issue) {
        return {
            triggerRef: `#${payload.issue.number}`,
            triggerNumber: payload.issue.number,
        };
    }
    if ((eventName === 'pull_request' ||
        eventName === 'pull_request_review_comment') &&
        payload.pull_request) {
        return {
            triggerRef: `PR #${payload.pull_request.number}`,
            triggerNumber: payload.pull_request.number,
        };
    }
    if (eventName === 'issue_comment' && payload.issue) {
        const isPR = !!payload.issue.pull_request;
        return {
            triggerRef: isPR
                ? `PR #${payload.issue.number}`
                : `#${payload.issue.number}`,
            triggerNumber: payload.issue.number,
        };
    }
    return { triggerRef: null, triggerNumber: null };
}
