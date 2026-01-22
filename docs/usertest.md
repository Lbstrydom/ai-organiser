# AI Organiser - Quick Test Checklist

**Version:** 1.0.15
**Focus:** Obsidian Bases Integration + Audit fixes + Note Structure + Language improvements

---

## Pre-Test Setup

- [ ] Run `npm run build`
- [ ] Copy `main.js`, `manifest.json`, `styles.css` to Obsidian plugin folder
- [ ] Restart Obsidian
- [ ] Enable plugin

---

## 1. Audit Fixes

### 1.1 Settings Re-render (HIGH)

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| No duplicate UI | Toggle semantic search on/off 5 times | No duplicate settings blocks | [ ] |
| Clean redraw | Change embedding provider multiple times | Settings refresh cleanly | [ ] |

### 1.2 Semantic Search Disable Cleanup (HIGH)

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Stop indexing | Disable semantic search | Console shows no indexing activity | [ ] |
| Resources freed | Disable, check memory | No memory growth | [ ] |
| Re-enable works | Disable then enable | Semantic search works again | [ ] |

### 1.3 Similarity Display (MEDIUM)

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Related badge | Open Related Notes panel | Shows "Related" not "90%" | [ ] |
| No fake scores | Check multiple results | All show "Related" badge | [ ] |

---

## 2. Note Structure Feature

### 2.1 Settings Toggle

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Setting exists | Open Settings > Tagging | "Add Note Sections" toggle visible | [ ] |
| Default on | Fresh install | Toggle is ON by default | [ ] |
| Persists | Toggle off, restart | Setting stays off | [ ] |

### 2.2 Sections Added After Commands

Test each command with "Add Note Sections" enabled:

| Command | Test Note | Has Sections After? | Pass |
|---------|-----------|---------------------|------|
| Tag this note | Any note | [ ] |
| Tag folder | Folder with notes | [ ] |
| Summarize URL | Note with URL | [ ] |
| Summarize PDF | Note | [ ] |
| Summarize YouTube | Note | [ ] |
| Summarize audio | Note | [ ] |
| Translate note | Note with content | [ ] |
| Translate selection | Selected text | [ ] |
| Improve with AI | Note with content | [ ] |
| Create diagram | Note with content | [ ] |
| Generate from embedded | Note with embeds | [ ] |
| Ask about note | Note with content | [ ] |
| Insert related notes | Note with content | [ ] |
| Clear tags (note) | Tagged note | [ ] |

### 2.3 Sections NOT Added When Disabled

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Disable setting | Turn off "Add Note Sections" | | |
| Run tag command | Tag a note | No sections added | [ ] |
| Run summarize | Summarize URL | No sections added | [ ] |

### 2.4 No Duplicates

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Existing sections | Note already has References | No duplicate sections | [ ] |
| Multiple commands | Run 3 commands on same note | Still only 1 of each section | [ ] |

---

## 3. Language & UI Improvements

### 3.1 Settings Labels

| Section | Check | Pass |
|---------|-------|------|
| AI Provider | Concise labels, no jargon | [ ] |
| Language | Clear descriptions | [ ] |
| Tagging | Brief tooltips | [ ] |
| Summarization | Readable options | [ ] |
| Semantic Search | Understandable settings | [ ] |
| Advanced | Clean config section | [ ] |

### 3.2 Support Section Removed

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| No coffee button | Open Settings | No "Buy me a coffee" section | [ ] |

### 3.3 Command Names

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Command palette | Ctrl+P, browse commands | Short, clear command names | [ ] |
| No redundancy | Check command list | No repeated words | [ ] |

### 3.4 Notifications

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Success messages | Complete any action | Brief confirmation | [ ] |
| Error messages | Trigger an error | Clear, actionable message | [ ] |
| Progress messages | Run batch operation | Shows progress concisely | [ ] |

---

## 4. Obsidian Bases Integration (NEW)

### 4.1 Settings Section

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Section exists | Settings > Obsidian Bases | Section visible between Semantic Search and Mobile | [ ] |
| Enable toggle | Check "Enable Structured Metadata" | Toggle is ON by default | [ ] |
| Model toggle | Check "Include Model in Metadata" | Toggle is ON by default | [ ] |
| Content type toggle | Check "Auto-detect Content Type" | Toggle is ON by default | [ ] |
| Info box | Check info box text | Shows 3 bullet points with guidance | [ ] |
| Migrate button | Check "Migrate" button (database icon) | Button visible and clickable | [ ] |
| Dashboard button | Check "Create Dashboards" button (layout icon) | Button visible and clickable | [ ] |

### 4.2 Structured Metadata in Summarization

Test with "Enable Structured Metadata" ON:

