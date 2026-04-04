/**
 * Mermaid Staleness Gutter Extension (§4.4.3)
 *
 * A CodeMirror 6 ViewPlugin that decorates ```mermaid fence-opening lines
 * with a warning class when the underlying note has changed significantly
 * since the diagram was last applied.
 *
 * Controlled by `mermaidChatStalenessGutter` setting (default: false).
 * Desktop only — the Notice-based notification (§4.4.2) provides fallback on mobile.
 *
 * The CSS class `ai-organiser-mermaid-stale-gutter` is applied to the
 * opening fence line. Use the `::before` pseudo-element in styles.css
 * to render the warning icon.
 */

// eslint-disable-next-line import/no-extraneous-dependencies -- @codemirror/view is provided by Obsidian at runtime
import { ViewPlugin, ViewUpdate, Decoration, DecorationSet, EditorView } from '@codemirror/view';
// eslint-disable-next-line import/no-extraneous-dependencies -- @codemirror/state is provided by Obsidian at runtime
import { RangeSetBuilder } from '@codemirror/state';
import { findAllMermaidBlocks } from '../../utils/mermaidUtils';
import type AIOrganiserPlugin from '../../main';

/** Line decoration applied to stale ```mermaid fence-opening lines. */
const STALE_DECO = Decoration.line({
    class: 'ai-organiser-mermaid-stale-gutter',
    attributes: { title: 'This diagram may be outdated — click to update' },
});

/**
 * Build the full decoration set by scanning all mermaid blocks in the document
 * and checking each one's staleness via the shared MermaidChangeDetector.
 *
 * Pure function — no side effects. Called on every qualifying view update.
 */
function buildDecorations(view: EditorView, plugin: AIOrganiserPlugin): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    const content = doc.toString();
    const detector = plugin.mermaidChangeDetector;

    const blocks = findAllMermaidBlocks(content);
    for (const block of blocks) {
        // Fingerprint must match what MermaidChatModal uses on captureSnapshot
        const fp = block.code.slice(0, 80);
        if (!detector.hasSnapshot(fp)) continue;

        const { isStale } = detector.checkStaleness(fp, content);
        if (!isStale) continue;

        // startLine is 0-indexed; CM6 doc.line() is 1-indexed
        const line = doc.line(block.startLine + 1);
        builder.add(line.from, line.from, STALE_DECO);
    }

    return builder.finish();
}

/**
 * Create the CM6 extension factory.
 * Pass the plugin instance so the gutter can access the shared MermaidChangeDetector.
 *
 * Usage in main.ts:
 * ```ts
 * import { mermaidStalenessGutterExtension } from './ui/editor/mermaidStalenessGutter';
 * this.registerEditorExtension([mermaidStalenessGutterExtension(this)]);
 * ```
 */
export function mermaidStalenessGutterExtension(plugin: AIOrganiserPlugin) {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = buildDecorations(view, plugin);
            }

            update(update: ViewUpdate): void {
                if (update.docChanged || update.viewportChanged) {
                    this.decorations = buildDecorations(update.view, plugin);
                }
            }
        },
        { decorations: (v) => v.decorations },
    );
}
