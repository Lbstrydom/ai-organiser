import { describe, it, expect } from 'vitest';
import { parseSearchCommand } from '../src/services/chat/searchCommand';

describe('parseSearchCommand (mid-conversation web-search)', () => {
    it('parses /search <query>', () => {
        expect(parseSearchCommand('/search EMEA cloud market 2026')).toBe('EMEA cloud market 2026');
    });
    it('accepts /research and /web aliases', () => {
        expect(parseSearchCommand('/research quantum funding')).toBe('quantum funding');
        expect(parseSearchCommand('/web latest GPU prices')).toBe('latest GPU prices');
    });
    it('is case-insensitive and trims', () => {
        expect(parseSearchCommand('  /SEARCH   spacex ipo  ')).toBe('spacex ipo');
    });
    it('accepts a colon separator', () => {
        expect(parseSearchCommand('/search: tariff policy')).toBe('tariff policy');
    });
    it('returns null for a normal chat turn', () => {
        expect(parseSearchCommand('make slide 3 a 2x2')).toBeNull();
        expect(parseSearchCommand('add a slide about search trends')).toBeNull(); // "search" mid-sentence ≠ command
    });
    it('returns null for an empty / too-short query', () => {
        expect(parseSearchCommand('/search')).toBeNull();
        expect(parseSearchCommand('/search ')).toBeNull();
        expect(parseSearchCommand('/search x')).toBeNull(); // < 2 chars
    });
    it('does not match a word that merely starts with search', () => {
        expect(parseSearchCommand('/searchengine foo')).toBeNull();
    });
});
