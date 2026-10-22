import { describe, it, expect } from 'vitest';
import {
	buildInventoryScript,
	rootsHashOf,
	INVENTORY_SCRIPT_VERSION,
	INVENTORY_SCRIPT_MIN_SUPPORTED,
} from '../src/services/cloudInventory/scriptTemplate';
import { parseDriveFolderInput } from '../src/services/cloudInventory/driveLinkParser';

describe('buildInventoryScript', () => {
	const script = buildInventoryScript({ secret: 'abc123secret', rootFolderIds: ['FolderRoot_A1', 'FolderRoot_B2'] });

	it('is syntactically valid JavaScript', () => {
		expect(() => new Function(script)).not.toThrow();
	});

	it('contains the generated config and nothing else secret-like', () => {
		expect(script).toContain('"SECRET": "abc123secret"');
		expect(script).toContain('"FolderRoot_A1"');
		expect(script).toContain('"FolderRoot_B2"');
		expect(script).toContain(`"SCRIPT_VERSION": ${INVENTORY_SCRIPT_VERSION}`);
		expect(script.match(/abc123secret/g)).toHaveLength(1);
	});

	it('keeps the safety rules: secret check, approved-root check, read-only, no writes', () => {
		expect(script).toContain('req.secret !== CONFIG.SECRET');
		expect(script).toContain('isApproved_(req.folderId)');
		expect(script).toContain('"not-approved"');
		expect(script).toContain('Drive.Files.list');
		for (const write of ['Drive.Files.create', 'Drive.Files.update', 'Drive.Files.remove', 'DriveApp.createFile', 'setTrashed', 'ScriptApp.newTrigger']) {
			expect(script.includes(write), write).toBe(false);
		}
	});

	it('answers ping with the version and the roots hash, and caches approved subfolders', () => {
		expect(script).toContain('scriptVersion: CONFIG.SCRIPT_VERSION');
		expect(script).toContain('rootsHash: rootsHash_()');
		expect(script).toContain('CacheService.getScriptCache()');
		expect(script).toContain('sha256Checksum');
	});

	it('escapes hostile values so config cannot break out of its string', () => {
		const evil = buildInventoryScript({ secret: 'a"b\\c\n// x', rootFolderIds: ['id"]);alert(1);//'] });
		expect(() => new Function(evil)).not.toThrow();
		expect(evil.includes('alert(1);//')).toBe(true); // present only inside a JSON string
		const config = /var CONFIG = (\{[\s\S]*?\n\});/.exec(evil)![1];
		expect(JSON.parse(config).SECRET).toBe('a"b\\c\n// x');
	});

	it('reports a supported minimum no newer than the current version', () => {
		expect(INVENTORY_SCRIPT_MIN_SUPPORTED).toBeLessThanOrEqual(INVENTORY_SCRIPT_VERSION);
	});
});

describe('rootsHashOf', () => {
	it('ignores order and is a sha256 hex', async () => {
		const a = await rootsHashOf(['b', 'a']);
		expect(a).toBe(await rootsHashOf(['a', 'b']));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).not.toBe(await rootsHashOf(['a']));
	});

	it('matches the known digest of "a,b"', async () => {
		expect(await rootsHashOf(['b', 'a'])).toBe('1eb7c54d52831bbfe8942af0b1c56b7409523a59ed6ca99c1174fef7eb32c1b5');
	});
});

describe('parseDriveFolderInput', () => {
	const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-12';

	it.each([
		[ID, ID],
		[`https://drive.google.com/drive/folders/${ID}`, ID],
		[`https://drive.google.com/drive/folders/${ID}?usp=sharing`, ID],
		[`https://drive.google.com/drive/u/0/folders/${ID}`, ID],
		[`https://drive.google.com/drive/mobile/folders/${ID}?usp=drive_link`, ID],
		[`https://drive.google.com/open?id=${ID}`, ID],
		[`  ${ID}  `, ID],
	])('accepts %s', (input, id) => {
		expect(parseDriveFolderInput(input)).toEqual({ ok: true, value: id });
	});

	it.each([
		'', 'short', 'https://example.com/drive/folders/' + ID, 'http://drive.google.com/drive/folders/' + ID,
		'https://drive.google.com.evil.com/drive/folders/' + ID, 'https://drive.google.com/drive/my-drive', 'javascript:alert(1)',
		'https://drive.google.com/file/d/' + ID + '/view',
		'https://drive.google.com/drive/folders/' + ID + '..%2Fevil', 'https://drive.google.com/drive/folders/' + ID + '!bad',
	])('refuses %s', (input) => {
		expect(parseDriveFolderInput(input)).toEqual({ ok: false, error: 'drive-link-invalid' });
	});
});
