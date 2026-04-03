# File Format Conventions

This document records convention alignment for the three Obsidian file formats
this plugin generates: JSON Canvas (`.canvas`), Obsidian Bases (`.base`), and
Obsidian Flavored Markdown (`.md`).

## Authoritative References

- **JSON Canvas 1.0 Spec**: https://jsoncanvas.org/spec/1.0/
- **Obsidian Agent Skills** (kepano/Steph Ango): https://github.com/kepano/obsidian-skills
  - Canvas skill: `skills/json-canvas/SKILL.md`
  - Bases skill: `skills/obsidian-bases/SKILL.md`
  - Markdown skill: `skills/obsidian-markdown/SKILL.md`
- **Agent Skills Specification**: https://agentskills.io/specification

### For AI agents working in this repo

Install the official Obsidian skills for format reference when working with
Obsidian vault files:

```
/plugin marketplace add kepano/obsidian-skills
/plugin install obsidian@obsidian-skills
```

---

## JSON Canvas (.canvas)

**Implementation**: `src/services/canvas/` (canvasUtils.ts, layouts.ts, types.ts, three board files)

### Audited Items

| Item | Our Implementation | Convention/Spec | Status |
|------|--------------------|-----------------|--------|
| ID format | 16-char lowercase hex via `crypto.getRandomValues` (fallback: base36) | Obsidian uses 16-char lowercase hex. Spec requires only unique strings. | Aligned |
| Node types | `file`, `text`, `link`, `group` | All four spec types | Aligned |
| Edge sides | `top`, `right`, `bottom`, `left` via `computeEdgeSides()` | Four cardinal sides per spec | Aligned |
| Edge ends | Not set (defaults to `none`) | `none` or `arrow`; default `none` | Aligned |
| Colors | Preset strings `'1'` through `'6'` | 6 preset indices or hex strings | Aligned |
| Node spacing | `NODE_GAP = 60px` | Skills recommend 50-100px | Within range |
| Group padding | `GROUP_PADDING = 40px` | Skills recommend 20-50px | Within range |
| Default node size | 400 x 200px | No strict requirement | Reasonable |
| JSON structure | `{ nodes: [], edges: [] }` with 2-space indent | Top-level `nodes` and `edges` arrays | Aligned |
| Z-ordering | Array position determines layering | First = bottom, last = top per spec | Aligned |

### Not yet audited

- Maximum node count / coordinate limits (no known constraint in spec)
- `backgroundStyle` on group nodes (we don't set it; defaults fine)
- `subpath` on file nodes (we don't use heading/block subpaths)

---

## Obsidian Bases (.base)

**Implementation**: `src/services/dashboardService.ts`, `src/services/configurationService.ts`

### Audited Items

| Item | Our Implementation | Convention/Spec | Status |
|------|--------------------|-----------------|--------|
| Filter key | `filters:` (plural) | Must be `filters:` not `filter:` | Aligned |
| Folder filtering | `file.inFolder("path")` | File function for recursive folder match | Aligned |
| Logical operators | `and:` / `or:` with array syntax | YAML array under operator key | Aligned |
| Property access | `property.status`, `property.summary` | `property.<name>` syntax | Aligned |
| Comparison | `==`, `!=` | Standard comparison operators | Aligned |
| Columns | Array of `property.<name>` strings | Column references | Aligned |

### Not yet audited

- Formula syntax (`if()`, arithmetic, date functions)
- View types beyond default table (cards, list, map)
- Summary/rollup formulas
- Advanced list functions (`.filter()`, `.map()`, `.reduce()`)

---

## Obsidian Flavored Markdown (.md)

**Implementation**: `src/utils/editorUtils.ts`, `src/utils/frontmatterUtils.ts`, various prompt files

### Audited Items

| Item | Our Implementation | Convention/Spec | Status |
|------|--------------------|-----------------|--------|
| Frontmatter | YAML between `---` delimiters via `js-yaml` | Standard YAML frontmatter | Aligned |
| Callouts | `> [!info]`, `> [!note]` syntax | Obsidian callout syntax | Aligned |
| Wikilinks | `[[Note]]` syntax in generated output | Standard Obsidian wikilinks | Aligned |
| Tags | `#tag`, `#nested/tag` in frontmatter arrays | Inline and frontmatter tags | Aligned |
| Embeds | `![[file]]` for images, audio, documents | Standard Obsidian embed syntax | Aligned |
| Task format | `- [ ] Task` / `- [x] Done` | Standard checkbox syntax | Aligned |

### Not yet audited

- Math blocks (`$...$`, `$$...$$`)
- Mermaid diagram generation (used in digitisation output)
- Footnote syntax
- Block references (`^block-id`)

---

## Audit Metadata

- **Last verified**: 2026-02-08
- **Commit**: `123f9dd` (pre-convention-alignment changes)
- **Methodology**: Manual comparison of source code against kepano/obsidian-skills SKILL.md files and JSON Canvas 1.0 spec
