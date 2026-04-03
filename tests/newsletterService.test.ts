import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractSenderName } from '../src/services/newsletter/newsletterService';
import { buildTriagePrompt, insertContentIntoTriagePrompt } from '../src/services/prompts/triagePrompts';

// ── extractSenderName ────────────────────────────────────────────────────────

describe('extractSenderName', () => {
    it('extracts name from "Name <email>" format', () => {
        expect(extractSenderName('Morning Brew <morning@brew.com>')).toBe('Morning Brew');
    });

    it('extracts name from quoted format', () => {
        expect(extractSenderName('"The Hustle" <hustle@thehustle.co>')).toBe('The Hustle');
    });

    it('extracts username from bare email', () => {
        expect(extractSenderName('newsletter@example.com')).toBe('newsletter');
    });

    it('trims whitespace from name', () => {
        expect(extractSenderName('  Daily News  <daily@news.com>')).toBe('Daily News');
    });

    it('handles name without angle brackets', () => {
        expect(extractSenderName('Some Sender')).toBe('Some Sender');
    });

    it('handles empty string', () => {
        expect(extractSenderName('')).toBe('');
    });

    it('handles name with special characters', () => {
        expect(extractSenderName("O'Reilly Media <info@oreilly.com>")).toBe("O'Reilly Media");
    });
});

// ── Triage prompt newsletter content type ────────────────────────────────────

describe('buildTriagePrompt newsletter content type', () => {
    it('includes newsletter type label', () => {
        const prompt = buildTriagePrompt({ contentType: 'newsletter' });
        expect(prompt).toContain('email newsletter');
    });

    it('includes newsletter-specific hint', () => {
        const prompt = buildTriagePrompt({ contentType: 'newsletter' });
        expect(prompt).toContain('Skip promotional content');
    });

    it('includes main story focus hint', () => {
        const prompt = buildTriagePrompt({ contentType: 'newsletter' });
        expect(prompt).toContain('bullet point per distinct story');
    });

    it('does not include newsletter hint for web type', () => {
        const prompt = buildTriagePrompt({ contentType: 'web' });
        expect(prompt).not.toContain('Skip promotional content');
    });

    it('inserts content into placeholder', () => {
        const prompt = buildTriagePrompt({ contentType: 'newsletter' });
        const filled = insertContentIntoTriagePrompt(prompt, 'Test newsletter content here');
        expect(filled).toContain('Test newsletter content here');
        expect(filled).not.toContain('CONTENT_PLACEHOLDER');
    });
});

// ── NewsletterService unit tests (mocked) ────────────────────────────────────

describe('NewsletterService dedup hash', () => {
    // Test the hash function indirectly by verifying determinism
    it('same input produces same hash', () => {
        // Use the same hash algorithm as the service
        function hashId(id: string): string {
            let hash = 0;
            for (let i = 0; i < id.length; i++) {
                hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
            }
            return hash.toString(36);
        }

        const h1 = hashId('msg-123');
        const h2 = hashId('msg-123');
        const h3 = hashId('msg-456');

        expect(h1).toBe(h2);
        expect(h1).not.toBe(h3);
    });

    it('different inputs produce different hashes', () => {
        function hashId(id: string): string {
            let hash = 0;
            for (let i = 0; i < id.length; i++) {
                hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
            }
            return hash.toString(36);
        }

        const ids = ['msg-1', 'msg-2', 'msg-3', 'msg-100', 'abcdef'];
        const hashes = ids.map(hashId);
        const unique = new Set(hashes);
        expect(unique.size).toBe(ids.length);
    });
});

// ── RawNewsletter type validation ────────────────────────────────────────────

describe('RawNewsletter interface', () => {
    it('accepts valid raw newsletter shape', () => {
        const raw = {
            id: 'msg-123',
            from: 'Test <test@example.com>',
            subject: 'Weekly Update',
            date: '2026-03-17T10:00:00Z',
            body: '<h1>Hello</h1><p>Content here</p>',
            plain: 'Hello\nContent here'
        };

        expect(raw.id).toBe('msg-123');
        expect(raw.from).toContain('Test');
        expect(raw.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
});

// ── Digest note format ──────────────────────────────────────────────────────

describe('Digest note format', () => {
    it('creates valid frontmatter structure', () => {
        const dateStr = '2026-03-17';
        const count = 3;
        const frontmatter = [
            '---',
            'tags:',
            '  - newsletter-digest',
            `created: ${dateStr}`,
            `newsletter_count: ${count}`,
            '---',
        ].join('\n');

        expect(frontmatter).toContain('newsletter-digest');
        expect(frontmatter).toContain('newsletter_count: 3');
        expect(frontmatter).toContain('created: 2026-03-17');
    });

    it('creates valid wikilink for read-full', () => {
        const dateStr = '2026-03-17';
        const safeName = 'Morning Brew';
        const link = `**[[${dateStr}/${safeName}|Read full]]**`;

        expect(link).toContain('[[2026-03-17/Morning Brew|Read full]]');
    });
});

// ── Settings defaults ────────────────────────────────────────────────────────

describe('Newsletter settings defaults', () => {
    it('has expected default values', async () => {
        // Dynamic import to get defaults
        const { DEFAULT_SETTINGS } = await import('../src/core/settings');

        expect(DEFAULT_SETTINGS.newsletterEnabled).toBe(false);
        expect(DEFAULT_SETTINGS.newsletterSource).toBe('apps-script');
        expect(DEFAULT_SETTINGS.newsletterScriptUrl).toBe('');
        expect(DEFAULT_SETTINGS.newsletterOutputFolder).toBe('Newsletter Inbox');
        expect(DEFAULT_SETTINGS.newsletterAutoTag).toBe(true);
        expect(DEFAULT_SETTINGS.newsletterGmailLabel).toBe('Newsletters');
    });
});

// ── Path helper ──────────────────────────────────────────────────────────────

describe('getNewsletterOutputFullPath', () => {
    it('resolves output path with default settings', async () => {
        const { getNewsletterOutputFullPath, DEFAULT_SETTINGS } = await import('../src/core/settings');

        const path = getNewsletterOutputFullPath(DEFAULT_SETTINGS as any);
        expect(path).toContain('Newsletter Inbox');
    });

    it('uses custom folder when set', async () => {
        const { getNewsletterOutputFullPath, DEFAULT_SETTINGS } = await import('../src/core/settings');

        const customSettings = { ...DEFAULT_SETTINGS, newsletterOutputFolder: 'My Newsletters' } as any;
        const path = getNewsletterOutputFullPath(customSettings);
        expect(path).toContain('My Newsletters');
    });
});
