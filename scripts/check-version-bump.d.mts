export const RELEASE_LABEL: string;
export const GUARDED_FILES: readonly string[];

export type Fingerprint =
	| { state: 'absent' }
	| { state: 'ok'; value: string }
	| { state: 'invalid'; reason: string };

export interface VersionChange {
	file: string;
	from: string | null;
	to: string | null;
}

export interface InvalidInput {
	file: string;
	side: 'base' | 'head';
	reason: string;
}

export interface Verdict {
	ok: boolean;
	reason: string;
	invalidInput?: boolean;
}

export interface Io {
	out: (line: string) => void;
	err: (line: string) => void;
}

export function fingerprint(file: string, text: string | null | undefined): Fingerprint;
export function findVersionChanges(
	baseTexts: Record<string, string | null | undefined>,
	headTexts: Record<string, string | null | undefined>,
): { changes: VersionChange[]; invalid: InvalidInput[] };
export function hasReleaseLabel(labels: string[]): boolean;
export function parseLabels(raw: string | undefined | null): string[];
export function parseLabelsJson(
	raw: string | undefined | null,
): { ok: true; labels: string[] } | { ok: false; reason: string };
export function evaluate(input: { changes: VersionChange[]; invalid?: InvalidInput[]; labels: string[] }): Verdict;
export function readFileAtRef(ref: string, file: string, cwd?: string): string | null;
export function parseArgs(argv: string[]): { base: string; head: string; labels: string | undefined };
export function main(argv: string[], env?: Record<string, string | undefined>, cwd?: string, io?: Io): number;
