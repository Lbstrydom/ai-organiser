export interface CheckResult {
	name: string;
	status: 'pass' | 'fail' | 'info';
	message: string;
}

export declare function checkSetImmediatePolyfillNeutralised(bundleSource: string): CheckResult;
export declare function checkNoManifestJsonLiteral(bundleSource: string): CheckResult;
export declare function checkVersionSync(
	pkgJson: unknown,
	manifestJson: unknown,
	versionsJson: unknown,
): CheckResult;
export declare function reportBundleSize(bundleSource: string): CheckResult;

export interface LoadedArtifacts {
	ok: true;
	bundleSource: string;
	pkgJson: { version?: string };
	manifestJson: { version?: string; minAppVersion?: string };
	versionsJson: Record<string, string>;
}

export interface LoadArtifactsFailure {
	ok: false;
	result: CheckResult;
}

export declare function loadArtifacts(
	readFileFn?: (path: string, encoding: string) => string,
	existsFn?: (path: string) => boolean,
): LoadedArtifacts | LoadArtifactsFailure;

export declare function runAllChecks(artifacts: Omit<LoadedArtifacts, 'ok'>): CheckResult[];
