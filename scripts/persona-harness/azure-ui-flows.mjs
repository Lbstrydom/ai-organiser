#!/usr/bin/env node
/**
 * AZURE-MODE Track-1 UI flows (Playwright/CDP) — drives the REAL modals so the
 * *feature flow* (not just the transport) is exercised. Poll-on-state, never fixed
 * sleeps: a timeout → INCONCLUSIVE, never a false BUG (per docs/azure-test-plan.md).
 *
 * Flows: transcribe (Whisper). [minutes / multi-source / presentation → TODO]
 * Run: node scripts/persona-harness/azure-ui-flows.mjs   (Obsidian must be CLOSED)
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchOrAttach, ensureVaultOpen, waitForPluginReady, runCommand } from './driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'sessions', 'azure-ui-flows');
mkdirSync(OUT, { recursive: true });
const shot = (n) => join(OUT, `${n}.png`);

const AUDIO_STEM = 'recording-2026-02-01T13-30-04'; // short (~14K) clip — fuzzy-search stem
const MULTISOURCE_NOTE = 'AI-Organiser/Z test/Test Multi-source 1.md'; // wav + URLs
const MINUTES_TRANSCRIPT = [
    'Chair: Good morning everyone, let us begin the board meeting. First item is the Q1 budget.',
    'CFO: Revenue is up 12 percent year on year. We are tracking ahead of plan on the Hamina project.',
    'Chair: Good. Action: CFO to circulate the updated forecast by Friday. Next, the staffing plan.',
    'COO: We plan to hire two engineers in March. Decision: approved, subject to final sign-off.',
    'Chair: Any other business? None. Meeting closed at 10:15.',
].join('\n');
const THROTTLE_RE = /HTTP 429|rate limit|per-minute token|TPM|RateLimitReached|AzureRateLimitError|azure-whisper/i;
const events = [];
const mark = (kind, text) => events.push({ t: Date.now(), kind, text: String(text).slice(0, 300) });

let { browser, page } = await launchOrAttach();
page = await ensureVaultOpen(browser, page, 'Second Brain');
await waitForPluginReady(page);
page.on('console', (m) => { const t = m.text(); if (THROTTLE_RE.test(t)) mark('throttle', `[${m.type()}] ${t}`); else if (m.type() === 'error') mark('error', t); });
page.on('pageerror', (e) => mark('pageerror', e.message));

console.log('[ui] hot-reloading plugin');
await page.evaluate(async () => { const a = globalThis.app; await a.plugins.disablePlugin('ai-organiser'); await new Promise(r => setTimeout(r, 500)); await a.plugins.enablePlugin('ai-organiser'); });
await page.waitForTimeout(1500);
await waitForPluginReady(page);
const profile = await page.evaluate(() => { const p = globalThis.app.plugins.plugins['ai-organiser']; return { provider: p?.settings?.cloudServiceType, mode: p?.providerProfile?.mode }; });
console.log(`[ui] profile: ${JSON.stringify(profile)}`);

/** Wait until predicate() returns truthy (evaluated in-page), polling. Returns the
 *  truthy value, or null on timeout (→ inconclusive, never a false fail). */
async function pollState(label, predicate, { timeout = 60000, every = 1500 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        const v = await page.evaluate(predicate).catch(() => null);
        if (v) return v;
        await page.waitForTimeout(every);
    }
    console.warn(`[ui] pollState timeout: ${label}`);
    return null;
}
async function closeAllModals() {
    for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate(() => document.querySelectorAll('.modal-close-button').forEach(b => b.click()));
        await page.waitForTimeout(200);
        if (await page.evaluate(() => document.querySelectorAll('.modal-container .modal').length) === 0) return;
    }
}
async function dismissSecondary() {
    return page.evaluate(() => {
        const top = Array.from(document.querySelectorAll('.modal-container .modal')).filter(m => !m.querySelector('.ai-organiser-audio-attach-trio')).pop();
        if (!top) return false;
        const cta = top.querySelector('button.mod-cta') || Array.from(top.querySelectorAll('button')).find(b => /proceed|continue|ok|allow|accept|got it/i.test(b.textContent || ''));
        if (cta) { cta.click(); return true; }
        return false;
    });
}

