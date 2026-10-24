import { describe, it, expect } from 'vitest';
import { listAllReferrerFiles } from '../src/services/referrerSet';
import { createAppVaultPort } from '../src/services/attachmentEligibility';

const file = (path: string, ext: string) => ({ path, extension: ext, stat: { mtime: 1, size: 1 } });

function appWith(files: ReturnType<typeof file>[]) {
	return {
		vault: {
			getMarkdownFiles: () => files.filter((f) => f.extension === 'md'),
			getFiles: () => files,
		},
		metadataCache: {},
	} as never;
}

describe('referrer set', () => {
	const files = [
		file('Notes/a.md', 'md'),
		file('Excluded/Minutes.md', 'md'),
		file('AI-Organiser/Meeting Minutes/m.md', 'md'),
		file('Board.canvas', 'canvas'),
		file('Rec/meeting.m4a', 'm4a'),
	];

	it('is every note and canvas, excluded and plugin-managed folders included, and no attachment', () => {
		expect(listAllReferrerFiles(appWith(files)).map((f) => f.path).sort()).toEqual([
			'AI-Organiser/Meeting Minutes/m.md',
			'Board.canvas',
			'Excluded/Minutes.md',
			'Notes/a.md',
		]);
	});

	it('is exactly what the delete-time re-check enumerates', () => {
		const app = appWith(files);
		const scan = listAllReferrerFiles(app).map((f) => f.path).sort();
		const recheck = createAppVaultPort(app).listReferrers().map((r) => r.path).sort();
		expect(recheck).toEqual(scan);
	});
});
