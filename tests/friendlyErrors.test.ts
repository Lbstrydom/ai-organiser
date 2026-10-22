import { describe, it, expect } from 'vitest';
import { GUIDANCE_CODES, describeError, formatGuidance, isGuidanceCode } from '../src/core/friendlyErrors';
import { en } from '../src/i18n/en';

describe('friendlyErrors', () => {
	it('has English guidance (message and next step) for every code', () => {
		for (const code of GUIDANCE_CODES) {
			const entry = en.guidance[code];
			expect(entry, code).toBeDefined();
			expect(entry.message.length, `${code} message`).toBeGreaterThan(5);
			expect(entry.nextStep.length, `${code} nextStep`).toBeGreaterThan(5);
		}
	});

	it('uses sentence-style text that ends with a full stop', () => {
		for (const code of GUIDANCE_CODES) {
			expect(en.guidance[code].message.endsWith('.'), `${code} message`).toBe(true);
			expect(en.guidance[code].nextStep.endsWith('.'), `${code} nextStep`).toBe(true);
		}
	});

	it('never leaks a raw code into the text', () => {
		for (const code of GUIDANCE_CODES) {
			const text = formatGuidance(en.guidance[code]);
			expect(text.includes(code), code).toBe(false);
		}
	});

	it('falls back to the generic guidance for an unknown code', () => {
		expect(describeError(en, 'something-new')).toBe(en.guidance.unknown);
		expect(isGuidanceCode('something-new')).toBe(false);
		expect(isGuidanceCode('protected-path')).toBe(true);
	});

	it('formats message and next step as two sentences', () => {
		expect(formatGuidance({ message: 'A.', nextStep: 'B.' })).toBe('A. B.');
	});

	it('has no duplicate codes', () => {
		expect(new Set(GUIDANCE_CODES).size).toBe(GUIDANCE_CODES.length);
	});
});
