#!/usr/bin/env node
/**
 * @fileoverview Independent final reviewer for the audit loop.
 *
 * This script provides an unbiased third-model perspective after Claude (author)
 * and GPT-5.4 (auditor) have converged. It prefers Gemini 3.1 Pro and falls back
 * to Claude Opus when Gemini credentials are unavailable.
 *
 * Usage:
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file>         # Full review
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file> --json   # JSON output
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file> --out <file>  # File output
 *   node scripts/gemini-review.mjs ping                                          # Verify API connectivity
 *
 * Requires: GEMINI_API_KEY or ANTHROPIC_API_KEY in .env or environment
 *
 * @module scripts/gemini-review
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { ProducerFindingSchema, zodToGeminiSchema } from './lib/schemas.mjs';
import { buildClassificationRubric } from './lib/prompt-seeds.mjs';
import { readFileOrDie, readFilesAsContext, extractPlanPaths, writeOutput } from './lib/file-io.mjs';
import { semanticId, formatFindings } from './lib/findings.mjs';
import { readProjectContext, initAuditBrief } from './lib/context.mjs';
import { geminiConfig, claudeConfig } from './lib/config.mjs';
// NOTE: lib/llm-wrappers.mjs provides shared wrappers for learning/refinement/evolution paths.
// This module keeps specialized callGemini/callClaudeOpus with thinkingConfig + abort controller
// because the final review requires high-budget reasoning and precise timeout handling.
// Future: extract shared patterns to llm-wrappers while keeping specialized configs here.

// ── Configuration (from centralized config) ─────────────────────────────────

const MODEL = geminiConfig.model;
const CLAUDE_OPUS_MODEL = claudeConfig.finalReviewModel;
const TIMEOUT_MS = geminiConfig.timeoutMs;
const MAX_OUTPUT_TOKENS = geminiConfig.maxOutputTokens;

// ── Schemas ────────────────────────────────────────────────────────────────────
// FindingSchema + FindingJsonSchema imported from shared.mjs (single source of truth).
// Gemini-specific schemas use explicit JSON Schema — no Zod private API walking.

const WronglyDismissedSchema = z.object({
  original_finding_id: z.string().max(10).describe('The GPT finding ID that was dismissed (e.g. H3, M5)'),
  reason_claude_was_wrong: z.string().max(400).describe('Why Claude should not have dismissed this'),
  recommended_severity: z.enum(['HIGH', 'MEDIUM', 'LOW'])
});

const GeminiFinalReviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),

  deliberation_quality: z.object({
    claude_bias_detected: z.boolean().describe('Did Claude dismiss valid findings to protect its own code?'),
    gpt_false_positive_count: z.number().describe('How many GPT findings were noise or incorrect?'),
    deliberation_was_fair: z.boolean().describe('Was the Claude-GPT deliberation balanced overall?'),
    quality_summary: z.string().max(500).describe('Brief assessment of the deliberation process')
  }),

  new_findings: z.array(ProducerFindingSchema).max(10).describe('Issues neither Claude nor GPT caught. Max 10, only genuinely new.'),

  wrongly_dismissed: z.array(WronglyDismissedSchema).max(10).describe('GPT findings Claude dismissed but were actually valid'),

  over_engineering_flags: z.array(z.string().max(300)).max(10).describe('Places where audit pressure caused unnecessary complexity'),

  architectural_coherence: z.enum(['Strong', 'Adequate', 'Weak']),
  overall_reasoning: z.string().max(1500).describe('Comprehensive final assessment')
});

// Derived from GeminiFinalReviewSchema — single source of truth via Zod → JSON Schema
const GeminiFinalReviewJsonSchema = zodToGeminiSchema(GeminiFinalReviewSchema);

// No verifySchemaSync needed — JSON Schema is derived from Zod, drift is impossible.

// ── System Prompt ──────────────────────────────────────────────────────────────

const REVIEW_SYSTEM = `You are an independent code quality reviewer — the FINAL GATE in a multi-model audit pipeline.

CONTEXT: A software engineer (Claude) wrote code based on a plan. A separate auditor (GPT-5.4) reviewed the code in multiple passes and raised findings. Claude then deliberated on each finding — accepting some, challenging others. GPT ruled on the challenges (sustain/overrule/compromise). The loop repeated until convergence.

YOUR JOB: Review the FULL audit transcript (plan, code, all findings, all deliberations, all rulings) and render an independent verdict. You have NO stake in either model's output.

WHAT TO LOOK FOR:

1. **Claude Bias Detection** — Did Claude dismiss valid GPT findings with motivated reasoning?
   Signs: vague rebuttals ("this is fine"), appeals to authority ("I know this codebase"),
   severity downgrades without evidence, accepting the letter but not spirit of a finding.

2. **GPT False Positives** — Did GPT raise findings that were genuinely wrong?
   Not everything GPT flags is real. Count the noise.

3. **Missed Issues** — What did BOTH models miss? Look for:
   - Security: injection, auth bypass, data leaks, missing input validation
   - Data integrity: race conditions, missing transactions, partial updates
   - Error handling: swallowed errors, missing edge cases
   - Architecture: god functions, tight coupling, leaky abstractions
   - Performance: N+1 queries, unbounded loops, missing pagination

4. **Wrongly Dismissed** — GPT findings that Claude dismissed but were actually valid.
   Check the dismissed/overruled findings especially carefully.

5. **Over-Engineering** — Did the audit pressure cause Claude to add unnecessary complexity?
   Extra abstractions nobody asked for, premature optimisation, defensive code for impossible scenarios.

6. **Architectural Coherence** — Does the final code hang together as a system?
   Cross-file consistency, naming patterns, data flow clarity.

VERDICT GUIDE:
- APPROVE: Code is production-ready. Minor issues at most. Deliberation was fair.
- CONCERNS: Fixable issues found. Nothing blocking, but items need attention before merge.
- REJECT: Significant issues — either missed bugs, clear bias in deliberation, or architectural problems that need human judgment.

RULES:
1. Be ruthlessly honest but fair. Neither model is always right or always wrong.
2. Only raise genuinely NEW findings — do not re-raise what GPT already found (even if phrased differently).
3. Quality over quantity — 3 real findings beat 10 vague ones.
4. Quick-fix detection still applies — flag band-aids.
5. If the deliberation was fair and the code is good, say APPROVE. Don't manufacture issues.
6. If the prompt includes a "Pre-filtered Debt" section, DO NOT re-raise any topic listed there.
   Those concerns are pre-existing, operator-deferred, and tracked outside this audit's scope.
   They were explicitly filtered from the transcript by the upstream pipeline.`;

// ── Gemini API Helper ──────────────────────────────────────────────────────────

/**
 * Make a single Gemini call with structured JSON output.
 * Follows the same {result, usage, latencyMs} contract as callGPT in openai-audit.mjs.
 *
 * @param {GoogleGenAI} ai - GoogleGenAI client instance
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {z.ZodType} opts.zodSchema - Zod schema for response validation
 * @param {object} opts.jsonSchema - Explicit JSON Schema for Gemini's responseSchema
 * @param {string} [opts.passName] - For logging
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function callGemini(ai, { systemPrompt, userPrompt, zodSchema, jsonSchema, passName }) {
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting Gemini ${MODEL} (timeout: ${(TIMEOUT_MS / 1000).toFixed(0)}s)...\n`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: 16384 }
      }
    }, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    // Parse the JSON response
    const text = response.text;
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Failed to parse Gemini JSON response: ${parseErr.message}\nRaw: ${text.slice(0, 500)}`);
    }

    // Validate against Zod schema — reject invalid responses at the trust boundary
    if (zodSchema) {
      const validated = zodSchema.safeParse(result);
      if (validated.success) {
        result = validated.data;
      } else {
        const errMsg = validated.error.message.slice(0, 300);
        process.stderr.write(`  [${passName ?? 'gemini'}] Zod validation FAILED: ${errMsg}\n`);
        throw new Error(`Gemini response failed schema validation: ${errMsg}`);
      }
    }

    const usage = {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      thinking_tokens: response.usageMetadata?.thoughtsTokenCount ?? 0,
      latency_ms: latencyMs
    };

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out / ${usage.thinking_tokens} thinking)\n`);
    }

    return { result, usage, latencyMs };

  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort');
    const msg = isAbort
      ? `[${passName ?? 'gemini'}] Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`
      : `[${passName ?? 'gemini'}] ${err.message} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'gemini'}] FAILED: ${msg}\n`);
    throw new Error(msg);
  }
}

/**
 * Make a single Claude Opus call with JSON output.
 * Uses the same response contract as callGemini.
 *
 * @param {object} anthropic - Anthropic client instance
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {z.ZodType} opts.zodSchema
 * @param {string} [opts.passName]
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function callClaudeOpus(anthropic, { systemPrompt, userPrompt, zodSchema, passName }) {
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting Claude ${CLAUDE_OPUS_MODEL} (timeout: ${(TIMEOUT_MS / 1000).toFixed(0)}s)...\n`);
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`)), TIMEOUT_MS);
  });

  const requestPromise = anthropic.messages.create({
    model: CLAUDE_OPUS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: `${systemPrompt}\n\nOutput strictly valid JSON. No markdown fences.`,
    messages: [{ role: 'user', content: userPrompt }]
  });

  try {
    const response = await Promise.race([requestPromise, timeoutPromise]);
    const latencyMs = Date.now() - startMs;
    const text = response.content?.[0]?.text?.trim() || '{}';

    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Failed to parse Claude JSON response: ${parseErr.message}\nRaw: ${text.slice(0, 500)}`);
    }

    if (zodSchema) {
      const validated = zodSchema.safeParse(result);
      if (validated.success) {
        result = validated.data;
      } else {
        process.stderr.write(`  [${passName ?? 'claude-opus'}] Zod validation warning: ${validated.error.message.slice(0, 200)}\n`);
      }
    }

    const usage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      thinking_tokens: response.usage?.cache_creation_input_tokens ?? 0,
      latency_ms: latencyMs
    };

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }

    return { result, usage, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const msg = `[${passName ?? 'claude-opus'}] ${err.message} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'claude-opus'}] FAILED: ${msg}\n`);
    throw new Error(msg);
  }
}

// ── Review Orchestrator ────────────────────────────────────────────────────────

/**
 * Run the Gemini final review.
 * @param {GoogleGenAI} ai
 * @param {string} planContent
 * @param {string} transcriptContent - JSON string of full audit transcript
 * @param {string} projectContext
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function runFinalReview(provider, client, planContent, transcriptContent, projectContext) {
  // Parse transcript to extract code file paths for direct code inclusion
  let transcript;
  try {
    transcript = JSON.parse(transcriptContent);
  } catch {
    // If not JSON, treat as markdown transcript
    transcript = { raw: transcriptContent };
  }

  // Read code files if paths are listed in transcript
  let codeContext = '';
  if (transcript.code_files && Array.isArray(transcript.code_files)) {
    const { found } = extractPlanPaths(planContent);
    const allFiles = [...new Set([...found, ...transcript.code_files])];
    codeContext = readFilesAsContext(allFiles, { maxPerFile: 8000, maxTotal: 100000 });
  } else {
    // Fall back to extracting from plan
    const { found } = extractPlanPaths(planContent);
    if (found.length > 0) {
      codeContext = readFilesAsContext(found, { maxPerFile: 8000, maxTotal: 100000 });
    }
  }

  // Phase D.4: extract debt-suppression context from transcript envelope.
  // When the upstream audit already filtered debt, tell the reviewer so they
  // don't re-surface the same topics.
  const suppressionContext = transcript._debtMemory?.suppressionContext
    || transcript.debt_memory?.suppressionContext
    || [];
  let debtBlock = '';
  if (Array.isArray(suppressionContext) && suppressionContext.length > 0) {
    const lines = suppressionContext.slice(0, 50).map(s =>
      `- [${s.topicId}] ${s.category} (${s.section}) — ${s.deferredReason}`
    );
    debtBlock = [
      '## Pre-filtered Debt (already suppressed this round — DO NOT resurface)',
      `The following ${suppressionContext.length} topics were matched against the repo's`,
      'persistent debt ledger and filtered from the transcript above. They are',
      'pre-existing concerns explicitly deferred by the operator. If you see new',
      'findings in your review that match any of these topics, EXCLUDE them —',
      'the pipeline already handled them.',
      '',
      ...lines,
      '',
    ].join('\n');
  }

  const userPrompt = [
    '## Project Context',
    projectContext,
    '',
    '---',
    '',
    '## Plan',
    planContent,
    '',
    '---',
    '',
    '## Audit Transcript (Claude-GPT Deliberation)',
    typeof transcript === 'object' && transcript.raw
      ? transcript.raw
      : JSON.stringify(transcript, null, 2),
    '',
    '---',
    '',
    debtBlock,
    debtBlock ? '---' : '',
    debtBlock ? '' : '',
    '## Code Files',
    codeContext || '(No code files found — review based on transcript only)',
  ].filter(Boolean).join('\n');

  const selectedModel = provider === 'gemini' ? MODEL : CLAUDE_OPUS_MODEL;
  const providerLabel = provider === 'gemini' ? 'Gemini' : 'Claude Opus';
  process.stderr.write(`\n── ${providerLabel} Final Review ──\n`);
  process.stderr.write(`  Model: ${selectedModel}\n`);
  process.stderr.write(`  Context: ~${(userPrompt.length / 4).toFixed(0)} tokens (estimated)\n`);

  // Append classification rubric so new_findings populate the required envelope.
  const classificationBlock = buildClassificationRubric({
    sourceKind: 'REVIEWER',
    sourceName: selectedModel
  });
  const systemPrompt = REVIEW_SYSTEM + classificationBlock;

  if (provider === 'gemini') {
    return callGemini(client, {
      systemPrompt,
      userPrompt,
      zodSchema: GeminiFinalReviewSchema,
      jsonSchema: GeminiFinalReviewJsonSchema,
      passName: 'gemini-review'
    });
  }

  return callClaudeOpus(client, {
    systemPrompt,
    userPrompt,
    zodSchema: GeminiFinalReviewSchema,
    passName: 'claude-opus-review'
  });
}

// ── Output Formatting ──────────────────────────────────────────────────────────

function formatReviewResult(result, usage, latencyMs, provider) {
  const lines = [];
  const selectedModel = provider === 'gemini' ? MODEL : CLAUDE_OPUS_MODEL;
  const title = provider === 'gemini'
    ? 'Gemini 3.1 Pro — Independent Final Review'
    : 'Claude Opus — Independent Final Review';
  lines.push(`# ${title}`);
  lines.push(`- **Model**: ${selectedModel} | **Latency**: ${(latencyMs / 1000).toFixed(1)}s`);
  lines.push(`- **Tokens**: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.thinking_tokens} thinking)`);
  lines.push('');

  // Verdict
  const icon = result.verdict === 'APPROVE' ? '✅' : result.verdict === 'CONCERNS' ? '⚠️' : '❌';
  lines.push(`## Verdict: ${icon} **${result.verdict}**`);
  lines.push('');

  // Deliberation quality
  const dq = result.deliberation_quality;
  lines.push('## Deliberation Quality');
  lines.push(`- **Claude bias detected**: ${dq.claude_bias_detected ? 'YES' : 'No'}`);
  lines.push(`- **GPT false positives**: ${dq.gpt_false_positive_count}`);
  lines.push(`- **Deliberation fair**: ${dq.deliberation_was_fair ? 'Yes' : 'NO'}`);
  lines.push(`- **Summary**: ${dq.quality_summary}`);
  lines.push('');

  // Architectural coherence
  lines.push(`## Architectural Coherence: **${result.architectural_coherence}**`);
  lines.push('');

  // Wrongly dismissed
  if (result.wrongly_dismissed?.length > 0) {
    lines.push('## Wrongly Dismissed Findings');
    lines.push('');
    for (const wd of result.wrongly_dismissed) {
      lines.push(`### [${wd.original_finding_id}] → Should be ${wd.recommended_severity}`);
      lines.push(`- **Why**: ${wd.reason_claude_was_wrong}`);
      lines.push('');
    }
  }

  // New findings
  if (result.new_findings?.length > 0) {
    lines.push('## New Findings (missed by both models)');
    lines.push(formatFindings(result.new_findings));
  }

  // Over-engineering
  if (result.over_engineering_flags?.length > 0) {
    lines.push('## Over-Engineering Flags');
    lines.push('');
    for (const flag of result.over_engineering_flags) {
      lines.push(`- ${flag}`);
    }
    lines.push('');
  }

  // Overall reasoning
  lines.push('## Overall Assessment');
  lines.push('');
  lines.push(result.overall_reasoning);

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  // Ping mode — quick connectivity test
  if (mode === 'ping') {
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: 'Reply with exactly: Gemini ready'
        });
        console.log(`✓ ${MODEL}: ${response.text.trim()}`);
        process.exit(0);
      } catch (err) {
        console.error(`✗ ${MODEL}: ${err.message}`);
        process.exit(1);
      }
    }

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: CLAUDE_OPUS_MODEL,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Reply with exactly: Claude ready' }]
        });
        const text = response.content?.[0]?.text?.trim() || '';
        console.log(`✓ ${CLAUDE_OPUS_MODEL}: ${text}`);
        process.exit(0);
      } catch (err) {
        console.error(`✗ ${CLAUDE_OPUS_MODEL}: ${err.message}`);
        process.exit(1);
      }
    }

    console.error('Error: set GEMINI_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // Review mode
  const planFile = args[1];
  const transcriptFile = args[2];
  const jsonMode = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

  if (mode !== 'review' || !planFile || !transcriptFile) {
    console.error('Usage: node scripts/gemini-review.mjs review <plan-file> <transcript-file> [--json] [--out <file>]');
    console.error('       node scripts/gemini-review.mjs ping');
    process.exit(1);
  }

  let provider = null;
  if (process.env.GEMINI_API_KEY) {
    provider = 'gemini';
  } else if (process.env.ANTHROPIC_API_KEY) {
    provider = 'claude-opus';
  }
  if (!provider) {
    console.error('Error: Final review requires GEMINI_API_KEY or ANTHROPIC_API_KEY');
    console.error('Set GEMINI_API_KEY for Gemini, or ANTHROPIC_API_KEY for Claude Opus fallback.');
    process.exit(1);
  }

  const planContent = readFileOrDie(planFile);
  const transcriptContent = readFileOrDie(transcriptFile);
  await initAuditBrief(); // Pre-generate context brief
  const projectContext = readProjectContext();
  let client;
  if (provider === 'gemini') {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    process.stderr.write(`  [final-review] GEMINI_API_KEY missing; using Claude Opus fallback (${CLAUDE_OPUS_MODEL}).\n`);
  }

  try {
    const { result, usage, latencyMs } = await runFinalReview(provider, client, planContent, transcriptContent, projectContext);

    // Phase D.4 defense-in-depth: re-suppress Gemini new_findings that match
    // pre-filtered debt topics, even if the reviewer ignored our warning.
    // Fuzzy match on category+section+detail against the transcript envelope.
    try {
      const transcriptObj = JSON.parse(transcriptContent);
      const suppressionCtx = transcriptObj._debtMemory?.suppressionContext
        || transcriptObj.debt_memory?.suppressionContext
        || [];
      if (Array.isArray(suppressionCtx) && suppressionCtx.length > 0 && Array.isArray(result.new_findings)) {
        const { jaccardSimilarity } = await import('./lib/ledger.mjs');
        // Threshold 0.30 (slightly lower than suppressReRaises' 0.35) because
        // debt envelope signatures are short (category+section) while Gemini's
        // new_findings include long detail text — asymmetric signature lengths
        // dilute Jaccard. 0.30 captures real matches without over-suppressing.
        const THRESHOLD = 0.30;
        const before = result.new_findings.length;
        const kept = [];
        const debtSuppressed = [];
        for (const f of result.new_findings) {
          const fSig = `${f.category} ${f.section} ${f.detail}`;
          let match = null;
          let bestScore = 0;
          for (const d of suppressionCtx) {
            const dSig = `${d.category} ${d.section}`;
            const score = jaccardSimilarity(fSig, dSig);
            if (score > bestScore) { bestScore = score; match = d; }
          }
          if (match && bestScore > THRESHOLD) {
            debtSuppressed.push({ finding: f, matchedTopic: match.topicId, score: bestScore });
          } else {
            kept.push(f);
          }
        }
        if (debtSuppressed.length > 0) {
          process.stderr.write(`  [final-review] Debt re-suppression: ${debtSuppressed.length}/${before} new_findings matched pre-filtered debt\n`);
          for (const s of debtSuppressed.slice(0, 3)) {
            process.stderr.write(`    [debt-suppressed] ${s.matchedTopic.slice(0, 8)} score=${s.score.toFixed(2)}\n`);
          }
          result.new_findings = kept;
          result._debtSuppressedCount = debtSuppressed.length;
        }
      }
    } catch { /* transcript not JSON or no _debtMemory — skip */ }

    // Add semantic hashes to new findings for cross-model tracking
    if (result.new_findings) {
      for (let i = 0; i < result.new_findings.length; i++) {
        const f = result.new_findings[i];
        f.id = `${provider === 'gemini' ? 'G' : 'C'}${i + 1}`;
        f._hash = semanticId(f);
        f._source = provider;
      }
    }

    if (jsonMode || outFile) {
      const selectedModel = provider === 'gemini' ? MODEL : CLAUDE_OPUS_MODEL;
      const data = { ...result, _model: selectedModel, _provider: provider, _usage: usage };
      if (outFile) {
        const newCount = result.new_findings?.length ?? 0;
        const dismissedCount = result.wrongly_dismissed?.length ?? 0;
        const summaryLine = `Verdict: ${result.verdict} | New: ${newCount} | Wrongly dismissed: ${dismissedCount} | ${(latencyMs / 1000).toFixed(0)}s`;
        writeOutput(data, outFile, summaryLine);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    } else {
      console.log(formatReviewResult(result, usage, latencyMs, provider));
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
