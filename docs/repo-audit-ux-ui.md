# Repository Audit: Code Quality + UX/UI

Date: 2026-01-21
Scope: Code effectiveness/efficiency/DRY/SOLID + UX/UI intuitiveness

## Findings (ordered by severity)

### High

1) Semantic search settings re-render without clearing
- Impact: repeated toggles or provider changes append duplicate UI blocks; settings UI can balloon and become confusing.
- Evidence:
  - src/ui/settings/SemanticSearchSettingsSection.ts:33
  - src/ui/settings/SemanticSearchSettingsSection.ts:77
  - src/ui/settings/SemanticSearchSettingsSection.ts:129
  - src/ui/settings/SemanticSearchSettingsSection.ts:201

2) Disabling semantic search does not fully stop background work
- Impact: vector store service and index listeners can keep running after "disable", leading to unexpected indexing and resource use.
- Evidence:
  - src/ui/settings/SemanticSearchSettingsSection.ts:28
  - src/services/vector/vectorStoreService.ts:358
  - src/main.ts:87

### Medium

3) Event listeners not registered for automatic cleanup
- Impact: repeated plugin reloads can stack listeners, causing duplicated work and memory use.
- Evidence:
  - src/utils/eventHandlers.ts:13
  - src/services/vector/vectorStoreService.ts:358

4) Semantic similarity score is a placeholder
- Impact: Related Notes always shows ~90% similarity and "excellent", which is misleading and reduces trust.
- Evidence:
  - src/services/vector/voyVectorStore.ts:184
  - src/ui/views/RelatedNotesView.ts:313

### Low

5) Command picker uses hard-coded English labels
- Impact: i18n mismatch for non-English users; some UI strings are not localized.
- Evidence:
  - src/ui/modals/CommandPickerModal.ts:42
  - src/ui/modals/CommandPickerModal.ts:133
  - src/ui/modals/CommandPickerModal.ts:176
  - src/ui/modals/CommandPickerModal.ts:213
  - src/ui/modals/CommandPickerModal.ts:238
  - src/ui/modals/CommandPickerModal.ts:257

6) Command picker category color styles are never applied
- Impact: intended visual differentiation is missing.
- Evidence:
  - src/ui/modals/CommandPickerModal.ts:64
  - styles.css:1392

## UX/UI Review

### What Works
- Settings are grouped by feature area with clear headings and progression.
- Modals are consistent and use Obsidian styling tokens, which helps platform fit.
- Related Notes view presents a compact, scannable list with hover previews.

### Friction Points
- Semantic search settings can duplicate and become hard to navigate due to re-render stacking.
- Related Notes shows very high similarity regardless of true relevance, which can erode trust.
- Command picker categories are visually under-emphasized because category styling never activates.
- Several user-facing strings are hard-coded in English despite i18n support.

### UX Opportunities
- Add clear status indicators when semantic search is disabled or unconfigured (with direct link to settings).
- Improve feedback around indexing state (in-progress, last indexed, etc.).
- Use real similarity scores or a more honest label (e.g., "related") if distance is unavailable.

## SOLID / DRY / Effectiveness Notes

- Repeated "re-render by calling this.display()" inside a section without clearing the container is an anti-pattern; it breaks SRP for view rendering and causes UI duplication.
- Event listener registration is split across multiple services without a shared disposal pattern; consolidating registration through Plugin.registerEvent would improve lifecycle handling.
- Similarity scoring is a placeholder in the vector store yet drives UI semantics; this violates the "single source of truth" principle by presenting unreliable data as real.

## Open Questions

1) When semantic search is toggled off, should indexing stop completely and dispose resources?
2) Should command picker labels and instructions be localized, or intentionally kept in English?

## Testing Gaps

- No automated coverage for settings re-rendering or semantic search enable/disable lifecycle.
- No verification that event listeners are disposed on unload or feature disable.
