/**
 * Nothing in the new features assumes a folder structure (PARA or otherwise): default values of
 * the new settings and every setup / guidance string are free of PARA-style names. Folders are
 * always chosen by the user.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';

const PARA_WORDS = /\bPARA\b|\bAreas\b|\bProjects\b|\bResources\b|\bArchive\b/;

function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
	else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
	return out;
}

// Sections added for the vault-hygiene features. Later phases append their section names here.
const NEW_SECTIONS = ['setup', 'guidance', 'protectedFolders'] as const;

// Settings keys added for the vault-hygiene features. Later phases append theirs here.
const NEW_SETTING_KEYS = [
	'protectedFolders',
	'featureSetupCompletedAt',
	'attachmentLargeFileMB',
	'attachmentDuplicateMaxMB',
	'attachmentLinkHeading',
] as const;

describe('no folder-structure assumptions', () => {
	it('new settings default to no folders', () => {
		expect(DEFAULT_SETTINGS.protectedFolders).toEqual([]);
		for (const key of NEW_SETTING_KEYS) {
			const value = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
			expect(value, key).toBeDefined();
			for (const s of strings(value)) expect(PARA_WORDS.test(s), `${key}: ${s}`).toBe(false);
		}
	});

	it('setup, guidance and feature strings contain no PARA-style names', () => {
		for (const section of NEW_SECTIONS) {
			for (const s of strings((en as unknown as Record<string, unknown>)[section])) {
				expect(PARA_WORDS.test(s), `${section}: ${s}`).toBe(false);
			}
		}
	});
});
