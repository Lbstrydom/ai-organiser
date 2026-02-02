# Tag Network Search Enhancement

## Goal
Replace the plain text input in TagNetworkView with a tag-aware search that supports autocomplete suggestions and multi-tag filtering.

## Current Behavior
- Plain `<input type="text">` with substring filter (`label.includes(term)`)
- Single term only — no way to search multiple tags simultaneously
- No suggestions or completions — user must know exact tag substring
- Graph fades non-matching nodes (opacity 0.2), zooms to matches
- Mobile list view has identical substring filter
- View has no `plugin` reference — constructor takes `(leaf, tagNetworkManager, getFiles)`
- All UI strings are hardcoded English (title, description, legend, search label, tooltips)

## Problems
1. User types partial tag name → no feedback on which tags exist
2. No way to explore the intersection of multiple tags (e.g., "show me notes tagged both `coaching` and `leadership`")
3. Search feels broken when the typed term doesn't match any tag exactly

---

## Expert Review Findings — Resolution

### HIGH: `this.plugin` doesn't exist in TagNetworkView
**Finding**: Plan snippets used `this.plugin.t.views.searchTags` but constructor is `(leaf, tagNetworkManager, getFiles)` — no plugin reference.
**Resolution**: Pass `plugin` as 4th constructor argument. This is the cleanest fix — the view needs i18n access, and threading individual strings would be messier. The caller in `main.ts` already has `this` (the plugin). One-line change at construction site.

### HIGH: Hover resets wipe search highlighting
**Finding**: `mouseout` handler (line 266-269) unconditionally resets `node.attr('opacity', 1)` and `link.attr('stroke-opacity', 0.6)`, destroying multi-tag filter state.
**Resolution**: Track active filter state. Hover applies temporary highlighting on top; mouseout restores to *filter state* (not defaults). New helper `applyFilterState()` called from both `handleSearch()` and `mouseout`:

```typescript
// Shared state
let filterState: { selectedSet: Set<string>; neighborSet: Set<string> } | null = null;

function applyFilterState() {
    if (!filterState) {
        node.attr('opacity', 1);
        labels.attr('opacity', 1);
        link.attr('stroke-opacity', 0.6);
        return;
    }
    const { selectedSet, neighborSet } = filterState;
    // ... apply multi-tag opacities (same as handleSearch body)
}

// mouseout now restores filter state instead of hardcoded defaults
node.on('mouseout', () => {
    applyFilterState();
    tooltip.removeClass('visible');
});
```

### HIGH: Tag ID vs label mismatch
**Finding**: Node `id = data.tag` (raw from frontmatter, may include `#`), `label = tag.replace('#', '')`. Edges use `data.tag` as source/target. If chips store labels, filtering against edge IDs silently fails.
**Resolution**: Chips store **node IDs** internally, display **labels** in the UI. All Set comparisons use `.id`. Dropdown items render `node.label` but carry `node.id` as data attribute.

### MEDIUM: No `views` section in i18n types
**Finding**: Plan added keys under a `views` section that doesn't exist in `types.ts`.
**Resolution**: Add keys under the existing `fileMenu` section (which already has `tagNetwork`) or create a new `tagNetwork` section under the top-level `Translations` interface. Given there are 10+ strings to add (not just 3 — see next finding), a dedicated `tagNetwork` section is cleaner:

```typescript
tagNetwork: {
    title: string;
    description: string;
    searchPlaceholder: string;
    noMatchingTags: string;
    coOccurringTags: string;
    legendFrequency: string;
    legendLow: string;
    legendMedium: string;
    legendHigh: string;
    tooltipFrequency: string;
    tooltipConnections: string;
    loadingVisualization: string;
    loadFailed: string;
};
```

### MEDIUM: Hardcoded strings throughout TagNetworkView
**Finding**: Title ("Tag Network Visualization"), description, legend labels ("Low"/"Medium"/"High"), tooltip text ("Frequency:", "Connected to"), search label, status messages — all hardcoded English.
**Resolution**: Since we're modifying the view anyway and now have plugin access, convert ALL hardcoded strings to i18n in the same pass. This is ~13 strings total. Leaving mixed-language UI would be a regression.

