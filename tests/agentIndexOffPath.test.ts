/**
 * Agent index: off by default and byte-identical when off. A disabled feature registers no command,
 * no event listener and no setting change beyond its inert defaults.
 */
import { describe, it, expect, vi } from 'vitest';
import { FEATURE_BY_ID } from '../src/core/features';
import { isFeatureEnabled } from '../src/services/featureService';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE, registerCommands } from '../src/commands/index';
import { registerAgentIndexCommands } from '../src/commands/agentIndexCommands';

describe('agent index off path', () => {
	it('is a default-off registry row with no dependencies', () => {
		const def = FEATURE_BY_ID['agent-index'];
		expect(def).toBeDefined();
		expect(def.defaultOn).toBe(false);
		expect(def.requires).toEqual([]);
		expect(isFeatureEnabled({ featureFlags: {} } as never, 'agent-index')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'agent-index': 'yes' } } as never, 'agent-index')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'agent-index': true } } as never, 'agent-index')).toBe(true);
	});

	it('is registered only through its feature, and registers nothing when off', () => {
		expect(REGISTER_BY_FEATURE['agent-index']).toEqual([registerAgentIndexCommands]);
		const addCommand = vi.fn();
		const registerEvent = vi.fn();
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), featureFlags: {} },
			addCommand,
			registerEvent,
			register: vi.fn(),
			registerDomEvent: vi.fn(),
			app: { vault: { on: vi.fn() } },
			t: {},
		};
		// registerContextMenu touches the workspace; only the feature registrars matter here.
		try { registerCommands(plugin as never); } catch { /* context menu needs a full app */ }
		const ids = addCommand.mock.calls.map((c) => (c[0] as { id: string }).id);
		expect(ids.filter((id) => /agent-index|agent-instructions/.test(id))).toEqual([]);
		expect(plugin.app.vault.on).not.toHaveBeenCalled();
	});

	it('registers its commands when on', () => {
		const ids: string[] = [];
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), agentIndexAutoRebuild: 'off' },
			addCommand: (c: { id: string }) => ids.push(c.id),
			registerEvent: vi.fn(),
			register: vi.fn(),
			app: { vault: { on: vi.fn() } },
			t: { commands: {}, agentIndex: {} },
		};
		registerAgentIndexCommands(plugin as never);
		expect(ids).toEqual(['build-agent-index', 'check-agent-index', 'copy-agent-instructions', 'copy-claude-permissions', 'write-agent-instructions', 'setup-agent-index']);
	});

	it('ships inert defaults that a migration leaves unchanged', () => {
		expect(DEFAULT_SETTINGS.agentIndexAutoRebuild).toBe('off');
		expect(DEFAULT_SETTINGS.agentIndexIncludeFolders).toEqual([]);
		expect(DEFAULT_SETTINGS.agentIndexIncludeHeadings).toBe(false);
		expect(DEFAULT_SETTINGS.agentIndexIncludeAliases).toBe(false);
		expect(DEFAULT_SETTINGS.agentIndexExportUnresolvedLinks).toBe(false);
		expect(DEFAULT_SETTINGS.agentInstructionsWrite).toBe(false);
		const migrated = migrateOldSettings(structuredClone(DEFAULT_SETTINGS) as never) as Record<string, unknown>;
		for (const key of Object.keys(DEFAULT_SETTINGS).filter((k) => k.startsWith('agentIndex'))) {
			expect(migrated[key], key).toEqual((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
		}
	});

	it('repairs corrupt stored values to the defaults', () => {
		const out = migrateOldSettings({
			agentIndexOutputPath: '   ',
			agentIndexAutoRebuild: 'sometimes',
			agentIndexIncludeFolders: 42,
			agentIndexIncludeAliases: 'yes',
		}) as Record<string, unknown>;
		expect(out.agentIndexOutputPath).toBe(DEFAULT_SETTINGS.agentIndexOutputPath);
		expect(out.agentIndexAutoRebuild).toBe('off');
		expect(out.agentIndexIncludeFolders).toEqual([]);
		expect(out.agentIndexIncludeAliases).toBe(false);
	});
});