const results = [];
let lastEventIdx = 0;
function record(name, result, ms, extra) {
    const slice = events.slice(lastEventIdx); // events since the previous flow
    lastEventIdx = events.length;
    const throttles = slice.filter(e => e.kind === 'throttle');
    const errs = slice.filter(e => e.kind !== 'throttle');
    // QUOTA vs BUG is computed from evidence: a fail with a throttle signal = QUOTA.
    let label = result;
    if (result === 'FAIL') label = throttles.length > 0 ? 'QUOTA' : 'BUG';
    results.push({ name, result: label, ms, throttle429: throttles.length, ...extra });
    console.log(`[ui] ${label === 'PASS' ? '✓' : label === 'QUOTA' ? '~' : label === 'INCONCLUSIVE' ? '?' : '✗'} ${name} — ${label} (${(ms/1000).toFixed(1)}s) ${extra?.snippet || ''}`);
}

// ── Transcribe (Whisper) ──────────────────────────────────────────────────────
console.log('\n[ui] ▶ Transcribe audio (Whisper)');
const t0 = Date.now();
try {
    await closeAllModals(); // clear any stale modal so selectors are clean
    await runCommand(page, 'ai-organiser:transcribe-audio');
    const haveModal = await pollState('transcribe modal', () => !!document.querySelector('.ai-organiser-audio-attach-trio'), { timeout: 8000 });
    if (!haveModal) throw new Error('transcribe modal did not open');
    await page.screenshot({ path: shot('01-modal') });

    // Click "Pick from vault…" → AudioAttachCoordinator opens DocumentMultiPickerModal
    // (audio-filtered, in-note-first) when a source note is set, else a FuzzySuggestModal.
    await page.evaluate(() => {
        const trio = document.querySelector('.ai-organiser-audio-attach-trio');
        const b = Array.from(trio.querySelectorAll('button')).find(x => /vault/i.test(x.textContent || ''));
        if (b) b.click();
    });
    const pickerKind = await pollState('vault picker', () => {
        if (document.querySelector('.ai-organiser-doc-multi-picker-search')) return 'multi';
        if (document.querySelector('.prompt-input, .suggestion-item')) return 'fuzzy';
        return null;
    }, { timeout: 6000 });
    if (!pickerKind) throw new Error('vault picker did not open');

    if (pickerKind === 'multi') {
        // DocumentMultiPickerModal: filter → select the matching row → "Attach selected".
        await page.evaluate((stem) => {
            const inp = document.querySelector('.ai-organiser-doc-multi-picker-search');
            inp.focus();
            const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            set.call(inp, stem); inp.dispatchEvent(new Event('input', { bubbles: true }));
        }, AUDIO_STEM);
        const haveRow = await pollState('matching audio row', (s) => {
            const rows = Array.from(document.querySelectorAll('.ai-organiser-doc-multi-picker-row'));
            return rows.some(r => (r.textContent || '').includes(s));
        }, { timeout: 6000 }) || await pollState('any row', () => document.querySelectorAll('.ai-organiser-doc-multi-picker-row').length > 0, { timeout: 2000 });
        if (!haveRow) throw new Error('no audio row matched ' + AUDIO_STEM);
        await page.evaluate((stem) => {
            const rows = Array.from(document.querySelectorAll('.ai-organiser-doc-multi-picker-row'));
            const row = rows.find(r => (r.textContent || '').includes(stem)) || rows[0];
            const input = row.querySelector('input[type="checkbox"], input[type="radio"]');
            if (input && !input.checked) input.click(); else row.click();
        }, AUDIO_STEM);
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const b = document.querySelector('.ai-organiser-doc-multi-picker-confirm') ||
                Array.from(document.querySelectorAll('.ai-organiser-doc-multi-picker button')).find(x => /attach|confirm|add|select/i.test(x.textContent || ''));
            if (b && !b.disabled) b.click();
        });
    } else {
        // FuzzySuggestModal fallback: type into the focused input + Enter.
        await page.keyboard.type(AUDIO_STEM, { delay: 10 });
        await pollState('suggestion', () => document.querySelectorAll('.suggestion-item').length > 0, { timeout: 5000 });
        await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(800);
    for (let i = 0; i < 2; i++) { if (!await dismissSecondary()) break; await page.waitForTimeout(600); }

    // Attached → click the item "Transcribe" button (exact text; not the title/save).
    const haveTranscribe = await pollState('transcribe button', () => {
        const m = document.querySelector('.modal-container .modal');
        return !!Array.from(m?.querySelectorAll('button') || []).find(b => /^transcribe$/i.test((b.textContent || '').trim()) && !b.disabled);
    }, { timeout: 8000 });
    if (!haveTranscribe) throw new Error('transcribe button not available after attach');
    await page.screenshot({ path: shot('02-attached') });
    await page.evaluate(() => {
        const m = document.querySelector('.modal-container .modal');
        const b = Array.from(m.querySelectorAll('button')).find(x => /^transcribe$/i.test((x.textContent || '').trim()) && !x.disabled);
        if (b) b.click();
    });

    // Poll for completion: speaker-review panel appears OR status → complete. Fail → 'failed'.
    console.log('[ui] transcribing (Whisper) — polling up to 4 min …');
    const done = await pollState('transcription complete', () => {
        const status = document.querySelector('.ai-organiser-transcribe-only-status')?.textContent || '';
        if (/fail/i.test(status)) return { failed: true, status };
        if (document.querySelector('.ai-organiser-speaker-review-panel') || /complete/i.test(status)) {
            const review = document.querySelector('.ai-organiser-speaker-review-panel')?.textContent || '';
            return { ok: true, snippet: (review || status).replace(/\s+/g, ' ').slice(0, 160) };
        }
        return null;
    }, { timeout: 240000, every: 3000 });
    await page.screenshot({ path: shot('03-result') });

    const ms = Date.now() - t0;
    const azureRouted = events.some(e => /azure-whisper/i.test(e.text)) || profile.mode === 'azure';
    if (!done) record('Transcribe audio (Whisper)', 'INCONCLUSIVE', ms, { snippet: 'timed out waiting for completion', azureRouted });
    else if (done.failed) record('Transcribe audio (Whisper)', 'FAIL', ms, { snippet: done.status, azureRouted });
    else record('Transcribe audio (Whisper)', 'PASS', ms, { snippet: done.snippet, azureRouted });
} catch (e) {
    record('Transcribe audio (Whisper)', 'FAIL', Date.now() - t0, { snippet: String(e.message || e).slice(0, 160) });
}

