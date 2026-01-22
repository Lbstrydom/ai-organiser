# AI Organiser - Quick Test Checklist

**Version:** 1.0.15
**Focus:** Audit fixes + Note Structure + Language improvements

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

## 4. Core Functionality Smoke Test

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
