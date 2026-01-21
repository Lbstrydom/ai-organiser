# AI Organiser - User Testing Guide

**Version:** 1.0.15
**Last Updated:** January 2026

This document provides a comprehensive testing checklist for the AI Organiser Obsidian plugin. Use this to verify all features work correctly before release or after major changes.

---

## Pre-Test Setup

### Environment Checklist

- [ ] Fresh build completed: `npm run build`
- [ ] Plugin files copied to Obsidian: `main.js`, `manifest.json`, `styles.css`
- [ ] Obsidian restarted/reloaded
- [ ] Plugin enabled in Community Plugins settings
- [ ] Debug mode enabled for detailed logging (Settings > LLM Settings > Debug Mode)

### Required API Keys (for full testing)

| Provider | Required For |
|----------|--------------|
| OpenAI | Cloud tagging, audio transcription |
| Claude | Cloud tagging, PDF summarization |
| Gemini | Cloud tagging, PDF summarization |
| Groq | Cloud tagging, fast audio transcription |

### Test Content Needed

- [ ] Several markdown notes with content (for tagging)
- [ ] A folder with 3-5 markdown files (for batch operations)
- [ ] PDF files in attachments folder
- [ ] Audio files (.mp3, .m4a, .wav) - one small (<25MB) and one large (>25MB)
- [ ] YouTube video URLs (with captions)
- [ ] Web article URLs for summarization

---

## 1. Settings & Configuration

### 1.1 LLM Settings Section

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Service type toggle | Switch between "Local LLM" and "Cloud Service" | UI updates to show relevant options | [ ] |
| Cloud provider dropdown | Select different providers (OpenAI, Claude, Gemini, etc.) | Dropdown shows all 13 providers | [ ] |
| API key field | Enter API key | Key is saved and masked | [ ] |
| Connection test (cloud) | Enter valid API key, click "Test Connection" | Shows "Connection successful" notice | [ ] |
| Connection test (invalid) | Enter invalid API key, click "Test Connection" | Shows "Connection failed" notice | [ ] |
| Local endpoint config | Switch to Local LLM, set endpoint | Endpoint URL is saved | [ ] |
| Connection test (local) | With Ollama running, click "Test Connection" | Shows success if Ollama is running | [ ] |
| Debug mode toggle | Toggle debug mode on/off | Console shows debug logs when enabled | [ ] |

### 1.2 Tagging Settings Section

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Maximum tags slider | Adjust slider (1-10) | Value updates, saved in settings | [ ] |
| Output language dropdown | Select different languages | Language is saved for tag generation | [ ] |
| Excluded folders button | Click "Manage" | Opens excluded files modal | [ ] |
| Add folder exclusion | Add a folder path to exclusions | Folder appears in list | [ ] |
| Remove folder exclusion | Remove an excluded folder | Folder no longer excluded | [ ] |

### 1.3 Summarization Settings Section

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Enable summarization toggle | Toggle on/off | Summarization commands respect setting | [ ] |
| Default summary style dropdown | Select different personas | Default persona changes | [ ] |
| Edit personas button | Click "Open Personas File" | Opens summary-personas.md | [ ] |
| Summary length dropdown | Select Brief/Detailed/Comprehensive | Setting is saved | [ ] |
| Summary language dropdown | Select language | Setting is saved | [ ] |
| Include metadata toggle | Toggle on/off | Summaries include/exclude metadata header | [ ] |
| Save transcripts dropdown | Select "Do not save" or "Save to separate file" | Setting is saved | [ ] |
| Transcript folder field | Enter folder name | Folder path is saved | [ ] |

### 1.4 Configuration Settings Section

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Config folder field | Change folder name | Config folder path updates | [ ] |
| Create config files | Click "Create Config Files" | Creates taxonomy.md, writing-personas.md, etc. | [ ] |
| Open config folder | After creating files, files appear in vault | Files accessible in file explorer | [ ] |
| Edit taxonomy | Modify taxonomy.md themes/disciplines | Changes reflected in tag generation | [ ] |
| Edit writing personas | Modify writing-personas.md | Changes reflected in note improvement | [ ] |
| Edit summary personas | Modify summary-personas.md | Changes reflected in summarization | [ ] |

### 1.5 Interface Settings Section

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Language dropdown | Select English | All UI text in English | [ ] |
| Language dropdown | Select 简体中文 | All UI text in Chinese (after restart) | [ ] |
| Language change notice | Change language | Shows restart notice | [ ] |

---

## 2. Tag Generation Commands