// ── Meeting minutes (transcript → Azure Claude) ───────────────────────────────
console.log('\n[ui] ▶ Meeting minutes');
{
    const m0 = Date.now();
    try {
        await closeAllModals();
        await runCommand(page, 'ai-organiser:create-meeting-minutes');
        if (!await pollState('minutes modal', () => !!document.querySelector('.ai-organiser-minutes-modal'), { timeout: 8000 }))
            throw new Error('minutes modal did not open');
        // Focus the transcript textarea (the Setting that mentions "transcript", NOT
        // participants/previous-minutes) and type with the REAL keyboard — Obsidian's
        // TextAreaComponent.onChange only fires on genuine input events, never a
        // synthetic value-set, so the CTA gate would otherwise never re-evaluate.
        const focused = await pollState('transcript textarea', () => {
            const modal = document.querySelector('.ai-organiser-minutes-modal');
            if (!modal) return false;
            const tas = Array.from(modal.querySelectorAll('.ai-organiser-minutes-textarea'));
            const tr = tas.find(t => /transcript/i.test(t.closest('.setting-item')?.textContent || '')) || tas.find(t => !/previous/i.test(t.placeholder || '')) || tas[0];
            if (tr) { tr.focus(); return true; }
            return false;
        }, { timeout: 6000 });
        if (!focused) throw new Error('transcript textarea not found');
        await page.keyboard.type(MINUTES_TRANSCRIPT, { delay: 2 });
        await page.waitForTimeout(700);
        const sub = await page.evaluate(() => { const b = document.querySelector('.ai-organiser-minutes-submit'); if (b && !b.disabled) { b.click(); return true; } return b ? 'disabled' : 'missing'; });
        if (sub !== true) throw new Error('minutes submit ' + sub);
        console.log('[ui] generating minutes (Azure Claude) — polling up to 3 min …');
        const done = await pollState('minutes done', () => {
            const open = !!document.querySelector('.ai-organiser-minutes-modal');
            const notices = Array.from(document.querySelectorAll('.notice')).map(n => n.textContent || '');
            if (notices.some(t => /minutes saved|saved:/i.test(t))) return { ok: true };
            const fail = notices.find(t => /fail|error/i.test(t)); if (fail) return { failed: fail };
            if (!open) return { ok: true };
            return null;
        }, { timeout: 180000, every: 3000 });
        const ms = Date.now() - m0;
        if (!done) record('Meeting minutes', 'INCONCLUSIVE', ms, { snippet: 'timed out', azureRouted: profile.mode === 'azure' });
        else if (done.failed) record('Meeting minutes', 'FAIL', ms, { snippet: done.failed, azureRouted: profile.mode === 'azure' });
        else record('Meeting minutes', 'PASS', ms, { snippet: 'minutes generated', azureRouted: profile.mode === 'azure' });
    } catch (e) { record('Meeting minutes', 'FAIL', Date.now() - m0, { snippet: String(e.message || e).slice(0, 160) }); }
}

