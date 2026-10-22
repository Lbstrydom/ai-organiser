export const RELEASE_LABEL: string;
export const GUARDED_FILES: readonly string[];
export function versionFingerprint(file: string, text: string | null | undefined): string | null;
export function findVersionChanges(
	baseTexts: Record<string, string | null | undefined>,
	headTexts: Record<string, string | null | undefined>,
): { file: string; from: string | null; to: string | null }[];
export function hasReleaseLabel(labels: string[]): boolean;
export function parseLabels(raw: string | undefined | null): string[];
export function evaluate(input: {
	changes: { file: string; from: string | null; to: string | null }[];
	labels: string[];
}): { ok: boolean; reason: string };
export function readFileAtRef(ref: string, file: string, cwd?: string): string | null;
export function parseArgs(argv: string[]): { base: string; head: string; labels: string | undefined };
export function main(argv: string[], env?: Record<string, string | undefined>, cwd?: string): number;