### 2.1 Generate Tags for Current Note

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Basic tag generation | Open note, run command | Tags added to frontmatter | [ ] |
| Tag format | Check generated tags | Tags are kebab-case, 3-tier hierarchy | [ ] |
| Max tags respected | Set max tags to 3, generate | No more than 3 tags generated | [ ] |
| Empty note handling | Run on empty note | Shows "No content to analyze" | [ ] |
| No note open | Run without active note | Shows "Please open a note" | [ ] |
| Existing tags | Run on note with tags | New tags merged with existing | [ ] |

### 2.2 Generate Tags for Folder

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Folder tagging | Open note in folder, run command | Confirmation modal appears | [ ] |
| Confirm and process | Click confirm | All files in folder processed | [ ] |
| Progress display | During processing | Shows progress notifications | [ ] |
| Excluded folders | Have excluded folder in path | Excluded files are skipped | [ ] |
| Cancel operation | Click cancel in modal | Operation cancelled, no changes | [ ] |

### 2.3 Generate Tags for Vault

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Vault tagging | Run command | Confirmation modal appears | [ ] |
| Confirm and process | Click confirm | All vault files processed | [ ] |
| Progress tracking | During processing | Shows progress count | [ ] |
| Completion notice | After completion | Shows success/failure count | [ ] |

### 2.4 Taxonomy Integration

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Themes in tags | Generate tags | Tags include theme categories | [ ] |
| Disciplines in tags | Generate tags | Tags include discipline categories | [ ] |
| Custom taxonomy | Edit taxonomy.md, regenerate | Custom themes/disciplines used | [ ] |
| 3-tier hierarchy | Check tag structure | Tags follow theme/discipline/concept format | [ ] |

---

## 3. Clear Tags Commands

### 3.1 Clear Tags for Current Note

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Clear tags | Run on note with tags | Tags removed from frontmatter | [ ] |
| Clear non-tagged note | Run on note without tags | Shows appropriate message | [ ] |
| Other frontmatter preserved | Clear tags | Title, aliases, etc. unchanged | [ ] |

### 3.2 Clear Tags for Folder

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Folder clear | Run command | Confirmation modal with file count | [ ] |
| Confirm clear | Click confirm | All folder notes cleared | [ ] |
| Completion notice | After clear | Shows count of files cleared | [ ] |

### 3.3 Clear Tags for Vault

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Vault clear | Run command | Confirmation modal appears | [ ] |
| Confirm clear | Click confirm | All vault tags cleared | [ ] |
| Warning message | In modal | Shows appropriate warning | [ ] |

---

## 4. Summarization Commands

### 4.1 Summarize from URL

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| URL modal opens | Run command | URL input modal appears | [ ] |
| Persona selection | Change persona dropdown | Different persona selected | [ ] |
| Valid URL processing | Enter valid URL, click Summarize | Content fetched and summarized | [ ] |
| Invalid URL | Enter invalid URL | Shows validation error | [ ] |
| Summary insertion | After summarization | Summary inserted at cursor | [ ] |
| Metadata included | With metadata enabled | Shows title, date, source | [ ] |
| References section | After summarization | Source added to References section | [ ] |
| Large content handling | Summarize long article | Shows content size modal | [ ] |
| Truncate option | Choose truncate in modal | Truncated content summarized | [ ] |
| Chunk option | Choose chunk in modal | Content split and combined | [ ] |
| Privacy notice | First cloud request | Privacy modal appears | [ ] |
| Privacy notice once | Subsequent requests | No privacy modal (same session) | [ ] |

### 4.2 Summarize from PDF

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| PDF modal opens | Run command | PDF selection modal appears | [ ] |
| PDF list populated | Modal open | Shows PDFs from attachments | [ ] |
| Persona selection | Change persona dropdown | Different persona selected | [ ] |
| PDF processing (Claude) | Select PDF, summarize | PDF content summarized | [ ] |
| PDF processing (Gemini) | Select PDF with Gemini | PDF content summarized | [ ] |
| Unsupported provider | Try with OpenAI | Shows "not supported" message | [ ] |
| No PDFs found | Empty attachments folder | Shows "No PDFs found" | [ ] |