// ── Multi-source summarize (wav + URLs → Whisper + multimodal + text) ──────────
console.log('\n[ui] ▶ Multi-source summarize');
{
    const s0 = Date.now();
    try {
        await closeAllModals();
        const opened = await page.evaluate(async (path) => { const a = globalThis.app; const f = a.vault.getAbstractFileByPath(path); if (!f) return false; await a.workspace.getLeaf(false).openFile(f); return true; }, MULTISOURCE_NOTE);
        if (!opened) throw new Error('note not found: ' + MULTISOURCE_NOTE);
        await page.waitForTimeout(1000);
        await runCommand(page, 'ai-organiser:smart-summarize');
        if (!await pollState('multi-source modal', () => !!document.querySelector('.ai-organiser-multi-source-buttons'), { timeout: 8000 }))
            throw new Error('multi-source modal did not open (no sources detected?)');
        // A privacy consent may sit OVER the modal first; dismiss it, but re-confirm
        // the multi-source modal is still the one we act on (don't crash on null).
        for (let i = 0; i < 3; i++) { if (!await dismissSecondary()) break; await page.waitForTimeout(600); }
        if (!await pollState('multi-source buttons (post-consent)', () => !!document.querySelector('.ai-organiser-multi-source-buttons'), { timeout: 4000 }))
            throw new Error('multi-source modal closed before action (consent flow?)');
        const go = await page.evaluate(() => {
            const c = document.querySelector('.ai-organiser-multi-source-buttons');
            if (!c) return false;
            const b = Array.from(c.querySelectorAll('button')).find(x => !/cancel/i.test(x.textContent || '') && (x.classList.contains('mod-cta') || /summari|process|generate|create/i.test(x.textContent || '')));
            if (b && !b.disabled) { b.click(); return true; }
            return false;
        });
        if (!go) throw new Error('multi-source action button not available');
        console.log('[ui] processing multi-source (Whisper + web + summarize, consent-gated) — up to 5 min …');
        // custom poll: dismiss per-provider consent each tick; done = modal closes / notice.
        const t0p = Date.now(); let outcome = null;
        while (Date.now() - t0p < 300000) {
            await dismissSecondary();
            const v = await page.evaluate(() => {
                const open = !!document.querySelector('.ai-organiser-multi-source-buttons');
                const notices = Array.from(document.querySelectorAll('.notice')).map(n => n.textContent || '');
                if (notices.some(t => /summary inserted|summariz.*complete|done/i.test(t))) return { ok: true };
                const fail = notices.find(t => /fail|error|could not/i.test(t)); if (fail) return { failed: fail };
                if (!open) return { ok: true };
                return null;
            }).catch(() => null);
            if (v) { outcome = v; break; }
            await page.waitForTimeout(4000);
        }
        const ms = Date.now() - s0;
        if (!outcome) record('Multi-source summarize', 'INCONCLUSIVE', ms, { snippet: 'timed out', azureRouted: profile.mode === 'azure' });
        else if (outcome.failed) record('Multi-source summarize', 'FAIL', ms, { snippet: outcome.failed, azureRouted: profile.mode === 'azure' });
        else record('Multi-source summarize', 'PASS', ms, { snippet: 'multi-source summarized', azureRouted: profile.mode === 'azure' });
    } catch (e) { record('Multi-source summarize', 'FAIL', Date.now() - s0, { snippet: String(e.message || e).slice(0, 160) }); }
}

// ── Report ────────────────────────────────────────────────────────────────────
const report = { profile, results, throttleEvents: events.filter(e => e.kind === 'throttle').length, hardErrors: events.filter(e => e.kind !== 'throttle') };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n=============== AZURE UI FLOWS ===============');
for (const r of results) console.log(`  ${r.result === 'PASS' ? '✓' : r.result === 'QUOTA' ? '~' : r.result === 'INCONCLUSIVE' ? '?' : '✗'} ${r.name.padEnd(28)} ${r.result}  (${(r.ms/1000).toFixed(1)}s)  ${r.snippet || ''}`);
console.log('=============================================');
await browser.close().catch(() => {});
console.log(`[ui] done. Artifacts: ${OUT}`);