### MEDIUM: Dropdown CSS positioning
**Finding**: `.tag-network-search` has no `position: relative`, so `position: absolute` on dropdown anchors to wrong parent.
**Resolution**: Add `position: relative` to `.tag-network-search` in CSS. The dropdown then positions correctly relative to the search container.

### MEDIUM: Event cleanup
**Finding**: All new event listeners (input, keydown, click-outside, chip clicks) need teardown via `this.cleanup.push()`.
**Resolution**: Every `addEventListener` call gets a corresponding cleanup push. The click-outside handler uses a single `document.addEventListener('click', ...)` with cleanup.

### LOW: No unit tests
**Finding**: Plan was manual-test only.
**Resolution**: Add `tests/tagNetworkSearch.test.ts` with tests for:
- Suggestion filtering (substring match, frequency sort, exclude selected)
- Multi-tag graph filter set computation (selected, neighbor, edge classification)
- Chip add/remove state management

Extract the pure logic (suggestion filtering, filter set computation) into testable functions rather than inline closures.

---

## Design

### Token-based Multi-Tag Input

Replace the single text input with a **chip/token input pattern**:

- User types → **suggestion dropdown** appears showing matching tags sorted by frequency
- User selects a tag (click or Enter) → becomes a **chip** (pill/badge) before the input
- Continue typing to add more tags
- Each chip has × button to remove; Backspace on empty input removes last chip
- Input auto-focuses after chip add/remove

**Filter logic:**
- Single tag: highlight tag + direct neighbors (shows local network)
- Multiple tags: highlight ALL selected tags + edges between them emphasized + their neighbors dimmed
- OR mode (not AND) — intersection would often show nothing for unrelated tags
- No explicit AND/OR toggle — OR is the right default for exploration. The graph itself visually shows whether selected tags co-occur (thick edge between them) or not (no connecting edge).

### Suggestion Dropdown

- Appears when ≥1 character typed
- Filtered by substring match on **label** (case-insensitive)
- Shows tag label + frequency count (e.g., `coaching (12)`)
- Max 8 visible items (scrollable)
- ↑/↓ keyboard navigation, Enter confirms, Escape closes
- Already-selected tags excluded
- Items carry `data-id` attribute (node ID) for correct selection

### Graph Highlighting (Multi-tag)

```
Selected tags:     opacity 1.0
Neighbor tags:     opacity 0.7
Everything else:   opacity 0.15

Edges between two selected tags:  stroke-opacity 1.0
Edges from selected to neighbor:  stroke-opacity 0.5
All other edges:                  stroke-opacity 0.05
```

