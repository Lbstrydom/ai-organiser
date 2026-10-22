export interface StagedEntry {
	status: string;
	path: string;
	oldPath?: string;
	blob?: string;
}

export interface StagedViolation {
	path: string;
	rule: string;
}

export interface StagedRules {
	pathRules?: string[];
	markers?: string[];
}

export declare const DEFAULT_PATH_RULES: readonly string[];
export declare function globToRegExp(glob: string): RegExp;
export declare function checkStaged(
	entries: StagedEntry[],
	readBlob: (entry: StagedEntry) => Buffer | string | null,
	rules?: StagedRules,
): { ok: boolean; violations: StagedViolation[] };
export declare function parseRawDiff(output: string): StagedEntry[];
export declare function loadGuardConfig(cwd: string): { markers: string[] } | null;
export declare function run(options?: {
	cwd?: string;
	env?: Record<string, string | undefined>;
	log?: (line: string) => void;
}): number;