### 4.3 Summarize from YouTube

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| YouTube modal opens | Run command | YouTube input modal appears | [ ] |
| Caption notice shown | Modal open | Shows note about captions | [ ] |
| Persona selection | Change persona dropdown | Different persona selected | [ ] |
| Valid YouTube URL | Enter youtube.com URL | URL accepted | [ ] |
| Valid youtu.be URL | Enter youtu.be URL | URL accepted | [ ] |
| Invalid URL | Enter non-YouTube URL | Shows validation error | [ ] |
| Transcript fetched | Valid video with captions | Transcript extracted | [ ] |
| No captions | Video without captions | Shows "No captions available" | [ ] |
| Summary insertion | After summarization | Summary inserted at cursor | [ ] |
| Video metadata | With metadata enabled | Shows video title, channel | [ ] |
| Transcript saved | With "Save to file" enabled | Transcript file created | [ ] |
| Transcript link | After summarization | Note contains transcript link | [ ] |
| Transcript folder | Check transcript location | File in configured folder | [ ] |

### 4.4 Summarize from Audio

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Audio modal opens | Run command | Audio selection modal appears | [ ] |
| Audio list populated | Modal open | Shows audio files from vault | [ ] |
| File size display | Check file list | Shows file sizes | [ ] |
| Compression badge | Large file (>25MB) | Shows "Will compress" badge | [ ] |
| Small file processing | Select <25MB file | Direct transcription | [ ] |
| Large file processing | Select >25MB file | Shows compression progress | [ ] |
| Language selection | Set audio language | Improves transcription accuracy | [ ] |
| Context prompt | Add context description | Helps with technical terms | [ ] |
| Persona selection | Change persona dropdown | Different persona selected | [ ] |
| Transcription progress | During transcription | Shows progress notices | [ ] |
| Transcript saved | With "Save to file" enabled | Transcript file created | [ ] |
| Transcript link | After summarization | Note contains transcript link | [ ] |
| Transcript folder | Check transcript location | File in configured folder | [ ] |
| Transcript metadata | Open transcript file | Contains metadata header | [ ] |
| Provider required | No OpenAI/Groq key | Shows "requires API key" message | [ ] |

### 4.5 Summary Personas

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Student persona | Summarize with Student | Study notes format | [ ] |
| Executive persona | Summarize with Executive | Business briefing format | [ ] |
| Casual persona | Summarize with Casual | Conversational style | [ ] |
| Researcher persona | Summarize with Researcher | Academic format | [ ] |
| Technical persona | Summarize with Technical | Developer-focused format | [ ] |
| Custom persona | Create custom in file, use | Custom format applied | [ ] |
| Default persona | Check settings default | Correct default selected | [ ] |

---

## 5. Translation Commands

### 5.1 Translate Note

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Translation modal opens | Run command | Language selection modal appears | [ ] |
| Language dropdown | Check dropdown | All common languages available | [ ] |
| Full note translated | Select language, translate | Entire note content translated | [ ] |
| Formatting preserved | After translation | Markdown formatting intact | [ ] |
| Frontmatter preserved | After translation | YAML frontmatter unchanged | [ ] |
| Progress notice | During translation | Shows "Translating..." | [ ] |

### 5.2 Translate Selection

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| No selection | Run without selection | Shows "Please select text" | [ ] |
| Selection translated | Select text, run command, choose language | Selected text replaced with translation | [ ] |
| Formatting in selection | Select formatted text | Formatting preserved | [ ] |

---

## 6. Smart Note Commands

### 6.1 Improve Note with AI

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Improve modal opens | Run command | Improve note modal appears | [ ] |
| Examples shown | Check modal | Shows example queries | [ ] |
| Persona button | Click persona selector | Opens persona selection modal | [ ] |
| Persona selection | Select different persona | Persona updated in modal | [ ] |
| Basic improvement | Enter query, submit | Note content improved | [ ] |
| Analogy request | Ask for analogy | Analogy added to note | [ ] |
| Expansion request | Ask to expand section | Section expanded | [ ] |
| Summary request | Ask for summary | Summary added | [ ] |
| Empty note | Run on empty note | Handles gracefully | [ ] |

### 6.2 Find Related Resources

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Resources modal opens | Run command | Find resources modal appears | [ ] |
| Examples shown | Check modal | Shows example queries | [ ] |
| Search execution | Enter query, submit | Shows "Searching..." | [ ] |
| Results displayed | After search | Resource results modal appears | [ ] |
| YouTube section | Check results | YouTube videos listed | [ ] |
| Web section | Check results | Web articles listed | [ ] |
| Links clickable | Click a link | Opens in browser | [ ] |
| No results | Search obscure topic | Shows "No resources found" | [ ] |

### 6.3 Generate Note from Embedded Content

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Content selection modal | Run on note with embeds | Shows content selection modal | [ ] |
| Embedded content listed | Check modal | Lists images, PDFs, links | [ ] |
| Include note text toggle | Toggle checkbox | Option saved | [ ] |
| Select/deselect all | Click buttons | All items toggled | [ ] |
| Individual selection | Check/uncheck items | Items selected/deselected | [ ] |
| Generate with selection | Select items, generate | Content extracted and note generated | [ ] |
| No embedded content | Run on plain text note | Shows "No extractable content" | [ ] |
| Multimodal content | With Claude/Gemini | Images and PDFs processed | [ ] |
| Multimodal warning | With OpenAI | Shows "Images require Claude/Gemini" | [ ] |

