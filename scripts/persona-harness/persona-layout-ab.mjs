#!/usr/bin/env node
/**
 * LAYOUT RADAR (Track 2/3 of docs/azure-test-plan.md). Renders a generated
 * artifact's layout and runs a STRUCTURAL LLM-judge (yes/no questions, robust to
 * LLM content nondeterminism) to flag substantive layout flaws — the bar-chart-
 * collapse / stripped-border class. Supports a gated baseline (--bless).
 *
 * Modes:
 *   node persona-layout-ab.mjs --deck <deck.html> [--label NAME]   # judge a rendered deck
 *   node persona-layout-ab.mjs --persona pat                       # generate + judge (TODO wire)
 *   ... --bless                                                    # promote PASS renders → baseline/
 *
 * The judge uses OpenAI vision (key from .env / ~/.audit-loop.env) — an INDEPENDENT
 * grader, not the system under test.
 */
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(__dirname, 'baseline');
const OUT = join(__dirname, 'sessions', 'persona-layout-ab');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const BLESS = args.includes('--bless');
const DECK = argVal('--deck');
const PERSONA = argVal('--persona');
const LABEL = argVal('--label') || (PERSONA ? `persona-${PERSONA}` : (DECK ? basename(dirname(DECK)) + '-' + basename(DECK, '.html') : 'deck'));

// Each persona drives a realistic, LAYOUT-HEAVY deck (charts + tables + tiles +
// flows) so the radar's structural checks have something to bite on.
const PERSONAS = [
    { id: 'pat', label: 'Pat — director', prompt: 'Create a 6-slide executive board briefing on Q3 performance: a title slide; a market-scale slide with four key metric tiles; a bar chart of revenue by region (five regions with clearly different values); the go-to-market plan as a left-to-right process flow; key risks in a two-column layout; and a closing takeaway slide.' },
    { id: 'chen', label: 'Dr. Chen — researcher', prompt: 'Create a 6-slide research summary on transformer attention mechanisms: a title slide; the core problem; a comparison table of three approaches (RNN, CNN, self-attention) across three criteria; a labelled diagram of the architecture; key benchmark results as a bar chart; and a conclusions slide.' },
    { id: 'maya', label: 'Maya — student', prompt: 'Create a 6-slide study deck on the three stages of memory (sensory, short-term, long-term): a title slide; an overview of the three stages as a process flow; a comparison table of capacity and duration; key terms as cards; a bar chart comparing the durations; and a summary slide.' },
];

function readKey(name) {
    for (const f of ['.env', `${process.env.USERPROFILE || process.env.HOME}/.audit-loop.env`]) {
        try { const line = readFileSync(f, 'utf8').split('\n').find(l => l.startsWith(`${name}=`)); const v = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, ''); if (v) return v; } catch { /* next */ }
    }
    return process.env[name];
}

// Structural questions — yes/no, reproducible across LLM content variation. A 'no'
// on a CRITICAL question is a substantive LAYOUT flaw.
const QUESTIONS = [
    { id: 'chart_ok', critical: true, q: 'For any bar/column chart on the slide: do the BARS THEMSELVES have visibly different LENGTHS (the coloured rectangles), proportional to their values? Judge ONLY the physical bar length — IGNORE the colour shade and IGNORE the number labels. A chart where every bar is the SAME length (a narrow stub) is BROKEN even if the bars are different colours or show different numbers — answer "no". Answer "yes" only if the bar lengths clearly differ (e.g. a 95% bar is much longer than an 11% bar). Answer "yes" if there is no chart.' },
    { id: 'no_clipping', critical: true, q: 'Is all text fully visible within the slide, with nothing cut off or clipped at the edges?' },
    { id: 'borders_ok', critical: true, q: 'If the slide has cards, stat tiles, boxes, or a table, do they have visible borders or clear visual separation? Answer "yes" if none are present.' },
    { id: 'has_heading', critical: false, q: 'Does the slide have a clear, legible heading or title (except an intentional closing/quote slide)?' },
    { id: 'balanced', critical: false, q: 'Is the content reasonably balanced — not all crammed into one corner, not overflowing the slide?' },
];

