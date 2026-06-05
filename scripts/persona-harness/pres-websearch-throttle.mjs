#!/usr/bin/env node
/**
 * LIVE Electron/CDP test: make a slide deck WITH a web-search source, against the
 * real Azure-mode vault, and prove it completes WITHOUT throttling (429/TPM/RPM)
 * or other errors. Saves the deck HTML + the exported PPTX for comparison.
 *
 * Run: node scripts/persona-harness/pres-websearch-throttle.mjs
 *   (Obsidian must be CLOSED first — single-instance lock.)
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchOrAttach, ensureVaultOpen, waitForPluginReady, runCommand } from './driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'sessions', 'pres-websearch-throttle');
mkdirSync(OUT, { recursive: true });
const shot = (n) => join(OUT, `${n}.png`);

const WEB_QUERY = 'latest 2024-2025 global coffee production volumes, top producing countries, and arabica price trends';
const PROMPT = 'Create a 7-slide executive deck on the global coffee economy using the attached web research: a title slide, market scale with four key numbers, top producing countries with their production shares, the farm-to-cup value chain, recent price volatility, and a closing takeaway.';

// ── Throttle / error monitoring ──────────────────────────────────────────────
const THROTTLE_RE = /rate.?limit|429|too many requests|TPM|tokens per minute|per-minute token|throttl|quota|web-search-rate-limited/i;
const events = []; // {t, kind, text}
const mark = (kind, text) => { events.push({ t: Date.now(), kind, text: String(text).slice(0, 300) }); };

let { browser, page } = await launchOrAttach();
page = await ensureVaultOpen(browser, page, 'Second Brain');
await waitForPluginReady(page);

// Capture console + page errors (the [Cache]/[rate-limit] debug lines + any throws).
page.on('console', (msg) => {
    const txt = msg.text();
    if (THROTTLE_RE.test(txt)) mark('console-throttle', `[${msg.type()}] ${txt}`);
    if (msg.type() === 'error') mark('console-error', txt);
});
page.on('pageerror', (err) => mark('pageerror', err.message));

console.log('[ws] hot-reloading plugin (pick up the freshly deployed main.js)');
await page.evaluate(async () => {
    const app = globalThis.app;
    await app.plugins.disablePlugin('ai-organiser');
    await new Promise(r => setTimeout(r, 500));
    await app.plugins.enablePlugin('ai-organiser');
});
await page.waitForTimeout(1500);
await waitForPluginReady(page);

// Confirm the runtime provider profile is Azure (so this run actually exercises pacing).
const profile = await page.evaluate(() => {
    const p = globalThis.app.plugins.plugins['ai-organiser'];
    return {
        cloudServiceType: p?.settings?.cloudServiceType,
        azureMaxRpm: p?.settings?.azureMaxRpm,
        azureMaxConcurrentRequests: p?.settings?.azureMaxConcurrentRequests,
        researchProvider: p?.settings?.researchProvider,
        providerMode: p?.providerProfile?.mode,
    };
});
console.log(`[ws] runtime profile: ${JSON.stringify(profile)}`);

async function closeAll() {
    for (let i = 0; i < 6; i++) {
        const closed = await page.evaluate(() => {
            const btn = document.querySelector('.modal-container .modal .modal-close-button');
            if (btn) { btn.click(); return true; }
            return false;
        });
        if (!closed) await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        const rem = await page.$$eval('.modal-container .modal', els => els.length).catch(() => 0);
        if (rem === 0) return;
    }
}
async function clearNotices() {
    // Scan visible Notices for throttle text, then dismiss them.
    const texts = await page.evaluate(() => Array.from(document.querySelectorAll('.notice')).map(n => n.textContent || ''));
    for (const tx of texts) if (THROTTLE_RE.test(tx)) mark('notice-throttle', tx);
}
async function dismissSecondaryModals() {
    // Privacy consent / project prompts that appear over the chat modal.
    return page.evaluate(() => {
        const top = Array.from(document.querySelectorAll('.modal-container .modal'))
            .filter(m => !m.classList.contains('ai-organiser-chat-modal')).pop();
        if (!top) return false;
        const cta = top.querySelector('button.mod-cta')
            || Array.from(top.querySelectorAll('button')).find(b => /proceed|continue|ok|allow|accept|create|got it/i.test(b.textContent || ''));
        if (cta) { cta.click(); return true; }
        return false;
    });
}

await closeAll();

console.log('[ws] opening presentation chat');
await runCommand(page, 'ai-organiser:presentation-chat');
await page.waitForSelector('.ai-organiser-resume-picker-modal, .modal-container .modal.ai-organiser-chat-modal', { timeout: 8000 });
await page.waitForTimeout(1200);

// New presentation
await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.ai-organiser-resume-action-row'));
    const t = rows.find(r => /new presentation/i.test(r.textContent || '')) || rows.find(r => /new conversation/i.test(r.textContent || ''));
    if (t) t.click();
});
await page.waitForTimeout(2500);
await page.screenshot({ path: shot('01-slides-mode') });

// Dismiss any cached-deck / privacy modal so the Create panel is interactable
for (let i = 0; i < 3; i++) { if (!await dismissSecondaryModals()) break; await page.waitForTimeout(800); }
await page.evaluate(() => {
    const modal = document.querySelector('.modal-container .modal.ai-organiser-chat-modal');
    const disc = Array.from(modal?.querySelectorAll('button') || []).find(b => /^discard$/i.test((b.textContent || '').trim()));
    if (disc && !disc.disabled) disc.click();
});
await page.waitForTimeout(1000);

// ── Add a WEB-SEARCH source ──────────────────────────────────────────────────
console.log('[ws] adding web-search source');
const addClicked = await page.evaluate(() => {
    const actions = document.querySelector('.ai-organiser-pres-create-sources-actions');
    const btn = Array.from(actions?.querySelectorAll('button') || []).find(b => /web search/i.test(b.textContent || ''));
    if (btn) { btn.click(); return true; }
    return false;
});
console.log(`[ws] "+ add web search" clicked: ${addClicked}`);
await page.waitForSelector('input.ai-organiser-pres-web-source-input', { timeout: 6000 });
await page.evaluate((q) => {
    const inp = document.querySelector('input.ai-organiser-pres-web-source-input');
    inp.focus(); inp.value = q; inp.dispatchEvent(new Event('input', { bubbles: true }));
}, WEB_QUERY);
await page.waitForTimeout(300);
await page.evaluate(() => {
    const inp = document.querySelector('input.ai-organiser-pres-web-source-input');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(1500);
// A privacy consent for web search may appear — accept it.
for (let i = 0; i < 3; i++) { if (!await dismissSecondaryModals()) break; await page.waitForTimeout(800); }
await page.screenshot({ path: shot('02-web-source-added') });

// Wait for BOTH sources to resolve (no ⏳ pending; the web-search 429+backoff can
// take ~40s) so the Create panel stops re-rendering before we type the prompt.
console.log('[ws] waiting for sources to resolve (web-search may back off ~37s on a 429)');
for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => {
        const list = document.querySelector('.ai-organiser-pres-create-sources-list');
        const txt = list ? list.textContent : '';
        return { pending: /⏳/.test(txt), txt: txt.replace(/\s+/g, ' ').trim().slice(0, 260) };
    });
    if (i === 0 || !s.pending) console.log(`[ws] sources: pending=${s.pending} "${s.txt}"`);
    await dismissSecondaryModals();
    await clearNotices();
    if (!s.pending) break;
    await page.waitForTimeout(3000);
}

// ── Type the deck prompt (robust native-setter + read-back) + click SEND ──────
console.log('[ws] typing + sending deck prompt');
const typed = await page.evaluate((p) => {
    const modal = document.querySelector('.modal-container .modal.ai-organiser-chat-modal');
    const ta = modal?.querySelector('textarea[placeholder*="resentation"], textarea');
    if (!ta) return { ok: false, why: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, p);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: ta.value === p, len: ta.value.length };
}, PROMPT);
console.log(`[ws] prompt typed: ${JSON.stringify(typed)}`);
await page.waitForTimeout(400);
const sent = await page.evaluate(() => {
    const modal = document.querySelector('.modal-container .modal.ai-organiser-chat-modal');
    // The send CTA is the arrow-up button in the input row (mod-cta).
    const rows = modal?.querySelectorAll('.ai-organiser-chat-input-row, .ai-organiser-chat-composer, .modal') || [];
    let btn = modal?.querySelector('button.mod-cta svg.lucide-arrow-up')?.closest('button');
    if (!btn) btn = Array.from(modal?.querySelectorAll('button.mod-cta') || []).find(b => b.querySelector('svg'));
    if (btn && !btn.disabled) { btn.click(); return true; }
    // Fallback: Enter on the textarea.
    const ta = modal?.querySelector('textarea');
    if (ta) { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); return 'enter'; }
    return false;
});
console.log(`[ws] send action: ${sent}`);
await page.waitForTimeout(2000);

console.log('[ws] generating (web-search + deck, up to 6 min) — watching for throttle');
const started = Date.now();
let stable = 0, lastLen = 0;
while (Date.now() - started < 360000) {
    const s = await page.evaluate(() => {
        const modal = document.querySelector('.modal-container .modal.ai-organiser-chat-modal');
        const iframe = modal?.querySelector('.ai-organiser-pres-preview-container iframe');
        const srcdoc = iframe ? (iframe.srcdoc || iframe.getAttribute('srcdoc') || '') : '';
        const thinking = !!modal?.querySelector('.ai-organiser-chat-thinking');
        const secondary = Array.from(document.querySelectorAll('.modal-container .modal')).filter(m => !m.classList.contains('ai-organiser-chat-modal')).length;
        // any web-search source failure chip?
        const srcText = (document.querySelector('.ai-organiser-pres-create-sources-list')?.textContent || '');
        return { len: srcdoc.length, thinking, secondary, srcText: srcText.replace(/\s+/g, ' ').slice(0, 200) };
    });
    if (s.secondary > 0) { await dismissSecondaryModals(); await page.waitForTimeout(700); }
    await clearNotices();
    const t = Math.round((Date.now() - started) / 1000);
    if (s.len !== lastLen) console.log(`[ws t+${t}s] srcdoc=${s.len} thinking=${s.thinking} src="${s.srcText}"`);
    if (s.len > 1000 && !s.thinking) {
        if (s.len === lastLen) { stable++; if (stable >= 2) { console.log(`[ws] done at t+${t}s`); break; } } else stable = 0;
    }
    lastLen = s.len;
    await page.waitForTimeout(4000);
}
await page.screenshot({ path: shot('03-generated') });

// ── Verify + save HTML ───────────────────────────────────────────────────────
const verify = await page.evaluate(() => {
    const iframe = document.querySelector('.ai-organiser-pres-preview-container iframe');
    const srcdoc = iframe ? (iframe.srcdoc || '') : '';
    const doc = iframe?.contentDocument;
    return { slideCount: doc ? doc.querySelectorAll('.slide').length : 0, srcdocLen: srcdoc.length, isIr: /width:\s?1920px/.test(srcdoc) };
});
const deckHtml = await page.evaluate(() => {
    const iframe = document.querySelector('.ai-organiser-pres-preview-container iframe');
    return iframe ? (iframe.srcdoc || '') : '';
});
if (deckHtml) writeFileSync(join(OUT, 'deck.html'), deckHtml);
console.log(`[ws] verify: ${JSON.stringify(verify)} | deck.html saved=${!!deckHtml}`);

// ── Export PPTX (capture the buffer) ─────────────────────────────────────────
await page.evaluate(() => {
    window.__pptxB64 = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
        try { blob.arrayBuffer().then(buf => { let b = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) b += String.fromCharCode(u[i]); window.__pptxB64 = btoa(b); }); } catch (e) {}
        return orig(blob);
    };
});
const exportClicked = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.modal-container .modal.ai-organiser-chat-modal button')).find(b => /export.*pptx/i.test(b.textContent || ''));
    if (t && !t.disabled) { t.click(); return true; }
    return false;
});
console.log(`[ws] export PPTX clicked: ${exportClicked}`);
let b64 = null;
for (let i = 0; i < 30; i++) { b64 = await page.evaluate(() => window.__pptxB64); if (b64) break; await page.waitForTimeout(1000); }
if (b64) { writeFileSync(join(OUT, 'export.pptx'), Buffer.from(b64, 'base64')); console.log(`[ws] CAPTURED PPTX → ${join(OUT, 'export.pptx')} (${Buffer.from(b64, 'base64').length} bytes)`); }
else console.error('[ws] FAILED to capture PPTX buffer');
await page.screenshot({ path: shot('04-after-export') });

// Final notice sweep
await clearNotices();

// ── Report ───────────────────────────────────────────────────────────────────
const throttleEvents = events.filter(e => /throttle/.test(e.kind));
const errorEvents = events.filter(e => /error/.test(e.kind) || e.kind === 'pageerror');
const report = {
    profile,
    slideCount: verify.slideCount,
    deckHtmlBytes: deckHtml.length,
    pptxCaptured: !!b64,
    throttleEvents,
    errorEvents,
    verdict: throttleEvents.length === 0 && verify.slideCount >= 5 ? 'PASS — slides + web search, no throttling' : 'REVIEW',
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n========== REPORT ==========');
console.log(JSON.stringify(report, null, 2));
console.log('============================');

await browser.close().catch(() => {});
console.log(`[ws] done. Artifacts: ${OUT}`);
