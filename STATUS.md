# Project Status

This document tracks ongoing development, recent changes, and planned work for the AI Tagger Universe plugin.

## Current Version

**v1.0.15** (as of 2026-01-19)

---

## Recent Changes

### 2026-01-19

#### Documentation & Planning
- Created `AGENTS.md` as generic version of `CLAUDE.md` for all AI assistants
- Updated `CLAUDE.md` with deploy path and planned features reference
- Added web summarization feature plan in `docs/web-summarization-feature-plan.md`
- Added deploy path to documentation: `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`

#### Bug Fixes
- Fixed Chinese quotation marks in `zh-cn.ts` (line 177) causing TypeScript build errors
- Fixed `undefined` error for `suggestedTags` in `generateCommands.ts`
- Removed incomplete web summarization feature files that were causing build failures

#### Feature Planning
- Detailed implementation plan for URL/PDF web summarization
- Security considerations: SSRF prevention, prompt injection protection
- Token limit handling with user choice (truncate vs chunk)
- Privacy notice for cloud LLM usage
- **NEW**: Link preservation - use Readability's HTML output + convert to Markdown to preserve hyperlinks
- Direct PDF URL detection and handling

---

## Planned Features

### Web Content Summarization (In Planning)

**Status**: Plan complete, implementation pending

**Summary**: Fetch web articles by URL, extract content with Readability, summarize with LLM, insert into notes.

**Key Features**:
- Direct URL fetching via Obsidian's `requestUrl()`
- Automatic PDF fallback when fetch fails
- Link preservation (HTML → Markdown conversion)
- Token limit handling (truncate or chunk with map-reduce)
- Privacy warning for cloud LLM usage (once per session)
- Support for Claude and Gemini PDF summarization

**Files to create**: ~25 new/modified files (see `docs/web-summarization-feature-plan.md`)

**Dependencies to add**:
- `@mozilla/readability`
- `jsdom`
- `@types/jsdom`

---

## Known Issues

| Issue | Status | Notes |
|-------|--------|-------|
| Web summarization incomplete | Deferred | Plan complete, files removed until full implementation |
| Some i18n strings added but unused | Low priority | Summarization-related translations ready for future use |

---

## Repository Info

| Item | Value |
|------|-------|
| **Origin** | https://github.com/Lbstrydom/second-brain-organiser |
| **Upstream** | https://github.com/niehu2018/obsidian-ai-tagger-universe |
| **Deploy Path** | `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\` |
| **Build Command** | `npm run build` |
| **Dev Command** | `npm run dev` |

---

## Changelog Format

When adding entries, use this format:

```markdown
### YYYY-MM-DD

#### Category (Bug Fixes / Features / Documentation / Refactoring)
- Brief description of change
- Another change
```

---

## Contributing

1. Read `CLAUDE.md` or `AGENTS.md` for architecture overview
2. Check `docs/` for feature plans before implementing
3. Update this STATUS.md when making significant changes
4. Run `npm run build` and test before committing
