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
exports.submitRun = submitRun;
const core = __importStar(require("@actions/core"));
/**
 * Makes a fetch call with one retry on network failure.
 * Does not retry on 4xx/5xx HTTP responses.
 */
async function fetchWithRetry(url, options) {
    try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    }
    catch {
        await new Promise((r) => setTimeout(r, 2000));
        return fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    }
}
/**
 * Submits run data to the AgentMeter ingest API.
 * Returns the API response or null if the submission fails.
 * Never throws — failures are logged as warnings.
 */
async function submitRun({ apiKey, apiUrl, payload, }) {
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
            core.warning(`AgentMeter ingest returned ${response.status}: ${body}. Continuing.`);
            return null;
        }
        return (await response.json());
    }
    catch (error) {
        core.warning(`AgentMeter ingest failed: ${error}. Continuing.`);
        return null;
    }
}
