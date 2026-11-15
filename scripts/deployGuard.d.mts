export function decideDeploy(
	gitDir: string | null,
	commonDir: string | null,
	env?: Record<string, string | undefined>,
): { deploy: boolean; reason: string };
export function shouldDeploy(
	cwd: string,
	env?: Record<string, string | undefined>,
): { deploy: boolean; reason: string };
