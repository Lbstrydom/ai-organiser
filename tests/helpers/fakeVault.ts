/**
 * A small in-memory vault for tests that need `app.vault` + `metadataCache` behaviour:
 * files with text, link resolution by exact path / trailing path / bare name, and a way to
 * make a file unreadable. Synthetic content only.
 */
import { createTFile, TFile } from '../mocks/obsidian';

export interface FakeFileSpec {
	text?: string;
	size?: number;
	mtime?: number;
	/** Reading this file throws */
	unreadable?: boolean;
}

/** What Obsidian's own link index would say, for tests of the "graph is a floor" rule. */
export interface FakeLinkIndex {
	/** `metadataCache.resolvedLinks`: referrer path -> { target path: count } */
	resolvedLinks?: Record<string, Record<string, number>>;
	/** `metadataCache.getFileCache(path)`: the links/embeds Obsidian parsed, with 0-based lines */
	fileCache?: Record<string, { links?: Array<{ link: string; original: string; position: { start: { line: number } } }>; embeds?: Array<{ link: string; original: string; position: { start: { line: number } } }> }>;
}

export function makeFakeApp(specs: Record<string, FakeFileSpec | string>, index: FakeLinkIndex = {}) {
	const files = new Map<string, TFile>();
	const content = new Map<string, FakeFileSpec>();

	const add = (path: string, spec: FakeFileSpec | string) => {
		const s: FakeFileSpec = typeof spec === 'string' ? { text: spec } : spec;
		const f = createTFile(path);
		f.stat = { mtime: s.mtime ?? 1000, ctime: 1, size: s.size ?? (s.text?.length ?? 100) };
		files.set(path, f);
		content.set(path, s);
	};
	for (const [path, spec] of Object.entries(specs)) add(path, spec);

	const resolve = (link: string, source: string): TFile | null => {
		let norm = link.replace(/^\/+/, '');
		// "./x" and "../x" are relative to the note, as in Obsidian
		if (norm.startsWith('./') || norm.startsWith('../')) {
			const parts = source.split('/').slice(0, -1);
			for (const seg of norm.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
			norm = parts.join('/');
		}
		const lower = norm.toLowerCase();
		const exact = [...files.values()].find((f) => f.path.toLowerCase() === lower);
		if (exact) return exact;
		const withMd = [...files.values()].find((f) => f.path.toLowerCase() === lower + '.md');
		if (withMd) return withMd;
		const tail = [...files.values()].filter(
			(f) =>
				f.path.toLowerCase().endsWith('/' + lower) ||
				f.name.toLowerCase() === lower ||
				// extensionless note names resolve to the note, wherever it sits
				(f.extension === 'md' && (f.path.toLowerCase().endsWith('/' + lower + '.md') || f.name.toLowerCase() === lower + '.md')),
		);
		return tail[0] ?? null;
	};

	const app = {
		vault: {
			getFiles: () => [...files.values()],
			getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === 'md'),
			getAbstractFileByPath: (p: string) => files.get(p) ?? null,
			cachedRead: async (f: TFile) => {
				const s = content.get(f.path);
				if (!s || s.unreadable) throw new Error('unreadable');
				return s.text ?? '';
			},
			read: async (f: TFile) => {
				const s = content.get(f.path);
				if (!s || s.unreadable) throw new Error('unreadable');
				return s.text ?? '';
			},
			readBinary: async (f: TFile) => {
				const s = content.get(f.path);
				if (!s || s.unreadable) throw new Error('unreadable');
				return new TextEncoder().encode(s.text ?? '').buffer;
			},
		},
		metadataCache: {
			getFirstLinkpathDest: resolve,
			resolved: true,
			...(index.resolvedLinks ? { resolvedLinks: index.resolvedLinks } : {}),
			...(index.fileCache ? { getFileCache: (f: { path: string }) => index.fileCache![f.path] ?? null } : {}),
		},
	};

	return {
		app,
		files,
		set(path: string, spec: FakeFileSpec | string) { add(path, spec); },
		remove(path: string) { files.delete(path); content.delete(path); },
	};
}