---

## 7. Utility Commands

### 7.1 Collect All Tags

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Collect tags | Run command | New file created with all tags | [ ] |
| Tags formatted | Check file | One tag per line | [ ] |
| Unique tags only | Check file | No duplicate tags | [ ] |
| Empty vault | Run with no tags | Appropriate message shown | [ ] |

### 7.2 Show Tag Network

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Network view opens | Run command | Tag network view appears | [ ] |
| D3 visualization | Check view | Interactive graph displayed | [ ] |
| Nodes visible | Check graph | Tags shown as nodes | [ ] |
| Edges visible | Check graph | Co-occurrence lines shown | [ ] |
| Node colors | Check nodes | Color-coded by frequency | [ ] |
| Search filter | Type in search box | Graph filters to matching tags | [ ] |
| Hover tooltips | Hover over node | Shows tag info | [ ] |
| Node dragging | Drag a node | Node moves, graph adjusts | [ ] |
| No tags | Run with empty vault | Shows "No tags found" | [ ] |
| No connections | Single-tag notes | Shows "No tag connections" | [ ] |

---

## 8. Command Picker

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Open via ribbon | Click sparkles icon | Command picker opens | [ ] |
| Open via command | Ctrl+P, "Open command picker" | Command picker opens | [ ] |
| All commands listed | Check list | All 27+ commands visible | [ ] |
| Category badges | Check items | Badges show (Tagging, Summarize, etc.) | [ ] |
| Fuzzy search | Type partial command name | Results filtered | [ ] |
| Keyboard navigation | Use arrow keys | Navigate through items | [ ] |
| Execute command | Press Enter on item | Command executes | [ ] |
| Icons displayed | Check items | Each command has icon | [ ] |

---

## 9. Persona System

### 9.1 Improvement Personas

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Balanced persona | Use balanced | Clear, organized output | [ ] |
| Academic persona | Use academic | Formal, rigorous output | [ ] |
| Practical persona | Use practical | Actionable, step-by-step | [ ] |
| Concise persona | Use concise | Brief, essential points | [ ] |
| Creative persona | Use creative | Narrative, engaging | [ ] |
| Socratic persona | Use Socratic | Question-driven | [ ] |
| Custom persona | Create in writing-personas.md | Custom style applied | [ ] |
| Default marking | Add (default) to persona | Becomes default selection | [ ] |

### 9.2 Persona Modal

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Modal opens | Click persona selector button | Persona modal appears | [ ] |
| All personas listed | Check modal | All configured personas shown | [ ] |
| Descriptions visible | Check items | Shows persona descriptions | [ ] |
| Icons displayed | Check items | Shows persona icons | [ ] |
| Selection works | Click a persona | Persona selected, modal closes | [ ] |
| Current highlighted | Check selected persona | Shows as currently selected | [ ] |

---

## 10. Provider-Specific Tests

### 10.1 Local LLM (Ollama)

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Connection test | With Ollama running | Shows success | [ ] |
| Model listing | Check if models load | Models available in dropdown | [ ] |
| Tag generation | Generate tags | Tags generated successfully | [ ] |
| Summarization | Summarize URL | Content summarized | [ ] |
| Connection failed | With Ollama stopped | Shows appropriate error | [ ] |

### 10.2 Cloud Providers

For each provider (OpenAI, Claude, Gemini, Groq, etc.):

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| API key validation | Enter key, test connection | Connection verified | [ ] |
| Tag generation | Generate tags | Tags match provider's style | [ ] |
| Summarization | Summarize content | Summary generated | [ ] |
| Error handling | Invalid key | Clear error message | [ ] |

---

## 11. Edge Cases & Error Handling

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Very long note | Generate tags for 10K+ word note | Handles without crash | [ ] |
| Special characters | Note with emojis, unicode | No corruption | [ ] |
| Malformed frontmatter | Note with broken YAML | Graceful handling | [ ] |
| Network timeout | Slow/no network | Timeout with error message | [ ] |
| Rate limiting | Rapid successive requests | Appropriate throttling/error | [ ] |
| Large vault | 1000+ notes batch operation | Handles with progress | [ ] |
| Empty folder | Batch tag empty folder | Appropriate message | [ ] |
| Binary file in folder | Folder with non-md files | Skips non-markdown | [ ] |
| Nested folders | Folder with subfolders | Handles recursion correctly | [ ] |
| Duplicate tags | Tags appear multiple times | Deduplication works | [ ] |

