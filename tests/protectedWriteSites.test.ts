/**
 * Protected folders: every write-API call site in `src/` must be classified.
 *
 * The plugin promises it never modifies, renames, trashes or creates anything inside a
 * protected folder. That promise holds only while every place that can write is either
 * guarded or confined to a plugin output location that is validated disjoint from the
 * protected list. This test is the same discipline as the ESLint note-write seam: it scans
 * the source for Obsidian write APIs and fails when
 *   - a file has a write site that is not in the manifest below (a new, unclassified site),
 *   - a file's count changed (a new site slipped into an already-classified file),
 *   - a manifest entry no longer matches the source (stale), or
 *   - a file classified `guarded` no longer calls a guard.
 *
 * Classes:
 *   guarded      the file calls assertWritable / assertWritableActive / guardActiveNote, or goes
 *                through the note-write seam (applyNoteEdit / writeNote). Any remaining site in
 *                the file writes only to a plugin output root (see `reason`).
 *   output-root  creates or overwrites only under a configured plugin output folder.
 *   plugin-data  writes only to the plugin's own data / config folder.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

type SiteClass = 'guarded' | 'output-root' | 'plugin-data';
interface Entry { count: number; cls: SiteClass; reason: string }

const MANIFEST: Record<string, Entry> = {
	// ── The seam and the guarded user-note writers ──────────────────────────────────────────
	'src/services/noteEdit/noteWritePort.ts': { count: 2, cls: 'guarded', reason: 'the seam; asserts writability before any editor or vault write' },
	'src/utils/tagUtils.ts': { count: 6, cls: 'guarded', reason: 'tag writers guard at entry; saveAllTags guards its target; the rest is the tags output file' },
	'src/utils/frontmatterUtils.ts': { count: 1, cls: 'guarded', reason: 'updateAIOMetadata guards before processFrontMatter' },
	'src/utils/editorUtils.ts': { count: 4, cls: 'guarded', reason: 'editor helpers call guardActiveNote' },
	'src/utils/noteStructure.ts': { count: 8, cls: 'guarded', reason: 'editor helpers call guardActiveNote' },
	'src/ui/contextMenu.ts': { count: 3, cls: 'guarded', reason: 'selection edits call guardActiveNote' },
	'src/commands/chatCommands.ts': { count: 1, cls: 'guarded', reason: 'editor insert calls guardActiveNote' },
	'src/commands/generateCommands.ts': { count: 1, cls: 'guarded', reason: 'editor write calls guardActiveNote' },
	'src/commands/highlightCommands.ts': { count: 2, cls: 'guarded', reason: 'selection edits call guardActiveNote' },
	'src/commands/smartNoteCommands.ts': { count: 2, cls: 'guarded', reason: 'editor insert and new-note create are guarded' },
	'src/commands/summarizeCommands.ts': { count: 1, cls: 'guarded', reason: 'note edits go through applyNoteEdit; the create is the transcript output file' },
	'src/ui/modals/MermaidChatModal.ts': { count: 3, cls: 'guarded', reason: 'editor writes call guardActiveNote' },
	'src/ui/modals/QuickPeekModal.ts': { count: 2, cls: 'guarded', reason: 'editor writes call guardActiveNote' },
	'src/ui/modals/UnifiedChatModal.ts': { count: 3, cls: 'guarded', reason: 'insert calls guardActiveNote; vault.create is the chat export under the chat output root' },
	'src/ui/chat/ResearchModeHandler.ts': { count: 5, cls: 'guarded', reason: 'insert calls guardActiveNote; vault.create/modify target the research output note' },
	'src/main.ts': { count: 3, cls: 'guarded', reason: 'suggested title and folder renames call assertWritable; createFolder is for the suggested folder' },
	'src/commands/notebookLMCommands.ts': { count: 2, cls: 'guarded', reason: 'selection-tag writes call assertWritable' },
	'src/services/notebooklm/selectionService.ts': { count: 3, cls: 'guarded', reason: 'selection-tag writes call assertWritableActive' },
	'src/services/audioNarration/narrationEmbedManager.ts': { count: 3, cls: 'guarded', reason: 'embed block sync calls assertWritableActive' },
	'src/services/imageProcessorService.ts': { count: 2, cls: 'guarded', reason: 'replaceOriginal calls assertWritableActive' },
	'src/services/audioCompressionService.ts': { count: 2, cls: 'guarded', reason: 'replaceAudioFile calls assertWritableActive' },
	'src/services/audioCleanupService.ts': { count: 1, cls: 'guarded', reason: 'deleteAudioFile calls assertWritable' },
	'src/services/oneDriveEmbedService.ts': { count: 2, cls: 'guarded', reason: 'refresh calls assertWritableActive; the copy-in create writes the OneDrive embed folder' },
	'src/commands/semanticSearchCommands.ts': { count: 2, cls: 'guarded', reason: 'export-to-note create and append call assertWritableActive' },
	'src/utils/companionUtils.ts': { count: 1, cls: 'guarded', reason: 'companion create beside the source calls assertWritableActive' },

	// ── Plugin output roots (validated disjoint from protected folders) ─────────────────────
	'src/commands/minutesCommands.ts': { count: 1, cls: 'output-root', reason: 'Word export under the minutes output folder' },
	'src/services/audio/audioImportService.ts': { count: 3, cls: 'output-root', reason: 'audio import into the configured recordings folder' },
	'src/services/audioNarration/audioNarrationService.ts': { count: 1, cls: 'output-root', reason: 'narration audio under the narration output folder' },
	'src/services/canvas/canvasUtils.ts': { count: 2, cls: 'output-root', reason: 'new boards under the canvas output folder' },
	'src/services/chat/conversationPersistenceService.ts': { count: 7, cls: 'output-root', reason: 'chat conversations under the chat root' },
	'src/services/chat/globalMemoryService.ts': { count: 2, cls: 'output-root', reason: 'chat memory under the chat root' },
	'src/services/chat/projectService.ts': { count: 9, cls: 'output-root', reason: 'chat projects under the chat root' },
	'src/services/dashboardService.ts': { count: 3, cls: 'output-root', reason: 'dashboards under the dashboards output folder' },
	'src/services/export/exportService.ts': { count: 1, cls: 'output-root', reason: 'document export under the export output folder' },
	'src/services/kindle/kindleSyncService.ts': { count: 2, cls: 'output-root', reason: 'highlight notes under the Kindle output folder' },
	'src/services/mermaidExportService.ts': { count: 6, cls: 'output-root', reason: 'diagram exports under the export output folder' },
	'src/services/mermaidTemplateService.ts': { count: 3, cls: 'output-root', reason: 'diagram templates under the plugin folder' },
	'src/services/minutesService.ts': { count: 3, cls: 'output-root', reason: 'minutes under the minutes output folder' },
	'src/services/newsletter/newsletterAudioService.ts': { count: 2, cls: 'output-root', reason: 'brief audio under the newsletter output folder' },
	'src/services/newsletter/newsletterService.ts': { count: 7, cls: 'output-root', reason: 'newsletter notes under the newsletter output folder' },
	'src/services/notebooklm/sourcePackService.ts': { count: 9, cls: 'output-root', reason: 'source packs under the NotebookLM export folder' },
	'src/services/notebooklm/writer.ts': { count: 3, cls: 'output-root', reason: 'source pack files under the NotebookLM export folder' },
	'src/services/pdfService.ts': { count: 2, cls: 'output-root', reason: 'PDF exports under the export output folder' },
	'src/services/research/researchOrchestrator.ts': { count: 5, cls: 'output-root', reason: 'research notes under the research output folder' },
	'src/services/research/researchUsageService.ts': { count: 4, cls: 'output-root', reason: 'usage log under the plugin folder' },
	'src/services/sketch/sketchExport.ts': { count: 1, cls: 'output-root', reason: 'sketches under the sketch output folder' },
	'src/services/webReaderService.ts': { count: 1, cls: 'output-root', reason: 'article lists under the web reader output folder' },
	'src/ui/chat/PresentationModeHandler.ts': { count: 4, cls: 'output-root', reason: 'storyline notes under the presentation output folder' },
	'src/ui/chat/presentation/presentationExporter.ts': { count: 2, cls: 'output-root', reason: 'decks under the export output folder' },
	'src/ui/modals/AudioRecorderModal.ts': { count: 3, cls: 'output-root', reason: 'recordings under the recordings folder' },
	'src/ui/modals/DashboardCreationModal.ts': { count: 1, cls: 'output-root', reason: 'dashboard folder under the output root' },
	'src/ui/modals/MinutesCreationModal.ts': { count: 1, cls: 'output-root', reason: 'transcript note under the minutes output folder' },
	'src/ui/modals/TranscribeOnlyModal.ts': { count: 1, cls: 'output-root', reason: 'transcript note under the transcript output folder' },
	'src/utils/minutesUtils.ts': { count: 1, cls: 'output-root', reason: 'ensureFolderExists creates the output folder it was asked for' },

	// ── Plugin data and configuration ───────────────────────────────────────────────────────
	'src/services/configurationService.ts': { count: 6, cls: 'plugin-data', reason: 'config files under the plugin config folder' },
	'src/services/dictionaryService.ts': { count: 4, cls: 'plugin-data', reason: 'dictionaries under the plugin config folder' },
	'src/services/participantListService.ts': { count: 3, cls: 'plugin-data', reason: 'participant lists under the plugin config folder' },
	'src/services/notebooklm/registry.ts': { count: 3, cls: 'plugin-data', reason: 'registry file in the plugin data folder' },
	'src/services/vector/voyVectorStore.ts': { count: 3, cls: 'plugin-data', reason: 'index files in the plugin data folder' },
	'src/services/visualEmbedding/visualIndexRepository.ts': { count: 5, cls: 'plugin-data', reason: 'visual index in the plugin data folder' },
	'src/ui/settings/ConfigurationSettingsSection.ts': { count: 3, cls: 'plugin-data', reason: 'config file maintenance under the plugin config folder' },

	// ── Attachment helper (guarded in this plan's Phase 2) ──────────────────────────────────
	'src/ui/modals/EmbedScanResultsModal.ts': { count: 1, cls: 'guarded', reason: 'trash goes through attachmentEligibility and assertWritable' },
};

const WRITE_API = new RegExp(
	[
		String.raw`\b(?:vault|Vault)\.(?:modify|create|createBinary|modifyBinary|process|append|appendBinary|rename|delete|trash|createFolder|copy)\(`,
		String.raw`\bfileManager\.(?:trashFile|renameFile|processFrontMatter)\(`,
		String.raw`\badapter\.(?:write|writeBinary|append|remove|rename|rmdir|mkdir|copy|trashLocal|trashSystem)\(`,
		String.raw`\beditor\.(?:setValue|replaceRange|replaceSelection|setLine)\(`,
	].join('|'),
	'g',
);
const GUARD = /assertWritable|guardActiveNote|applyNoteEdit|isProtectedActive|writeNote\(/;

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (name.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** Count write-API sites in a source string and whether it contains a guard (used by the negative controls). */
function analyseSource(text: string): { count: number; guarded: boolean } {
	return { count: (text.match(WRITE_API) ?? []).length, guarded: GUARD.test(text) };
}

