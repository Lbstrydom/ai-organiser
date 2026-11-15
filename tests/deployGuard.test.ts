import { describe, it, expect } from 'vitest';
import { decideDeploy } from '../scripts/deployGuard.mjs';

describe('decideDeploy', () => {
	it('deploys from the main checkout (git dir equals common dir)', () => {
		expect(decideDeploy('C:/r/.git', 'C:/r/.git').deploy).toBe(true);
		expect(decideDeploy('C:\\r\\.git', 'c:/r/.git/').deploy).toBe(true);
	});

	it('skips in a linked worktree', () => {
		const d = decideDeploy('C:/r/.git/worktrees/w1', 'C:/r/.git');
		expect(d.deploy).toBe(false);
		expect(d.reason).toContain('worktree');
	});

	it('deploys from a worktree only on the explicit opt-in', () => {
		const dir = 'C:/r/.git/worktrees/w1';
		const common = 'C:/r/.git';
		expect(decideDeploy(dir, common, { AIORG_DEPLOY_FROM_WORKTREE: '1' }).deploy).toBe(true);
		expect(decideDeploy(dir, common, { AIORG_DEPLOY_FROM_WORKTREE: 'true' }).deploy).toBe(false);
	});

	it('fails closed when git cannot be read', () => {
		expect(decideDeploy(null, 'C:/r/.git').deploy).toBe(false);
		expect(decideDeploy('C:/r/.git', null).deploy).toBe(false);
		expect(decideDeploy(null, null, { AIORG_DEPLOY_FROM_WORKTREE: '1' }).deploy).toBe(false);
	});
});
