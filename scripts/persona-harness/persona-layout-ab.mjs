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
const LABEL = argVal('--label') || (DECK ? basename(dirname(DECK)) + '-' + basename(DECK, '.html') : 'deck');

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

async function judgeSlide(pngBuf) {
    const key = readKey('OPENAI_API_KEY');
    if (!key) throw new Error('OPENAI_API_KEY not found');
    const b64 = pngBuf.toString('base64');
    const prompt = 'You are a strict slide-LAYOUT inspector. Look ONLY at layout/rendering, NOT wording or taste. Answer each question with "yes" or "no" and a 6-word reason. Return ONLY JSON: {"answers":{"' + QUESTIONS.map(q => q.id).join('":"...","') + '":"..."},"notes":"..."}\n\n' + QUESTIONS.map((q, i) => `${i + 1}. [${q.id}] ${q.q}`).join('\n');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o', temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }] }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    const txt = j.choices?.[0]?.message?.content || '';
    const m = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    try { return JSON.parse(m); } catch { return { answers: {}, notes: 'parse-failed: ' + txt.slice(0, 120) }; }
}

// Deterministic DOM-geometry checks — reproducible, robust to LLM nondeterminism,
// reliable where the vision judge is not (the bar-chart-collapse class).
const GEOMETRY_FN = `(slideEl) => {
    const flaws = [];
    const labels = Array.from(slideEl.querySelectorAll('*')).filter(e => e.children.length === 0 && /^\\d{1,3}%$/.test((e.textContent||'').trim()));
    if (labels.length >= 3) {
        const widths = labels.map(l => { let bar = l; for (let i=0;i<4 && bar.parentElement;i++){ bar = bar.parentElement; const bg = getComputedStyle(bar).backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)' && !/255,\\s*255,\\s*255/.test(bg)) break; } return bar.offsetWidth; });
        const max = Math.max(...widths), min = Math.min(...widths);
        if (max > 0 && (max - min) / max < 0.25) flaws.push('bar-chart-collapsed');
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

// ── Main ──────────────────────────────────────────────────────────────────────
if (!DECK || !existsSync(DECK)) {
    console.error('Usage: node persona-layout-ab.mjs --deck <path/to/deck.html> [--label NAME] [--bless]');
    process.exit(1);
}
console.log(`[radar] rendering "${LABEL}" from ${DECK}`);
const rendered = await renderSlides(DECK);
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
const report = { label: LABEL, deck: DECK, slides: rendered.length, totalCriticalFlaws: totalFlaws, verdict: passed ? 'LAYOUT-OK' : 'LAYOUT-FLAWS', slideResults };
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
console.log(`[radar] done. Artifacts: ${OUT}`);
