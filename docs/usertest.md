# AI Organiser - Manual Test Checklist

**Version:** 1.0.15
**Quick Test Time:** ~15 minutes

---

## Pre-Test

- [ ] `npm run build:quick` passes
- [ ] Files deployed: `main.js`, `manifest.json`, `styles.css`
- [ ] Obsidian restarted, plugin enabled

---

## 1. Settings Sanity (2 min)

- [ ] Open Settings → AI Organiser
- [ ] Sections visible in order: AI Provider → Language → Tagging → Summarization → YouTube → Audio → Semantic Search → Bases → NotebookLM → Mobile → Configuration
- [ ] Toggle Semantic Search ON/OFF 3× → no duplicate UI elements
- [ ] API key shows masked format: `sk-abc•••••••`

---

## 2. Core Workflows (8 min)

### Tagging (1 min)
- [ ] Open any note → Ctrl+P → "Tag this note" → tags appear in frontmatter
- [ ] Clear tags command removes tags

### Summarization (3 min)
Pick ONE source type:
- [ ] **URL**: Create note with URL → "Summarize" → summary inserted, `source_url` in frontmatter
- [ ] **YouTube**: Note with YouTube link → summary + transcript saved
- [ ] **PDF**: Open PDF note → summarize (requires Claude/Gemini)
- [ ] **Audio**: Summarize audio file (requires OpenAI/Groq key)

### Translation (1 min)
- [ ] Select text → "Translate selection" → translated without format changes

### Smart Features (3 min)
- [ ] "Improve with AI" → enhanced note content
- [ ] "Create diagram" → Mermaid diagram inserted
- [ ] "Find related resources" → resource suggestions

---

## 3. Meeting Minutes (3 min)

- [ ] Ctrl+P → "Create Meeting Minutes" → modal opens
- [ ] Fill: Title, Date, Participants, Transcript
- [ ] Select persona from dropdown
- [ ] Generate → note created with structured output
- [ ] Check frontmatter: `aio_meeting_date`, `aio_attendees`

---

## 4. Semantic Search (2 min)

- [ ] Enable Semantic Search in settings
- [ ] Select embedding provider, enter API key if needed
- [ ] Open Related Notes sidebar (View → Related Notes)
- [ ] Switch between notes → panel updates with related notes
- [ ] Click related note → navigates to it

---

## 5. Provider Quick Test

Test with your configured provider:

| Check | Pass |
|-------|------|
| Connection test passes | [ ] |
| Tag generation works | [ ] |
| Summarization works | [ ] |

---

## 6. Configuration Files

- [ ] Open `AI-Organiser/Config/` folder exists
- [ ] `taxonomy.md` present (or created on first use)
- [ ] Dictionaries folder: `AI-Organiser/Config/dictionaries/`

---

## Issues Found

| Severity | Issue | Steps to Reproduce |
|----------|-------|-------------------|
| | | |

---

## Environment

| Property | Value |
|----------|-------|
| Obsidian Version | |
| OS | |
| Plugin Version | 1.0.15 |
| Test Date | |