Hover temporarily overrides (shows hovered node's local network). Mouseout restores filter state.

Zoom-to-fit centers on all selected tags.

### Mobile List (Multi-tag)

- Same chip input pattern
- Filter shows tags that are direct neighbors of ANY selected tag (graph edges)
- Shows co-occurrence info inline ("appears with: X, Y, Z")

---

## Files to Modify

| File | Change |
|------|--------|
| `src/ui/views/TagNetworkView.ts` | Add `plugin` to constructor. Replace `buildSearchInput()` with chip+dropdown. Extract `applyFilterState()`. Fix hover/mouseout to respect filter. Convert all hardcoded strings to i18n. |
| `src/utils/tagNetworkUtils.ts` | No changes needed (data model is fine) |
| `src/main.ts` | Pass `this` (plugin) as 4th arg to TagNetworkView constructor |
| `styles.css` | Add `tag-network-chip-*`, `tag-network-dropdown-*` classes. Add `position: relative` to `.tag-network-search`. |
| `src/i18n/types.ts` | Add `tagNetwork` section (~13 keys) |
| `src/i18n/en.ts` | English strings |
| `src/i18n/zh-cn.ts` | Chinese strings |
| `tests/tagNetworkSearch.test.ts` | New: suggestion filter + graph filter set logic tests |

---

## Implementation Detail

### Constructor change

```typescript
// TagNetworkView.ts
private plugin: AIOrganiserPlugin;

constructor(
    leaf: WorkspaceLeaf,
    tagNetworkManager: TagNetworkManager,
    getFiles: () => TFile[],
    plugin: AIOrganiserPlugin
) {
    super(leaf);
    this.plugin = plugin;
    // ... existing init
}
```

```typescript
// main.ts — construction site (pass `this`)
new TagNetworkView(leaf, this.tagNetworkManager, () => this.app.vault.getMarkdownFiles(), this);
```

### Constants (no magic numbers)

```typescript
/** Max suggestions shown in dropdown */
const MAX_DROPDOWN_SUGGESTIONS = 8;

/** Opacity values for graph highlighting */
const OPACITY_SELECTED = 1;
const OPACITY_NEIGHBOR = 0.7;
const OPACITY_FADED = 0.15;
const EDGE_OPACITY_BOTH_SELECTED = 1;
const EDGE_OPACITY_ONE_SELECTED = 0.5;
const EDGE_OPACITY_NONE = 0.05;
const EDGE_OPACITY_DEFAULT = 0.6;
```

### Testable pure functions (extracted)

```typescript
// Exported from TagNetworkView.ts for testability

interface TagSuggestion { id: string; label: string; frequency: number; }

/** Filter and rank tag suggestions for dropdown */
function filterSuggestions(
    allNodes: NetworkNode[],
    term: string,
    selectedIds: Set<string>,
    maxResults: number = 8
): TagSuggestion[] {
    const lowerTerm = term.toLowerCase();
    return allNodes
        .filter(n => !selectedIds.has(n.id) && n.label.toLowerCase().includes(lowerTerm))
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, maxResults)
        .map(n => ({ id: n.id, label: n.label, frequency: n.frequency }));
}

/** Compute filter sets for multi-tag highlighting */
function computeFilterSets(
    selectedIds: Set<string>,
    edges: NetworkEdge[]
): { neighborSet: Set<string>; } {
    const neighborSet = new Set<string>();
    for (const edge of edges) {
        if (selectedIds.has(edge.source)) neighborSet.add(edge.target);
        if (selectedIds.has(edge.target)) neighborSet.add(edge.source);
    }
    // Don't include selected tags in neighbor set
    for (const id of selectedIds) neighborSet.delete(id);
    return { neighborSet };
}
```

### `applyFilterState()` — hover-safe highlighting

```typescript
let filterState: { selectedSet: Set<string>; neighborSet: Set<string> } | null = null;

function applyFilterState() {
    if (!filterState) {
        node.attr('opacity', 1);
        labels.attr('opacity', 1);
        link.attr('stroke-opacity', 0.6);
        return;
    }
    const { selectedSet, neighborSet } = filterState;
    node.attr('opacity', (d: NetworkNode) =>
        selectedSet.has(d.id) ? 1 : neighborSet.has(d.id) ? 0.7 : 0.15
    );
    labels.attr('opacity', (d: NetworkNode) =>
        selectedSet.has(d.id) ? 1 : neighborSet.has(d.id) ? 0.7 : 0.15
    );
    link.attr('stroke-opacity', (l: any) => {
        const srcSel = selectedSet.has(l.source.id);
        const tgtSel = selectedSet.has(l.target.id);
        if (srcSel && tgtSel) return 1;
        if (srcSel || tgtSel) return 0.5;
        return 0.05;
    });
}

// handleSearch sets filterState then calls applyFilterState()
// mouseout calls applyFilterState() instead of hardcoded resets
```

### Chip management (~40 LOC)

- `addChip(state, nodeId)`: Create chip element with label + × button, push to `selectedTags`, clear input, call `onUpdate()`
- `removeChip(state, nodeId)`: Remove chip element, splice from `selectedTags`, call `onUpdate()`
- Chips stored as `{ id: string, el: HTMLElement }[]` for efficient removal

### Event wiring (~60 LOC)

All listeners registered with cleanup:

```typescript
const onInput = () => { /* filter & render dropdown */ };
const onKeydown = (e: KeyboardEvent) => { /* ↑↓ Enter Escape Backspace */ };
const onClickOutside = (e: MouseEvent) => { /* close dropdown if click outside */ };

input.addEventListener('input', onInput);
input.addEventListener('keydown', onKeydown);
document.addEventListener('click', onClickOutside);

this.cleanup.push(() => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onClickOutside);
});
```

### CSS (~45 LOC)

```css
.tag-network-search {
    position: relative;  /* anchor for dropdown */
}
.tag-network-chip-container {
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px; padding: 4px 8px;
    background: var(--background-primary); min-height: 30px;
}
.tag-network-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 12px; font-size: 12px;
    background: var(--interactive-accent); color: var(--text-on-accent);
    max-width: 150px;
}
.tag-network-chip-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tag-network-chip-remove { cursor: pointer; opacity: 0.7; }
.tag-network-chip-remove:hover { opacity: 1; }
.tag-network-chip-container input {
    border: none; outline: none; background: transparent;
    flex: 1; min-width: 80px; font-size: 13px;
}
.tag-network-dropdown {
    position: absolute; z-index: 10; left: 0; right: 0;
    top: 100%; margin-top: 2px;
    max-height: 200px; overflow-y: auto;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.tag-network-dropdown-item {
    padding: 6px 12px; cursor: pointer; font-size: 13px;
    display: flex; justify-content: space-between;
}
.tag-network-dropdown-item:hover,
.tag-network-dropdown-item.active {
    background: var(--background-modifier-hover);
}
.tag-network-dropdown-freq {
    color: var(--text-muted); font-size: 11px;
}
```

### i18n Strings (~13 keys)

```typescript
// types.ts — new top-level section
tagNetwork: {
    title: string;
    description: string;
    searchPlaceholder: string;
    noMatchingTags: string;
    coOccurringTags: string;
    legendFrequency: string;
    legendLow: string;
    legendMedium: string;
    legendHigh: string;
    tooltipFrequency: string;
    tooltipConnections: string;
    loadingVisualization: string;
    loadFailed: string;
};

// en.ts
tagNetwork: {
    title: "Tag Network Visualization",
    description: "Node size represents tag frequency. Connections represent tags that appear together in notes.",
    searchPlaceholder: "Type to find tags...",
    noMatchingTags: "No matching tags",
    coOccurringTags: "Co-occurring tags",
    legendFrequency: "Frequency:",
    legendLow: "Low",
    legendMedium: "Medium",
    legendHigh: "High",
    tooltipFrequency: "Frequency",
    tooltipConnections: "Connected to {count} other tags",
    loadingVisualization: "Loading visualization...",
    loadFailed: "Failed to load visualization library. Please check your internet connection.",
},

// zh-cn.ts
tagNetwork: {
    title: "标签网络可视化",
    description: "节点大小代表标签频率。连接代表在笔记中同时出现的标签。",
    searchPlaceholder: "输入以查找标签...",
    noMatchingTags: "没有匹配的标签",
    coOccurringTags: "共现标签",
    legendFrequency: "频率：",
    legendLow: "低",
    legendMedium: "中",
    legendHigh: "高",
    tooltipFrequency: "频率",
    tooltipConnections: "与 {count} 个其他标签相连",
    loadingVisualization: "正在加载可视化...",
    loadFailed: "无法加载可视化库。请检查网络连接。",
},
```

---

## DRY / SOLID / No-Hardcoding Principles

### No Hardcoding
- **All 13 UI strings** converted to i18n (currently hardcoded English in TagNetworkView)
- **Dropdown max results** (8) extracted to `MAX_DROPDOWN_SUGGESTIONS` constant
- **Opacity values** extracted to named constants: `OPACITY_SELECTED = 1`, `OPACITY_NEIGHBOR = 0.7`, `OPACITY_FADED = 0.15`, `EDGE_OPACITY_BOTH_SELECTED = 1`, `EDGE_OPACITY_ONE_SELECTED = 0.5`, `EDGE_OPACITY_NONE = 0.05`, `EDGE_OPACITY_DEFAULT = 0.6`
- **Chip max-width** (150px) in CSS only — no magic number in TS
- **Tooltip `{count}` placeholder** uses `.replace('{count}', ...)` pattern consistent with existing i18n (e.g., `indexBuildComplete` uses `{indexed}`)

### DRY
- **`filterSuggestions()`** — single function for both desktop dropdown and mobile list filtering (same substring + frequency sort logic)
- **`computeFilterSets()`** — single function for both `handleSearch()` and mobile list neighbor computation
- **`applyFilterState()`** — single function called from `handleSearch()`, `mouseout`, and `onResize` recovery (no duplicated opacity-setting code)
- **TagPickerModal** was evaluated for reuse — it extends `FuzzySuggestModal` (Obsidian built-in, single-select, modal overlay), not suitable for inline multi-select chips. No DRY concern.

### SOLID
- **SRP**: Pure logic (`filterSuggestions`, `computeFilterSets`) separated from DOM manipulation (chip rendering, D3 updates). Each is independently testable.
- **OCP**: `filterSuggestions` accepts `maxResults` parameter — callers can adjust without modifying the function.
- **DIP**: `handleSearch` depends on `filterState` interface, not concrete D3 implementation. Pure functions take `NetworkNode[]` and `NetworkEdge[]` — no D3 dependency.
- **ISP**: `TagSearchState` interface contains only what chip/dropdown management needs — no view lifecycle concerns leaked in.

---

## Open Questions — Resolved

**Q: Should chips store node IDs or labels?**
A: **IDs** internally, display **labels**. All Set operations use `.id`. Dropdown items carry `data-id`.

**Q: AND/OR toggle for multi-tag mode?**
A: **No toggle.** OR is the right default for exploration. The graph visually shows co-occurrence (thick edge between selected tags = they appear together). An explicit toggle adds UI complexity for minimal value.

**Q: Mobile "Co-occurring tags" — graph edges or note-level intersection?**
A: **Graph edges** (direct connections from `networkData.edges`). This is consistent with the desktop view and requires no additional computation. The edge weight already represents note-level co-occurrence count.

---

## Scope

| Component | LOC |
|-----------|-----|
| Constructor change + plugin threading | ~10 |
| Constants (opacity, dropdown limit) | ~10 |
| `filterSuggestions()` + `computeFilterSets()` (pure, exported) | ~30 |
| `buildTagSearchInput()` + chip management | ~80 |
| `wireTagSearchEvents()` | ~60 |
| `applyFilterState()` + updated hover/mouseout | ~40 |
| Updated `handleSearch()` (desktop) | ~20 |
| Updated `renderList()` (mobile) | ~20 |
| i18n conversion of hardcoded strings | ~30 |
| CSS | ~45 |
| i18n keys (13 × 2 languages + types) | ~50 |
| Tests (`tagNetworkSearch.test.ts`) | ~60 |
| **Total** | **~445** |

Net: ~445 new, ~80 removed (old search + hardcoded strings) = **~365 net LOC**.

---

## Verification

### Unit Tests (`tests/tagNetworkSearch.test.ts`)
- `filterSuggestions` — substring match, frequency sort, excludes selected, respects maxResults
- `filterSuggestions` — empty term returns nothing, no crash on empty nodes
- `computeFilterSets` — single tag computes correct neighbors
- `computeFilterSets` — multiple tags union neighbors, exclude selected from neighbor set
- `computeFilterSets` — no edges returns empty neighbor set

### Manual Testing
- [ ] Type partial tag → dropdown shows matching tags sorted by frequency
- [ ] Click suggestion → chip appears, input clears, graph highlights tag + neighbors
- [ ] Hover a node while filter active → temporary highlight, mouseout restores filter
- [ ] Type second tag → dropdown excludes first, shows remaining matches
- [ ] Select second tag → graph shows both + neighborhoods, edges between them emphasized
- [ ] Click × on chip → removed, graph updates
- [ ] Backspace on empty input → removes last chip
- [ ] ↑/↓ navigate dropdown, Enter selects, Escape closes
- [ ] Clear all chips → graph returns to default
- [ ] Click outside dropdown → closes
- [ ] Mobile: chip input works, list filters correctly
- [ ] Chinese language: all 13 strings render correctly

### Build
- [ ] `npm run build` passes (type-check + tests + bundle)
- [ ] No regressions in existing tests

### Edge Cases
- [ ] Long tag names: chip truncates with ellipsis (max-width: 150px)
- [ ] Vault with 0 tags → input renders, dropdown empty
- [ ] 500+ tags → dropdown caps at 8, scroll works
- [ ] Nested tags (`science/biology`) work with substring match
- [ ] Tags with `#` prefix: ID includes `#`, label strips it — chips display correctly
- [ ] onResize triggers re-render → cleanup disposes old listeners, new ones attached
