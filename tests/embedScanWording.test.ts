import { describe, it, expect } from 'vitest';
import { en } from '../src/i18n/en';

/** Where a trashed file really goes follows the user's Obsidian setting, so the messages say "your trash". */
describe('trash wording in Find embeds and the Drive offload', () => {
	const strings = [
		en.embedScan.deleteConfirmWarning,
		en.offload.planStep4,
		en.offload.doneNotice,
	];

	it('says "your trash", never a specific one that may not be the user\'s setting', () => {
		for (const text of strings) {
			expect(text).toMatch(/your trash/);
			expect(text).not.toMatch(/obsidian trash|system trash/i);
		}
	});
});

describe('Find embeds counts wording', () => {
	it('names notes and canvases, since the scan reads both', () => {
		expect(en.embedScan.notesLabel).toBe('notes and canvases');
		expect(en.embedScan.scannedNotes).toBe('{count} note[s] and canvas[es] scanned');
	});

	it('has one set of numbers for files found, in use and not used', () => {
		expect(en.embedScan.totalFiles).toBe('{count} file[s] found');
		expect(en.embedScan.summaryInUse).toBe('{count} in use');
		expect(en.embedScan.summaryUnused).toBe('{count} not used by any note');
	});
});
