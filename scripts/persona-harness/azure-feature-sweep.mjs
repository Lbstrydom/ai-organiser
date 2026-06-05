#!/usr/bin/env node
/**
 * AZURE-MODE feature sweep against the real Obsidian Electron app (Playwright CDP).
 * Exercises each feature's ACTUAL Azure egress path in the live runtime with real
 * vault materials, and reports a pass/fail matrix that separates "code works" from
 * "TPM-quota limited" (the IT item). Skips Gemini-only paths (YouTube).
 *
 * Run: node scripts/persona-harness/azure-feature-sweep.mjs
 *   (Obsidian must be CLOSED first — single-instance lock.)
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchOrAttach, ensureVaultOpen, waitForPluginReady } from './driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'sessions', 'azure-feature-sweep');
mkdirSync(OUT, { recursive: true });

// Vault-relative material paths.
const M = {
    note: 'AI-Organiser/Z test/Test Note Raw text.md',
    pdf: '99 File Storage/Design Thinking - Cognitive Biases.pdf',
    image: '99 File Storage/Pasted image 20260317115637.png',
};

const THROTTLE_RE = /HTTP 429|rate limit of|per-minute token|TPM|tokens per minute|web-search-rate-limited|AzureRateLimitError/i;
const events = [];
const mark = (kind, text) => events.push({ t: Date.now(), kind, text: String(text).slice(0, 280) });

let { browser, page } = await launchOrAttach();
page = await ensureVaultOpen(browser, page, 'Second Brain');
await waitForPluginReady(page);

page.on('console', (msg) => {
    const txt = msg.text();
    if (THROTTLE_RE.test(txt)) mark('throttle', `[${msg.type()}] ${txt}`);
    else if (msg.type() === 'error') mark('console-error', txt);
});
page.on('pageerror', (e) => mark('pageerror', e.message));

console.log('[sweep] hot-reloading plugin (latest main.js)');
await page.evaluate(async () => {
    const app = globalThis.app;
    await app.plugins.disablePlugin('ai-organiser');
    await new Promise(r => setTimeout(r, 500));
    await app.plugins.enablePlugin('ai-organiser');
});
await page.waitForTimeout(1500);
await waitForPluginReady(page);

const profile = await page.evaluate(() => {
    const p = globalThis.app.plugins.plugins['ai-organiser'];
    return { provider: p?.settings?.cloudServiceType, mode: p?.providerProfile?.mode, rpm: p?.settings?.azureMaxRpm, conc: p?.settings?.azureMaxConcurrentRequests };
});
console.log(`[sweep] profile: ${JSON.stringify(profile)}`);
if (profile.mode !== 'azure') console.warn('[sweep] WARNING: not in Azure mode — results will not reflect Azure routing');

// Helper installed in the page: read text / binary-as-base64 from the vault.
await page.evaluate(() => {
    window.__sweep = {
        async readText(path) {
            const f = globalThis.app.vault.getAbstractFileByPath(path);
            if (!f) throw new Error('missing: ' + path);
            return globalThis.app.vault.read(f);
        },
        async readB64(path) {
            const f = globalThis.app.vault.getAbstractFileByPath(path);
            if (!f) throw new Error('missing: ' + path);
            const buf = await globalThis.app.vault.readBinary(f);
            const bytes = new Uint8Array(buf);
            let bin = ''; const CH = 0x8000;
            for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            return btoa(bin);
        },
    };
});

const results = [];
async function feature(name, evalFn, arg) {
    const before = events.length;
    const t0 = Date.now();
    console.log(`\n[sweep] ▶ ${name}`);
    let r;
    try { r = await page.evaluate(evalFn, arg); }
    catch (e) { r = { ok: false, error: String(e).slice(0, 200) }; }
    const ms = Date.now() - t0;
    const throttles = events.slice(before).filter(e => e.kind === 'throttle');
    const errs = events.slice(before).filter(e => e.kind !== 'throttle');
    const rec = { name, ok: !!r.ok, ms, throttle429: throttles.length, snippet: (r.snippet || r.error || '').slice(0, 160), errorEvents: errs.length };
    results.push(rec);
    console.log(`[sweep]   ${rec.ok ? '✓ PASS' : '✗ FAIL'} (${(ms / 1000).toFixed(1)}s, ${throttles.length} 429-retries) — ${rec.snippet}`);
    // brief pause so back-to-back calls don't gratuitously stack within one TPM minute
    await page.waitForTimeout(11000);
    return rec;
}

// ── 1. Summarize a note (text → Azure Claude / summarizeText) ─────────────────
await feature('Summarize note (text)', async (path) => {
    const content = (await window.__sweep.readText(path)).slice(0, 6000);
    const p = globalThis.app.plugins.plugins['ai-organiser'];
    const r = await p.llmService.summarizeText(`Summarize the following note in 4 concise bullet points:\n\n${content}`);
    return { ok: !!r.success && (r.content || '').length > 40, snippet: (r.content || r.error || '').replace(/\s+/g, ' ').slice(0, 160) };
}, M.note);

// ── 2. Tags (Azure Claude / analyzeTags) ──────────────────────────────────────
await feature('Generate tags', async (path) => {
    const content = (await window.__sweep.readText(path)).slice(0, 6000);
    const p = globalThis.app.plugins.plugins['ai-organiser'];
    const r = await p.llmService.analyzeTags(content, [], 'mixed', 8, 'en');
    const tags = r.suggestedTags || [];
    return { ok: tags.length > 0, snippet: 'tags: ' + tags.slice(0, 8).join(', ') };
}, M.note);

// ── 3. Ingest a PDF (multimodal → Azure Claude / sendMultimodal — newly paced) ─
await feature('Ingest PDF (multimodal)', async (path) => {
    const b64 = await window.__sweep.readB64(path);
    const p = globalThis.app.plugins.plugins['ai-organiser'];
    const r = await p.llmService.sendMultimodal(
        [{ type: 'document', mediaType: 'application/pdf', data: b64 }, { type: 'text', text: 'Summarize this PDF in 3 bullet points.' }],
        { maxTokens: 1024 });
    return { ok: !!r.success && (r.content || '').length > 40, snippet: (r.content || r.error || '').replace(/\s+/g, ' ').slice(0, 160) };
}, M.pdf);

// ── 4. Digitise an image (multimodal → Azure Claude / sendMultimodal) ──────────
// Resize first (longest edge → 1024px, JPEG) to mirror the real feature, which
// downsizes via ImageProcessorService before sending — the raw full-res image is
// far more vision tokens than production ever sends.
await feature('Digitise image (multimodal)', async (path) => {
    const app = globalThis.app, p = app.plugins.plugins['ai-organiser'];
    const f = app.vault.getAbstractFileByPath(path);
    if (!f) throw new Error('missing: ' + path);
    const buf = await app.vault.readBinary(f);
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const maxDim = 1024, scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const b64 = c.toDataURL('image/jpeg', 0.8).split(',')[1];
    const r = await p.llmService.sendMultimodal(
        [{ type: 'image', mediaType: 'image/jpeg', data: b64 }, { type: 'text', text: 'Describe this image and transcribe any visible text.' }],
        { maxTokens: 1024 });
    return { ok: !!r.success && (r.content || '').length > 30, snippet: (r.content || r.error || '').replace(/\s+/g, ' ').slice(0, 160) };
}, M.image);

// ── 5. Mermaid diagram (Azure Claude / summarizeText) ─────────────────────────
await feature('Mermaid diagram', async () => {
    const p = globalThis.app.plugins.plugins['ai-organiser'];
    const r = await p.llmService.summarizeText('Generate ONLY a valid Mermaid flowchart (inside a ```mermaid code fence) for a simple order-to-delivery process: order placed → payment → fulfilment → shipping → delivered.');
    const ok = !!r.success && /```mermaid|graph |flowchart /i.test(r.content || '');
    return { ok, snippet: (r.content || r.error || '').replace(/\s+/g, ' ').slice(0, 160) };
});

// ── 6. Translate (Azure Claude / summarizeText) ───────────────────────────────
await feature('Translate (note → French)', async (path) => {
    const content = (await window.__sweep.readText(path)).slice(0, 1500);
    const p = globalThis.app.plugins.plugins['ai-organiser'];
    const r = await p.llmService.summarizeText(`Translate the following into French. Output only the translation:\n\n${content}`);
    return { ok: !!r.success && (r.content || '').length > 40, snippet: (r.content || r.error || '').replace(/\s+/g, ' ').slice(0, 160) };
}, M.note);

await page.screenshot({ path: join(OUT, 'final.png') }).catch(() => {});

// ── Report ────────────────────────────────────────────────────────────────────
const pass = results.filter(r => r.ok).length;
const report = {
    profile,
    summary: `${pass}/${results.length} features passed in Azure mode`,
    results,
    totalThrottle429Retries: events.filter(e => e.kind === 'throttle').length,
    hardErrors: events.filter(e => e.kind !== 'throttle'),
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n================ AZURE FEATURE SWEEP ================');
console.log(`profile: ${JSON.stringify(profile)}`);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s  429-retries=${r.throttle429}  ${r.ok ? '' : '→ ' + r.snippet}`);
console.log(`  ─── ${pass}/${results.length} passed · ${report.totalThrottle429Retries} total 429-retries (handled) · ${report.hardErrors.length} hard errors`);
console.log('====================================================');

await browser.close().catch(() => {});
console.log(`[sweep] done. Artifacts: ${OUT}`);
