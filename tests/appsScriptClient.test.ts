import { describe, it, expect, vi } from 'vitest';
import { callScript, parseScriptResponse, validateScriptUrl, redact, type ScriptTransport } from '../src/services/appsScriptClient';

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST_id-1/exec';
const json = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });
const noSleep = async () => undefined;

describe('validateScriptUrl', () => {
	it('accepts only script.google.com exec links', () => {
		expect(validateScriptUrl(`  ${URL_OK} `)).toEqual({ ok: true, value: URL_OK });
		for (const bad of [
			'', 'http://script.google.com/macros/s/abc/exec', 'https://script.google.com/macros/s/abc/dev',
			'https://evil.example.com/macros/s/abc/exec', 'https://script.google.com.evil.com/macros/s/abc/exec',
			'https://script.google.com/macros/s/abc/exec?x=1', 'https://script.google.com/macros/s//exec', 'file:///etc/passwd',
		]) {
			expect(validateScriptUrl(bad), bad).toEqual({ ok: false, error: 'script-invalid-endpoint' });
		}
	});
});

describe('parseScriptResponse', () => {
	it('returns the body on ok:true', () => {
		expect(parseScriptResponse({ status: 200, text: '{"ok":true,"files":[]}' })).toEqual({ ok: true, value: { ok: true, files: [] } });
	});

	it('detects the Google sign-in page and auth statuses', () => {
		expect(parseScriptResponse({ status: 200, text: '<!DOCTYPE html><html>sign in</html>' })).toEqual({ ok: false, error: 'script-login-page' });
		expect(parseScriptResponse({ status: 403, text: '' })).toEqual({ ok: false, error: 'script-login-page' });
	});

	it('maps the script\'s own error codes', () => {
		for (const [code, mapped] of [['auth', 'script-auth'], ['not-approved', 'script-not-approved'], ['bad-request', 'script-bad-request'], ['drive-error', 'script-drive-error'], ['weird', 'script-bad-response']]) {
			expect(parseScriptResponse({ status: 200, text: JSON.stringify({ ok: false, error: { code } }) }), code).toEqual({ ok: false, error: mapped });
		}
	});

	it('treats non-JSON and server errors sensibly', () => {
		expect(parseScriptResponse({ status: 200, text: 'plain' })).toEqual({ ok: false, error: 'script-bad-response' });
		expect(parseScriptResponse({ status: 502, text: '' })).toEqual({ ok: false, error: 'script-drive-error' });
		expect(parseScriptResponse({ status: 200, text: '"str"' })).toEqual({ ok: false, error: 'script-bad-response' });
	});
});

describe('callScript', () => {
	it('sends the secret only in the POST body of a validated link', async () => {
		const transport = vi.fn<ScriptTransport>(async () => json({ ok: true }));
		await callScript({ url: URL_OK, secret: 'S3CRET', body: { op: 'ping' }, transport });
		expect(transport).toHaveBeenCalledTimes(1);
		const req = transport.mock.calls[0][0];
		expect(req.url).toBe(URL_OK);
		expect(req.url).not.toContain('S3CRET');
		expect(JSON.parse(req.body)).toEqual({ secret: 'S3CRET', op: 'ping' });
	});

	it('refuses an invalid endpoint before any request', async () => {
		const transport = vi.fn<ScriptTransport>();
		expect(await callScript({ url: 'https://evil.example.com/x', secret: 's', body: {}, transport })).toEqual({ ok: false, error: 'script-invalid-endpoint' });
		expect(transport).not.toHaveBeenCalled();
	});

	it('retries drive errors and network errors with growing delays, then succeeds', async () => {
		const sleeps: number[] = [];
		let n = 0;
		const transport: ScriptTransport = async () => {
			n++;
			if (n === 1) throw new Error('offline');
			if (n === 2) return json({ ok: false, error: { code: 'drive-error' } });
			return json({ ok: true, files: [1] });
		};
		const res = await callScript({ url: URL_OK, secret: 's', body: {}, transport, sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 100 });
		expect(res.ok).toBe(true);
		expect(sleeps).toEqual([100, 200]);
	});

	it('stops after the maximum number of attempts', async () => {
		const transport = vi.fn<ScriptTransport>(async () => json({ ok: false, error: { code: 'drive-error' } }));
		const res = await callScript({ url: URL_OK, secret: 's', body: {}, transport, sleep: noSleep, maxAttempts: 5 });
		expect(res).toEqual({ ok: false, error: 'script-drive-error' });
		expect(transport).toHaveBeenCalledTimes(5);
	});

	it.each([['auth', 'script-auth'], ['not-approved', 'script-not-approved']])('never retries %s', async (code, mapped) => {
		const transport = vi.fn<ScriptTransport>(async () => json({ ok: false, error: { code } }));
		const res = await callScript({ url: URL_OK, secret: 's', body: {}, transport, sleep: noSleep });
		expect(res).toEqual({ ok: false, error: mapped });
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it('does not retry a sign-in page', async () => {
		const transport = vi.fn<ScriptTransport>(async () => ({ status: 200, text: '<html></html>' }));
		expect(await callScript({ url: URL_OK, secret: 's', body: {}, transport, sleep: noSleep })).toEqual({ ok: false, error: 'script-login-page' });
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it('stops when cancelled', async () => {
		const ctl = new AbortController();
		ctl.abort();
		const transport = vi.fn<ScriptTransport>();
		expect(await callScript({ url: URL_OK, secret: 's', body: {}, transport, signal: ctl.signal })).toEqual({ ok: false, error: 'script-network' });
		expect(transport).not.toHaveBeenCalled();
	});
});

describe('redact', () => {
	it('removes every occurrence of the secret', () => {
		expect(redact('a S3 b S3 c', 'S3')).toBe('a [secret] b [secret] c');
		expect(redact('nothing', '')).toBe('nothing');
	});
});
