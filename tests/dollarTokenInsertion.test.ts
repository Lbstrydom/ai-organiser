/**
 * Replacement-string expansion — `String.prototype.replace(search, "text")`
 * interprets `$&`, `$1`, `$$`, `$` + backtick and `$'` in the REPLACEMENT, so
 * document text containing them was silently rewritten on its way into a
 * prompt or a note. These sinks now pass a replacer function.
 *
 * Both directions are pinned: text with the tokens round-trips byte-identical,
 * and text without them is exactly what the string form produced.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    buildSummaryPrompt, buildChunkCombinePrompt, insertContentIntoPrompt, insertSectionsIntoPrompt,
} from '../src/services/prompts/summaryPrompts';
import { insertContentIntoTriagePrompt } from '../src/services/prompts/triagePrompts';
import { insertContentIntoStructuredPrompt } from '../src/services/prompts/structuredPrompts';
import { updateFrontmatterInContent } from '../src/services/kindle/kindleNoteBuilder';
import { DashboardService } from '../src/services/dashboardService';
import { NewsletterService } from '../src/services/newsletter/newsletterService';

/** Every JS replacement token, plus ordinary dollars. */
const TOKENS = "Cost $& then $1 and $$ and $` and $' end. Plain $5 and $.";

describe('insertContentIntoPrompt', () => {
    const template = buildSummaryPrompt({ length: 'brief', personaPrompt: '<persona>p</persona>' });

    it('inserts document text containing replacement tokens verbatim', () => {
        const out = insertContentIntoPrompt(template, TOKENS);
        expect(out).toBe(template.split('CONTENT_PLACEHOLDER').join(TOKENS));
        expect(out).toContain(TOKENS);
        expect(out).not.toContain('CONTENT_PLACEHOLDER');
    });

    it('text without tokens is unchanged from the string-replace result', () => {
        const plain = 'A perfectly ordinary paragraph.';
        expect(insertContentIntoPrompt(template, plain)).toBe(template.replace('CONTENT_PLACEHOLDER', plain));
    });

    it('does not let "$`" pull the text BEFORE the placeholder into the content', () => {
        // With string replacement `$\`` expands to everything preceding the match — a huge duplication.
        const out = insertContentIntoPrompt(template, '$`');
        expect(out.length).toBe(template.length - 'CONTENT_PLACEHOLDER'.length + 2);
    });
});

describe('insertSectionsIntoPrompt', () => {
    const template = buildChunkCombinePrompt({ length: 'brief', personaPrompt: '<persona>p</persona>' });
    const sections = [`first ${TOKENS}`, 'second plain', `third ${TOKENS}`];
    const formatted = sections.map((s, i) => `[Section ${i + 1}/${sections.length}]\n${s}`).join('\n\n');

    it('inserts section summaries containing replacement tokens verbatim', () => {
        const out = insertSectionsIntoPrompt(template, sections);
        expect(out).toBe(template.split('SECTIONS_PLACEHOLDER').join(formatted));
        expect(out).toContain(formatted);
    });

    it('plain sections are unchanged from the string-replace result', () => {
        const plain = ['one', 'two'];
        const f = plain.map((s, i) => `[Section ${i + 1}/2]\n${s}`).join('\n\n');
        expect(insertSectionsIntoPrompt(template, plain)).toBe(template.replace('SECTIONS_PLACEHOLDER', f));
    });
});

describe('other prompt placeholders', () => {
    it('triage prompt', () => {
        const tpl = 'before\nCONTENT_PLACEHOLDER\nafter';
        expect(insertContentIntoTriagePrompt(tpl, TOKENS)).toBe(`before\n${TOKENS}\nafter`);
        expect(insertContentIntoTriagePrompt(tpl, 'plain')).toBe('before\nplain\nafter');
    });

    it('structured prompt', () => {
        const tpl = 'before\n{{CONTENT}}\nafter';
        expect(insertContentIntoStructuredPrompt(tpl, TOKENS)).toBe(`before\n${TOKENS}\nafter`);
        expect(insertContentIntoStructuredPrompt(tpl, 'plain')).toBe('before\nplain\nafter');
    });
});

describe('persisted-note sinks', () => {
    it('Kindle frontmatter update keeps a value containing replacement tokens', () => {
        const note = '---\ntitle: Old\nauthor: A\n---\nbody';
        const out = updateFrontmatterInContent(note, { title: TOKENS });
        const frontmatter = out.split('---')[1];
        // the value is stored as given (quoted or not) — never expanded
        expect(frontmatter).toContain(TOKENS.replaceAll('"', '\\"'));
        expect(frontmatter).toContain('author: A');
        expect(out.endsWith('body')).toBe(true);
    });

    it('Kindle frontmatter update with a plain value is unchanged', () => {
        const note = '---\ntitle: Old\n---\nbody';
        expect(updateFrontmatterInContent(note, { title: 'New Title' })).toBe('---\ntitle: New Title\n---\nbody');
    });

    it('dashboard folder filter keeps a folder name containing replacement tokens', () => {
        const svc = Object.create(DashboardService.prototype) as { injectFolderFilter(c: string, f: string): string };
        const folder = "Money $& more $1";
        const simple = "filters: 'note.kind == \"a\"'\nviews: []";
        const out1 = svc.injectFolderFilter(simple, folder);
        expect(out1).toContain(`file.inFolder("${folder}")`);
        expect(out1).toContain(`note.kind == "a"`);

        const nested = "filters:\n  and:\n    - 'x'\nviews: []";
        const out2 = svc.injectFolderFilter(nested, folder);
        expect(out2).toContain(`- 'file.inFolder("${folder}")'`);
        expect(out2).toContain("    - 'x'");
    });

    it('newsletter daily brief block keeps LLM text containing replacement tokens', async () => {
        const existing = '# Digest\n\n<!-- DAILY_BRIEF_START -->\nold\n<!-- DAILY_BRIEF_END -->\n\nrest';
        const modify = vi.fn();
        const svc = Object.create(NewsletterService.prototype) as {
            plugin: unknown;
            mergeOrPrependBrief(file: unknown, brief: string): Promise<void>;
        };
        svc.plugin = { app: { vault: { cachedRead: async () => existing, modify } } };
        await svc.mergeOrPrependBrief({ path: 'd.md' }, `Brief: ${TOKENS}`);
        const written = modify.mock.calls[0][1] as string;
        expect(written).toContain(`## Daily Brief\n\nBrief: ${TOKENS}\n\n<!-- DAILY_BRIEF_END -->`);
        expect(written).toContain('# Digest');
        expect(written.endsWith('rest')).toBe(true);
        expect(written.match(/DAILY_BRIEF_START/g)).toHaveLength(1);
    });
});
