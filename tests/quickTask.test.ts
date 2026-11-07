import { describe, it, expect } from 'vitest';
import { inInbox, startingText } from '../src/commands/quickTaskCommands';

describe('quick task helpers', () => {
	it('takes the selection as one trimmed line, capped', () => {
		expect(startingText('  Call Sam\n about the  offsite ')).toBe('Call Sam about the offsite');
		expect(startingText(undefined)).toBe('');
		expect(startingText('x'.repeat(400))).toHaveLength(300);
	});

	it('knows a note in an inbox folder, and only there', () => {
		expect(inInbox('0 Inbox/a.md', ['0 Inbox'])).toBe(true);
		expect(inInbox('0 Inbox/sub/a.md', ['0 Inbox/'])).toBe(true);
		expect(inInbox('0 Inboxes/a.md', ['0 Inbox'])).toBe(false);
		expect(inInbox('Projects/a.md', ['0 Inbox'])).toBe(false);
		expect(inInbox('Projects/a.md', [''])).toBe(false);
	});
});