// ── Independent vision judge ──────────────────────────────────────────────────
// Auto-pick a vision model from a DIFFERENT family than the plugin's main LLM, so
// the grader is independent of the system under test. Main=Claude → GPT/Gemini;
// main=GPT → Claude/Gemini; main=Gemini → GPT/Claude. Azure (anthropic family) →
// GPT/Gemini if an independent key exists, else any available (lean on geometry).
// Overridable: --judge-provider <openai|gemini|claude>, --judge-model <id>.
function readMainProvider() {
    const candidates = [
        'C:/obsidian/Second Brain/.obsidian/plugins/ai-organiser/data.json',
        join(process.env.USERPROFILE || process.env.HOME || '', 'obsidian', 'Second Brain', '.obsidian', 'plugins', 'ai-organiser', 'data.json'),
    ];
    for (const p of candidates) { try { const d = JSON.parse(readFileSync(p, 'utf8')); if (d.cloudServiceType) return d.cloudServiceType; } catch { /* next */ } }
    return null;
}
function providerFamily(p) {
    if (!p) return 'unknown';
    if (/claude|anthropic/i.test(p)) return 'anthropic';
    if (/openai|gpt/i.test(p)) return 'openai';
    if (/gemini|google/i.test(p)) return 'google';
    return 'unknown';
}
async function judgeOpenAI(b64, prompt, model) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readKey('OPENAI_API_KEY')}` }, body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }] }) });
    const j = await res.json(); if (j.error) throw new Error(j.error.message);
    return j.choices?.[0]?.message?.content || '';
}
async function judgeGemini(b64, prompt, model) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${readKey('GEMINI_API_KEY')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/png', data: b64 } }] }], generationConfig: { temperature: 0 } }) });
    const j = await res.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}
async function judgeClaude(b64, prompt, model) {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': readKey('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }] }] }) });
    const j = await res.json(); if (j.error) throw new Error(j.error.message);
    return j.content?.map(c => c.text || '').join('') || '';
}
// Live judge: route through the RUNNING plugin's sendMultimodal — i.e. the main
// LLM (Azure Opus 4.6 in Azure mode, whose key lives in SecretStorage and isn't
// reachable standalone). NOT independent of the system under test, but the most
// capable option when no independent .env key exists. Verified: Azure Opus 4.6
// correctly distinguishes collapsed vs scaling bars (better than gpt-4o here).
// Opt-in via --judge-provider live.
let _live = null;
async function getLivePage() {
    if (_live) return _live;
    const drv = await import('./driver.mjs');
    let { browser, page } = await drv.launchOrAttach();
    page = await drv.ensureVaultOpen(browser, page, 'Second Brain');
    await drv.waitForPluginReady(page);
    // Hot-reload so the live page picks up the freshly deployed main.js.
    await page.evaluate(async () => { const a = globalThis.app; await a.plugins.disablePlugin('ai-organiser'); await new Promise(r => setTimeout(r, 500)); await a.plugins.enablePlugin('ai-organiser'); });
    await page.waitForTimeout(1500);
    await drv.waitForPluginReady(page);
    _live = { browser, page };
    return _live;
}
async function judgeLive(b64, prompt) {
    const { page } = await getLivePage();
    return page.evaluate(async ({ img, p }) => {
        const plugin = globalThis.app.plugins.plugins['ai-organiser'];
        const res = await plugin.llmService.sendMultimodal([{ type: 'image', mediaType: 'image/png', data: img }, { type: 'text', text: p }], { maxTokens: 512 });
        return res.success ? (res.content || '') : ('judge-error: ' + (res.error || ''));
    }, { img: b64, p: prompt });
}
// SSOT for the per-family vision-judge model — ONE place to bump when the frontier
// moves (plan M4/M9 — no per-call literal; the radar was pinned to legacy 'gpt-4o').
// Override any single run with RADAR_JUDGE_MODEL or --judge-model.
const LATEST_BY_FAMILY = {
    openai: process.env.RADAR_JUDGE_MODEL || 'gpt-5.3',           // latest omni (was the legacy gpt-4o)
    gemini: process.env.RADAR_JUDGE_MODEL || 'gemini-flash-latest',
    anthropic: process.env.RADAR_JUDGE_MODEL || 'claude-opus-4-6',
};
const VISION_JUDGES = {
    openai: { family: 'openai', model: LATEST_BY_FAMILY.openai, keyEnv: 'OPENAI_API_KEY', call: judgeOpenAI },
    gemini: { family: 'google', model: LATEST_BY_FAMILY.gemini, keyEnv: 'GEMINI_API_KEY', call: judgeGemini },
    claude: { family: 'anthropic', model: LATEST_BY_FAMILY.anthropic, keyEnv: 'ANTHROPIC_API_KEY', call: judgeClaude },
    live: { family: 'live', model: 'main-LLM (Azure Opus 4.6 in Azure mode)', keyEnv: null, call: (b64, prompt) => judgeLive(b64, prompt) },
};
function resolveJudge() {
    const main = readMainProvider();
    const mainFam = providerFamily(main);
    const override = argVal('--judge-provider');
    const modelOverride = argVal('--judge-model');
    const mk = (id, reason) => ({ id, ...VISION_JUDGES[id], model: modelOverride || VISION_JUDGES[id].model, main, mainFam, reason });
    if (override && VISION_JUDGES[override]) return mk(override, 'cli override');
    for (const id of Object.keys(VISION_JUDGES)) if (VISION_JUDGES[id].family !== mainFam && readKey(VISION_JUDGES[id].keyEnv)) return mk(id, `independent of main family '${mainFam}' (main=${main})`);
    for (const id of Object.keys(VISION_JUDGES)) if (readKey(VISION_JUDGES[id].keyEnv)) return mk(id, `NOT independent (only '${id}' key available; geometry gate carries) — main=${main}`);
    return null; // deterministic-only
}
const JUDGE = resolveJudge();

async function judgeSlide(pngBuf) {
    if (!JUDGE) return { answers: {}, notes: 'no vision-judge key available — geometry-only' };
    const b64 = pngBuf.toString('base64');
    const prompt = 'You are a strict slide-LAYOUT inspector. Look ONLY at layout/rendering, NOT wording or taste. Answer each question with "yes" or "no" and a 6-word reason. Return ONLY JSON: {"answers":{"' + QUESTIONS.map(q => q.id).join('":"...","') + '":"..."},"notes":"..."}\n\n' + QUESTIONS.map((q, i) => `${i + 1}. [${q.id}] ${q.q}`).join('\n');
    let txt = '';
    try { txt = await JUDGE.call(b64, prompt, JUDGE.model); } catch (e) { return { answers: {}, notes: 'judge-error: ' + String(e.message || e).slice(0, 120) }; }
    const m = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    try { return JSON.parse(m); } catch { return { answers: {}, notes: 'parse-failed: ' + txt.slice(0, 120) }; }
}

// Deterministic DOM-geometry checks — reproducible, robust to LLM nondeterminism,
// reliable where the vision judge is not (the bar-chart-collapse class).
const GEOMETRY_FN = `(slideEl) => {
    const flaws = [];
    const labels = Array.from(slideEl.querySelectorAll('*')).filter(e => e.children.length === 0 && /^\\d{1,3}%$/.test((e.textContent||'').trim()));
    if (labels.length >= 3) {
        const data = labels.map(l => { const val = parseInt((l.textContent||'').trim(), 10); let bar = l; for (let i=0;i<4 && bar.parentElement;i++){ bar = bar.parentElement; const bg = getComputedStyle(bar).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)' && !/255,\\s*255,\\s*255/.test(bg)) break; } return { val, w: bar.offsetWidth }; });
        const vals = data.map(d=>d.val).filter(v=>v>0), ws = data.map(d=>d.w).filter(w=>w>0);
        if (vals.length >= 3 && ws.length >= 3) {
            const valRatio = Math.max(...vals) / Math.max(1, Math.min(...vals));
            const wRatio = Math.max(...ws) / Math.max(1, Math.min(...ws));
            // COLLAPSED = values vary meaningfully (>=1.5x) yet bar widths are flat
            // (<1.2x) — the bars don't track their values. Narrow-range charts (e.g.
            // 84-100%) are NOT flagged: their small width spread is correct, not a
            // collapse. (Live-caught false positive on Chen's benchmark chart.)
            if (valRatio >= 1.5 && wRatio < 1.2) flaws.push('bar-chart-collapsed');
        }
    }
    const sb = slideEl.getBoundingClientRect();
    for (const el of slideEl.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width && (r.right > sb.right + 6 || r.bottom > sb.bottom + 6)) { flaws.push('overflow'); break; } }
    return flaws;
}`;

async function renderSlides(deckHtmlPath) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(pathToFileURL(deckHtmlPath).href, { waitUntil: 'networkidle' });
    const handles = await page.$$('.slide');
    const out = [];
    for (let i = 0; i < handles.length; i++) {
        const png = await handles[i].screenshot();
        const geomFlaws = await handles[i].evaluate(new Function('return ' + GEOMETRY_FN)());
        out.push({ png, geomFlaws });
    }
    await browser.close();
    return out;
}

// ── Per-persona deck generation (live presentation UI) ────────────────────────
// Drives the real presentation-chat → new deck → type the persona prompt → poll
// the preview iframe srcdoc until stable → capture deck.html. Reuses the proven
// flow from pres-websearch-throttle.mjs (sans the web-search source).
async function generatePersonaDeck(personaId) {
    const persona = PERSONAS.find(p => p.id === personaId);
    if (!persona) throw new Error(`unknown persona '${personaId}' (have: ${PERSONAS.map(p => p.id).join(', ')})`);
    const drv = await import('./driver.mjs');
    const { page } = await getLivePage();
    const closeAll = async () => { for (let i = 0; i < 6; i++) { const c = await page.evaluate(() => { const b = document.querySelector('.modal-container .modal .modal-close-button'); if (b) { b.click(); return true; } return false; }); if (!c) await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300); if (await page.$$eval('.modal-container .modal', e => e.length).catch(() => 0) === 0) return; } };
    const dismiss = () => page.evaluate(() => { const top = Array.from(document.querySelectorAll('.modal-container .modal')).filter(m => !m.classList.contains('ai-organiser-chat-modal')).pop(); if (!top) return false; const cta = top.querySelector('button.mod-cta') || Array.from(top.querySelectorAll('button')).find(b => /proceed|continue|ok|allow|accept|create|got it/i.test(b.textContent || '')); if (cta) { cta.click(); return true; } return false; });

    console.log(`[radar] generating ${persona.label} deck via the presentation UI …`);
    await closeAll();
    await drv.runCommand(page, 'ai-organiser:presentation-chat');
    await page.waitForSelector('.ai-organiser-resume-picker-modal, .modal-container .modal.ai-organiser-chat-modal', { timeout: 8000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const rows = Array.from(document.querySelectorAll('.ai-organiser-resume-action-row')); const t = rows.find(r => /new presentation/i.test(r.textContent || '')) || rows.find(r => /new conversation/i.test(r.textContent || '')); if (t) t.click(); });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) { if (!await dismiss()) break; await page.waitForTimeout(800); }
    await page.evaluate(() => { const m = document.querySelector('.modal-container .modal.ai-organiser-chat-modal'); const d = Array.from(m?.querySelectorAll('button') || []).find(b => /^discard$/i.test((b.textContent || '').trim())); if (d && !d.disabled) d.click(); });
    await page.waitForTimeout(1000);
    await page.evaluate((p) => { const m = document.querySelector('.modal-container .modal.ai-organiser-chat-modal'); const ta = m?.querySelector('textarea[placeholder*="resentation"], textarea'); const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; s.call(ta, p); ta.dispatchEvent(new Event('input', { bubbles: true })); }, persona.prompt);
    await page.waitForTimeout(400);
    await page.evaluate(() => { const m = document.querySelector('.modal-container .modal.ai-organiser-chat-modal'); let b = m?.querySelector('button.mod-cta svg.lucide-arrow-up')?.closest('button'); if (!b) b = Array.from(m?.querySelectorAll('button.mod-cta') || []).find(x => x.querySelector('svg')); if (b && !b.disabled) { b.click(); return; } const ta = m?.querySelector('textarea'); if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); });
    await page.waitForTimeout(2000);
    console.log('[radar] deck generating (Azure Opus, up to 6 min) …');
    const started = Date.now(); let stable = 0, lastLen = 0;
    while (Date.now() - started < 360000) {
        const s = await page.evaluate(() => { const m = document.querySelector('.modal-container .modal.ai-organiser-chat-modal'); const ifr = m?.querySelector('.ai-organiser-pres-preview-container iframe'); const sd = ifr ? (ifr.srcdoc || '') : ''; const thinking = !!m?.querySelector('.ai-organiser-chat-thinking'); const sec = Array.from(document.querySelectorAll('.modal-container .modal')).filter(x => !x.classList.contains('ai-organiser-chat-modal')).length; return { len: sd.length, thinking, sec }; });
        if (s.sec > 0) { await dismiss(); await page.waitForTimeout(700); }
        if (s.len > 1000 && !s.thinking) { if (s.len === lastLen) { stable++; if (stable >= 2) break; } else stable = 0; }
        lastLen = s.len;
        await page.waitForTimeout(4000);
    }
    const deckHtml = await page.evaluate(() => { const ifr = document.querySelector('.ai-organiser-pres-preview-container iframe'); return ifr ? (ifr.srcdoc || '') : ''; });
    if (!deckHtml || deckHtml.length < 1000) throw new Error('deck generation produced no slides (srcdoc empty)');
    const out = join(OUT, `persona-${personaId}-deck.html`);
    writeFileSync(out, deckHtml);
    console.log(`[radar] ${persona.label} deck generated (${deckHtml.length} bytes) → ${out}`);
    return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
let deckPath = DECK;
if (PERSONA) deckPath = await generatePersonaDeck(PERSONA);
if (!deckPath || !existsSync(deckPath)) {
    console.error('Usage: node persona-layout-ab.mjs (--deck <deck.html> | --persona <pat|chen|maya>) [--label NAME] [--bless] [--judge-provider live]');
    process.exit(1);
}
console.log(JUDGE ? `[radar] vision judge: ${JUDGE.id} (${JUDGE.model}) — ${JUDGE.reason}` : '[radar] vision judge: NONE — geometry-only (no judge key found)');
console.log(`[radar] rendering "${LABEL}" from ${deckPath}`);
const rendered = await renderSlides(deckPath);
console.log(`[radar] ${rendered.length} slides → deterministic geometry checks + structural vision judge …`);

const slideResults = [];
for (let i = 0; i < rendered.length; i++) {
    const { png, geomFlaws } = rendered[i];
    writeFileSync(join(OUT, `${LABEL}-slide-${i + 1}.png`), png);
    const verdict = await judgeSlide(png);
    const a = verdict.answers || {};
    const visionFlaws = QUESTIONS.filter(q => q.critical && /^no\b/i.test((a[q.id] || '').trim())).map(f => f.id);
    const flaws = [...new Set([...geomFlaws, ...visionFlaws])]; // geometry (reliable) ∪ vision
    slideResults.push({ slide: i + 1, answers: a, geomFlaws, visionFlaws, flaws, notes: verdict.notes });
    console.log(`[radar]   slide ${i + 1}: ${flaws.length ? '⚠ FLAW(' + flaws.join(',') + ')' : '✓'}${flaws.length ? ' — ' + (verdict.notes || '').slice(0, 80) : ''}`);
}

const totalFlaws = slideResults.reduce((n, s) => n + s.flaws.length, 0);
const passed = totalFlaws === 0;
const report = { label: LABEL, deck: deckPath, persona: PERSONA || null, slides: rendered.length, totalCriticalFlaws: totalFlaws, verdict: passed ? 'LAYOUT-OK' : 'LAYOUT-FLAWS', slideResults };
writeFileSync(join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2));

console.log(`\n=========== LAYOUT RADAR: ${LABEL} ===========`);
console.log(`  ${rendered.length} slides · ${totalFlaws} critical flaws · ${report.verdict}`);
for (const s of slideResults.filter(s => s.flaws.length)) console.log(`  ⚠ slide ${s.slide}: ${s.flaws.join(', ')} — ${(s.notes || '').slice(0, 90)}`);
console.log('==============================================');

// ── Baseline (gated) ──────────────────────────────────────────────────────────
if (BLESS) {
    if (!passed) { console.error('[radar] REFUSING to bless: layout flaws present. Fix first, then --bless.'); process.exit(2); }
    mkdirSync(BASELINE, { recursive: true });
    const inv = existsSync(join(BASELINE, 'invariants.json')) ? JSON.parse(readFileSync(join(BASELINE, 'invariants.json'), 'utf8')) : {};
    inv[LABEL] = { slides: rendered.length, blessedAt: 'manual', criticalChecks: QUESTIONS.filter(q => q.critical).map(q => q.id) };
    writeFileSync(join(BASELINE, 'invariants.json'), JSON.stringify(inv, null, 2));
    for (let i = 0; i < rendered.length; i++) writeFileSync(join(BASELINE, `${LABEL}-slide-${i + 1}.png`), rendered[i].png);
    console.log(`[radar] BLESSED ${LABEL} → baseline/ (${rendered.length} renders + invariants). Future runs A/B against this.`);
}
if (_live) await _live.browser.close().catch(() => {});
console.log(`[radar] done. Artifacts: ${OUT}`);