| T6st | Steps | Expected | Pass |
|------|-------|----------|------|
| URL summary metadata | Summarize a URL | Frontmatter has `aio_summary`, `aio_status`, `aio_type`, `aio_processed`, `aio_source`, `aio_source_url` | [ ] |
| PDF summary metadata | Summarize a PDF | Frontmatter has all `aio_*` properties | [ ] |
| YouTube metadata | Summarize YouTube video | Frontmatter includes `aio_source: youtube` | [ ] |
| Audio metadata | Summarize audio file | Frontmatter includes `aio_source: audio` | [ ] |
| Summary hook length | Check `aio_summary` value | Max 280 characters, ends at sentence boundary | [ ] |
| Model tracking | Check `aio_model` property | Shows model name (e.g., 'gpt-4o', 'claude-3-5-sonnet') | [ ] |
| Content type detection | Check `aio_type` | Correctly detected (note/research/meeting/project/reference) | [ ] |
| Word count | Check `aio_word_count` | Approximate count is reasonable | [ ] |
| Status value | Check `aio_status` | Set to 'processed' | [ ] |
| Suggested tags | Check if tags added | Suggested tags from JSON added to frontmatter | [ ] |

### 4.3 Migration Modal - Analysis Stage

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Open via button | Settings > Bases > "Migrate" button | Modal opens to analysis stage | [ ] |
| Open via command | Cmd Palette > "Upgrade Vault Metadata" | Modal opens, analyzing vault | [ ] |
| Folder scope | Cmd Palette > "Upgrade Folder Metadata" | Modal analyzes current folder only | [ ] |
| Analysis stats | Wait for analysis | Shows: Total Notes, Needs Migration, Already Migrated | [ ] |
| Zero migration | Test with migrated vault | Shows "No migration needed" with Close button | [ ] |
| Next button | Click Next (when needed) | Advances to Options stage | [ ] |
| Cancel button | Click Cancel | Modal closes, no changes | [ ] |
| Analysis error | Disconnect/corrupt vault | Shows error message with details | [ ] |

### 4.4 Migration Modal - Options Stage

| Test | Steps | Expected | Pass |
|-Bases Integration | /84 | | NEW - Structured metadata, migration, dashboards |
| Core Features | /9 | | |
| Providers | /6 | | |
| **TOTAL** | /133e | Check "Overwrite existing metadata" | Checkbox toggles on/off | [ ] |
| Extract toggle | Check "Extract summary from content" | Checkbox toggles on/off | [ ] |
| Info text | Read info box | Explains what migration does | [ ] |
| Back button | Click Back | Returns to Analysis stage | [ ] |
| Start button | Click "Start Migration" | Advances to Progress stage | [ ] |

### 4.5 Migration Modal - Progress Stage

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Progress display | Start migration | Shows progress bar + status text | [ ] |
| Live updates | Watch migration | Status shows "Processing X/Y: filename" | [ ] |
| Progress bar | Watch migration | Progress bar fills from 0% to 100% | [ ] |
| Completion | Wait for finish | Advances to Results stage | [ ] |
| Error handling | Force error (disconnect API) | Shows error message, can close modal | [ ] |

### 4.6 Migration Modal - Results Stage

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Results screen | Complete migration | Shows summary stats | [ ] |
| Processed count | Check stats | Shows number of notes processed | [ ] |
| Updated count | Check stats | Shows number of notes updated | [ ] |
| Skipped count | Check stats | Shows number of notes skipped | [ ] |
| Errors count | Check stats | Shows number of errors (if any) | [ ] |
| Error list | If errors occurred | Shows first 10 errors with filenames | [ ] |
| Completion notice | Check notice | Shows "Migration completed" message | [ ] |
| Close button | Click Close | Modal closes | [ ] |

### 4.7 Migration Data Validation

After running migration, check several notes:

| Test | Expected | Pass |
|------|-------|----------|
| Summary extracted | Notes with ##Summary section have `aio_summary` | [ ] |
| TL;DR extracted | Notes with ##TL;DR have `aio_summary` | [ ] |
| First paragraph | Notes without sections use first paragraph | [ ] |
| Status detection | Notes with existing tags have `aio_status: processed` | [ ] |
| Status pending | Notes without tags have `aio_status: pending` | [ ] |
| Type detection | Research notes have `aio_type: research` | [ ] |
| Type detection | Meeting notes have `aio_type: meeting` | [ ] |
| Type detection | Project notes have `aio_type: project` | [ ] |
| Existing preserved | Non-AIO frontmatter preserved unchanged | [ ] |

### 4.8 Dashboard Creation Modal

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Open via button | Settings > Bases > "Create Dashboards" | Modal opens with template picker | [ ] |
| Open via command | Cmd Palette > "Create Bases Dashboard" | Modal opens | [ ] |
| Template list | Check templates | Shows 5 templates with descriptions | [ ] |
| Template names | Read names | "General Knowledge Base", "Research Tracker", "Pending Review", "Content by Type", "Processing Errors" | [ ] |
| Checkboxes | Click checkboxes | Can select/deselect templates | [ ] |
| Select All | Click "Select All" | All templates selected | [ ] |
| Clear Selection | Click "Clear Selection" | All templates deselected | [ ] |
| Folder selector | Check folder field | Shows folder input with browse button | [ ] |
| Validation | Try create with 0 selected | Shows error or prevents creation | [ ] |
| Create button | Select 2+ templates, click Create | Creates `.base` files in target folder | [ ] |
| Cancel button | Click Cancel | Modal closes, no files created | [ ] |