function scan(): Map<string, { count: number; guarded: boolean }> {
	const root = join(__dirname, '..');
	const result = new Map<string, { count: number; guarded: boolean }>();
	for (const file of walk(join(root, 'src'))) {
		const text = readFileSync(file, 'utf8');
		const count = (text.match(WRITE_API) ?? []).length;
		if (count > 0) result.set(relative(root, file).replaceAll('\\', '/'), { count, guarded: GUARD.test(text) });
	}
	return result;
}

describe('write-site scanner (negative controls)', () => {
	it('finds each family of write API and counts every site', () => {
		const text = [
			'await app.vault.modify(f, s);',
			'await this.app.fileManager.trashFile(f);',
			'await plugin.app.fileManager.processFrontMatter(f, fn);',
			'await app.vault.adapter.write(p, s);',
			'editor.replaceSelection(x);',
		].join('\n');
		expect(analyseSource(text).count).toBe(5);
	});

	it('does not count look-alikes such as Map.delete or a bare modify call', () => {
		expect(analyseSource('cache.delete(k); set.create(x); modify(file);').count).toBe(0);
	});

	it('recognises a guard and a missing guard', () => {
		expect(analyseSource('assertWritable(s, "modify", p); vault.modify(f, x);')).toEqual({ count: 1, guarded: true });
		expect(analyseSource('vault.modify(f, x);')).toEqual({ count: 1, guarded: false });
	});
});