---

## 12. Internationalization (i18n)

### 12.1 English Interface

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Settings labels | Check all settings | All text in English | [ ] |
| Command names | Check command palette | All commands in English | [ ] |
| Modal text | Check all modals | All text in English | [ ] |
| Error messages | Trigger errors | Messages in English | [ ] |
| Notices | Observe notifications | All notices in English | [ ] |

### 12.2 Chinese Interface

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Language switch | Set to 简体中文, restart | UI changes to Chinese | [ ] |
| Settings labels | Check all settings | All text in Chinese | [ ] |
| Command names | Check command palette | All commands in Chinese | [ ] |
| Modal text | Check all modals | All text in Chinese | [ ] |
| Error messages | Trigger errors | Messages in Chinese | [ ] |

---

## 13. Security & Privacy

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Privacy notice | First cloud request | Notice appears | [ ] |
| Privacy notice once | Subsequent requests | No repeat in session | [ ] |
| SSRF protection | Enter localhost URL | URL rejected | [ ] |
| Private IP blocked | Enter 192.168.x.x URL | URL rejected | [ ] |
| API key storage | Check settings file | Key stored securely | [ ] |
| No data leakage | Check console logs | No API keys in logs | [ ] |

---

## 14. UI/UX Verification

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Ribbon icon visible | Check left sidebar | Sparkles icon present | [ ] |
| Ribbon icon works | Click sparkles | Opens command picker | [ ] |
| File menu items | Right-click note | Context menu items present | [ ] |
| Settings organization | Open settings | Clear section organization | [ ] |
| Modal styling | Open various modals | Consistent styling | [ ] |
| Dark mode | Switch to dark theme | All elements visible | [ ] |
| Light mode | Switch to light theme | All elements visible | [ ] |
| Mobile responsiveness | If on mobile | UI adapts appropriately | [ ] |

---

## 15. Transcript Saving Feature

| Test | Steps | Expected Result | Pass |
|------|-------|-----------------|------|
| Transcript folder created | First save | Transcripts folder auto-created | [ ] |
| Audio transcript saved | Summarize audio with save enabled | File created in transcript folder | [ ] |
| YouTube transcript saved | Summarize YouTube with save enabled | File created in transcript folder | [ ] |
| Transcript metadata | Open transcript file | Contains source, date, duration, type | [ ] |
| Transcript link in note | Check summary output | Contains callout with link | [ ] |
| Link navigates | Click transcript link | Opens transcript file | [ ] |
| Custom folder | Change transcript folder, save | File created in custom folder | [ ] |
| Disabled saving | Set to "Do not save" | No transcript file created | [ ] |
| No transcript link | With saving disabled | No transcript link in summary | [ ] |
| Duplicate handling | Save same content twice | Creates unique filename with counter | [ ] |

---

## Test Summary

| Category | Total Tests | Passed | Failed | Notes |
|----------|-------------|--------|--------|-------|
| Settings & Configuration | 30 | | | |
| Tag Generation | 20 | | | |
| Clear Tags | 10 | | | |
| Summarization | 50 | | | |
| Translation | 10 | | | |
| Smart Notes | 25 | | | |
| Utilities | 15 | | | |
| Command Picker | 10 | | | |
| Persona System | 15 | | | |
| Provider Tests | 15 | | | |
| Edge Cases | 12 | | | |
| i18n | 12 | | | |
| Security | 8 | | | |
| UI/UX | 10 | | | |
| Transcript Saving | 12 | | | |
| **TOTAL** | **254** | | | |

---

## Issue Tracking

### Critical Issues

| Issue | Description | Status | Fix Notes |
|-------|-------------|--------|-----------|
| | | | |

### Minor Issues

| Issue | Description | Status | Fix Notes |
|-------|-------------|--------|-----------|
| | | | |

### Enhancement Requests

| Feature | Description | Priority |
|---------|-------------|----------|
| | | |

---

## Regression Testing Notes

After fixing issues, re-test:

1. [ ] All related functionality
2. [ ] Connected features that might be affected
3. [ ] Build succeeds: `npm run build`
4. [ ] No TypeScript errors
5. [ ] Console free of runtime errors

---

## Test Environment Details

| Property | Value |
|----------|-------|
| Obsidian Version | |
| OS | |
| Plugin Version | 1.0.15 |
| Node Version | |
| Test Date | |
| Tester | |
