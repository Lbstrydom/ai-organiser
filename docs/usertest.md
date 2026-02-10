# AI Organiser - Manual Test Checklist

**Version:** 1.0.15
**Full Test Time:** ~30 minutes
**Quick Smoke Test:** ~10 minutes (sections marked with *)

---

## Pre-Test *

- [ ] `npm run build:quick` passes
- [ ] Files deployed: `main.js`, `manifest.json`, `styles.css`
- [ ] Obsidian restarted, plugin enabled

---

## 1. Settings UI (3 min) *

### Section Order & Visual Hierarchy
- [ ] Open Settings → AI Organiser
- [ ] 10 collapsible sections visible (AI Provider open by default, rest collapsed)
- [ ] Expand each section — no visual duplication or layout issues
- [ ] Meeting Minutes section contains: Output folder, Timezone, Default persona, Obsidian Tasks toggle, **GTD overlay toggle**

### Settings Functionality
- [ ] Toggle Semantic Search ON/OFF 3× → no duplicate UI elements
- [ ] API key shows masked format: `sk-abc•••••••`
- [ ] Provider dropdown changes available models
- [ ] "Test Connection" button works

---

## 2. Command Picker (2 min) *

- [ ] Ctrl+P → "AI Organiser" or ribbon icon → Command Picker opens
- [ ] Fuzzy search works (type "tag" → finds tagging commands)
- [ ] Categories visible: Active Note, Capture, Vault Intelligence, Tools & Workflows
- [ ] Keyboard navigation works (↑↓, ↵, Esc)
- [ ] No "undefined" or raw i18n keys visible

---

## 3. Tagging (2 min) *

- [ ] Open note → "Tag this note" → tags in frontmatter (kebab-case)
- [ ] "Clear tags" → tags removed, frontmatter preserved

---

## 4. Summarization (3 min) *

Pick ONE source type:

- [ ] URL/YouTube/PDF/Audio → "Smart Summarize" → preview modal appears
- [ ] **Insert at cursor** / **Copy** / **Discard** buttons work
- [ ] LLM spinner visible during processing, gone before modal opens

### Multi-Source
- [ ] Note with multiple sources → modal shows detected sources with checkboxes

---

## 5. Translation (2 min)

- [ ] Open note → "Translate Note" → language picker → translated
- [ ] Select text → "Translate selection" → only selection translated

---

## 6. Smart Note Features (2 min)

- [ ] "Enhance note" → Improve / Diagram / Resources / Flashcards picker
- [ ] At least one option produces output

### Improve Note — Placement
- [ ] **Replace** (default) → preview → "Replace note" → body replaced
- [ ] **Insert at cursor** → content at cursor, original untouched
- [ ] **Create new note** → new file created, original untouched

---

## 7. Meeting Minutes (5 min)

### Basic Generation
- [ ] "Create Meeting Minutes" → modal opens
- [ ] **Persona dropdown shows 2 options**: Standard (default), Governance
- [ ] Fill: Title, Date, Participants, Transcript → Generate → note created
- [ ] Check frontmatter: `meeting_date`, `attendees` (clean names)

### GTD Overlay
- [ ] GTD toggle visible in modal (after detail-level dropdown)
- [ ] GTD toggle default matches Settings → Meeting Minutes → GTD overlay
- [ ] Enable GTD → generate minutes → output contains `## GTD: Next Actions`
- [ ] Next actions grouped by context (e.g., `**@office**`, `**@call**`)
- [ ] Context groups sorted alphabetically
- [ ] When both GTD + Obsidian Tasks enabled → next-actions render as `- [ ]` checkboxes
- [ ] With GTD disabled → no GTD sections in output
- [ ] Waiting-for items show `waiting on: {person}` with optional chase date
- [ ] Projects and Someday/Maybe lists render when present

### Output Folder Override
- [ ] "Output folder" button → folder picker → select or create folder
- [ ] Generate minutes → file created in chosen folder

### Context Documents
- [ ] Add document via "Add Document" → included in minutes context
- [ ] Oversized documents show truncation controls

### Terminology Dictionary
- [ ] Create/load dictionary → terms improve output consistency
- [ ] Extract terms from documents → populates dictionary

---

## 8. Semantic Search / RAG (3 min)

### Setup & Related Notes
- [ ] Enable Semantic Search → select provider → "Build Index"
- [ ] "Related Notes" sidebar shows similar notes with color-coded badges
- [ ] Folder scope works (auto-follows, pins, unpin)

### Search Commands
- [ ] "Semantic Search" → search modal works
- [ ] "Chat with AI" → unified chat with Note/Vault/Highlight tabs

---

## 9. Integrations (3 min)

### Bases
- [ ] "Upgrade metadata" → migration works
- [ ] "Create dashboard" → `.base` file created with folder filtering

### NotebookLM
- [ ] Select notes → status bar count → export → PDF source pack created

### Pending Integration
- [ ] "Integrate pending content" → 3 strategy dropdowns + auto-tag toggle
- [ ] At least one placement strategy produces correct output

---

## 10. Canvas Toolkit (2 min) - Desktop Only

- [ ] **Context Board** (fastest — no RAG needed): note with links/embeds → canvas created
- [ ] **Investigation Board** (requires semantic search): related notes canvas
- [ ] **Cluster Board**: tag picker → grouped canvas

---

## 11. Configuration Files (2 min)

- [ ] Open `AI-Organiser/Config/` folder in vault
- [ ] Files present:
  - [ ] `taxonomy.md` - Tag taxonomy
  - [ ] `excluded-tags.md` - Tags to never suggest
  - [ ] `writing-personas.md` - 5 personas (brief, study, business-operator, feynman, learning-insight)
  - [ ] `summary-personas.md` - 5 personas (same IDs as writing)
  - [ ] `minutes-personas.md` - **2 personas** (standard, governance)
  - [ ] `bases-templates.md` - Dashboard templates
- [ ] Dictionaries folder: `AI-Organiser/Config/dictionaries/`
- [ ] Edit persona file → changes reflected in dropdowns

---

## 12. Provider Quick Test *

| Check | Pass |
|-------|------|
| Connection test passes | [ ] |
| Tag generation works | [ ] |
| Summarization works | [ ] |

---

## 13. Mobile-Specific (if testing on mobile)

- [ ] Plugin loads without errors
- [ ] Cloud provider works
- [ ] Touch interactions work (modals, settings)

---

## Issues Found

| Severity | Section | Issue | Steps to Reproduce |
|----------|---------|-------|-------------------|
| | | | |

**Severity:** Critical (crash/data loss) > High (broken feature) > Medium (partial/confusing) > Low (cosmetic)

---

## Environment

| Property | Value |
|----------|-------|
| Obsidian Version | |
| OS | |
| Plugin Version | 1.0.15 |
| AI Provider | |
| Test Date | |

---

## Quick Smoke Test Checklist

Sections marked with *:

1. [ ] Pre-Test (build, deploy, restart)
2. [ ] Settings UI (collapsible sections, GTD toggle in Minutes)
3. [ ] Command Picker (opens, categories visible)
4. [ ] Tagging (generate + clear)
5. [ ] Summarization (one source + preview modal + spinner)
6. [ ] Canvas (Context Board — no RAG needed)
7. [ ] Provider Test (connection + one operation)

**Smoke Test Pass:** All 7 checked = Ready for release