### 4.9 Dashboard Files Validation

After creating dashboards:

| Test | Expected | Pass |
|------|-------|----------|------|
| Files created | Check target folder | `.base` files exist | [ ] |
| General KB | Open file | Contains `filters`, `columns`, `sorting` YAML | [ ] |
| Research Tracker | Open file | Has filter `aio_type: research` | [ ] |
| Pending Review | Open file | Has filter `aio_status: pending` | [ ] |
| Content by Type | Open file | Has `grouping` by `aio_type` | [ ] |
| Processing Errors | Open file | Has filter `aio_status: error` | [ ] |
| Column names | Check columns | Includes Title, Summary, Status, Type, etc. | [ ] |
| Sorting | Check sorting config | Proper sort keys (created, modified) | [ ] |
| No overwrites | Try create again in same folder | Prevents overwriting or shows error | [ ] |

### 4.10 Bases Plugin Integration

**Note:** Requires Obsidian Bases plugin installed

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Open dashboard | Click on `.base` file | Bases plugin opens dashboard view | [ ] |
| See metadata | Check dashboard | Shows `aio_*` properties in columns | [ ] |
| Filter works | Use Bases filters | Filters notes by `aio_status`, `aio_type` | [ ] |
| Sort works | Use Bases sorting | Sorts by date, status, type | [ ] |
| Group works | Open "Content by Type" | Notes grouped by research/meeting/project | [ ] |
| Summary preview | Hover/click note | Shows 280-char summary hook | [ ] |

### 4.11 Backward Compatibility

Test with "Enable Structured Metadata" OFF:

| Test | Steps | Expected | Pass |
|------|-------|----------|------|
| Traditional summary | Disable setting, summarize URL | No `aio_*` properties added | [ ] |
| Body content | Check summary | Summary inserted as before (traditional format) | [ ] |
| No JSON parsing | Check behavior | Works like previous versions | [ ] |
| Toggle back on | Re-enable, summarize another URL | Structured metadata works again | [ ] |

### 4.12 i18n (Bilingual Support)

Test with Chinese interface (if applicable):

| Test | Expected | Pass |
|------|-------|----------|------|
| Settings labels | All Bases settings in Chinese | [ ] |
| Modal titles | Migration/Dashboard modals in Chinese | [ ] |
| Button text | All buttons translated | [ ] |
| Info messages | Info boxes in Chinese | [ ] |
| Command names | Commands in Chinese | [ ] |

---

## 5. Core Functionality Smoke Test

Quick check that main features still work:

| Feature | Test | Pass |
|---------|------|------|
| Tag generation | Tag a note with content | [ ] |
| URL summarize | Summarize a web article | [ ] |
| PDF summarize | Summarize a PDF (Claude/Gemini) | [ ] |
| YouTube summarize | Summarize a video with captions | [ ] |
| Translation | Translate a note | [ ] |
| Improve note | Ask AI to improve | [ ] |
| Related notes | Open Related Notes panel | [ ] |
| Semantic search | Search vault semantically | [ ] |
| Tag network | View tag network | [ ] |

---

## 5. Provider Tests

### 5.1 Cloud Providers

Test with at least one provider:

| Provider | Connection Test | Tag Generation | Summarize | Pass |
|----------|-----------------|----------------|-----------|------|
| OpenAI | [ ] | [ ] | [ ] | [ ] |
| Claude | [ ] | [ ] | [ ] | [ ] |
| Gemini | [ ] | [ ] | [ ] | [ ] |

### 5.2 Local (Ollama)

| Test | Expected | Pass |
|------|----------|------|
| Connection test | Shows "Connected" | [ ] |
| Tag generation | Tags generated | [ ] |
| Embedding generation | Index builds | [ ] |

---

## Test Summary

| Category | Passed | Failed | Notes |
|----------|--------|--------|-------|
| Audit Fixes | /6 | | |
| Note Structure | /18 | | |
| Language/UI | /10 | | |
| Core Features | /9 | | |
| Providers | /6 | | |
| **TOTAL** | /49 | | |

---

## Issues Found

### Critical

| Issue | Description | Fixed |
|-------|-------------|-------|
| | | [ ] |

### Minor

| Issue | Description | Fixed |
|-------|-------------|-------|
| | | [ ] |

---

## Environment

| Property | Value |
|----------|-------|
| Obsidian Version | |
| OS | |
| Plugin Version | 1.0.15 |
| Test Date | |
| Tester | |