describe('protected folders: write-site classification', () => {
	const found = scan();

	it('has no unclassified write site', () => {
		const missing = [...found.keys()].filter((f) => !(f in MANIFEST));
		expect(missing, `classify these files in tests/protectedWriteSites.test.ts: ${missing.join(', ')}`).toEqual([]);
	});

	it('has no stale manifest entry', () => {
		const stale = Object.keys(MANIFEST).filter((f) => !found.has(f));
		expect(stale).toEqual([]);
	});

	it('matches the recorded site count for every file (a new site in a known file must be classified)', () => {
		const drift = Object.entries(MANIFEST)
			.filter(([f, e]) => found.get(f) && found.get(f)!.count !== e.count)
			.map(([f, e]) => `${f}: manifest ${e.count}, source ${found.get(f)!.count}`);
		expect(drift).toEqual([]);
	});

	it('requires every guarded file to call a guard', () => {
		const unguarded = Object.entries(MANIFEST)
			.filter(([f, e]) => e.cls === 'guarded' && found.get(f) && !found.get(f)!.guarded)
			.map(([f]) => f);
		expect(unguarded).toEqual([]);
	});

	it('gives every entry a reason', () => {
		for (const [file, entry] of Object.entries(MANIFEST)) {
			expect(entry.reason.length, file).toBeGreaterThan(10);
		}
	});
});
