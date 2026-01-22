# Obsidian Bases Integration - User Guide

## Overview

The Obsidian Bases integration adds powerful metadata capabilities to AI Organiser, enabling rich dashboard views through the Obsidian Bases plugin. This feature automatically adds structured metadata to your notes during AI processing, making your knowledge base more discoverable and analyzable.

## What is Obsidian Bases?

[Obsidian Bases](https://github.com/RafaelGB/obsidian-db-folder) is a plugin that allows you to create database-like views of your notes using `.base` files. Think of it as a way to view your vault through customizable dashboards with filtering, sorting, and grouping.

## Features

### Structured Metadata

AI Organiser automatically adds metadata properties to your notes during processing:

- `aio_summary` - 280-character summary hook for quick preview
- `aio_status` - Processing status: `processed`, `pending`, or `error`
- `aio_type` - Content classification: `note`, `research`, `meeting`, `project`, or `reference`
- `aio_processed` - ISO timestamp of last AI processing
- `aio_model` - AI model used (if enabled in settings)
- `aio_source` - Source type: `url`, `pdf`, `youtube`, `audio`, or `note`
- `aio_source_url` - Original URL for web content
- `aio_word_count` - Approximate word count
- `aio_language` - Detected content language

### Key Benefits

1. **Dashboard Views**: Create filtered, sorted views of your notes using Bases
2. **Quick Preview**: 280-char summaries show in dashboard previews
3. **Content Discovery**: Find notes by type, status, or source
4. **Processing Tracking**: Know which notes have been AI-processed
5. **Research Organization**: Track web summaries and their sources

## Getting Started

### Step 1: Enable Bases Integration

1. Open AI Organiser settings
2. Navigate to "Obsidian Bases Integration" section
3. Enable the following settings:
   - ✅ **Enable structured metadata** - Adds aio_* properties during AI processing
   - ✅ **Include model information** - Records which AI model was used
   - ✅ **Auto-detect content type** - Classifies notes automatically

### Step 2: Install Obsidian Bases (Optional but Recommended)

1. Open Obsidian Settings → Community Plugins
2. Search for "Obsidian DB Folder" or "Bases"
3. Install and enable the plugin
4. This allows you to use `.base` dashboard files

### Step 3: Migrate Existing Notes

Upgrade your existing notes to include the new metadata:

1. Open Command Palette (`Ctrl/Cmd+P`)
2. Search for "Upgrade to Bases metadata"
3. Choose:
   - **Upgrade vault** - Migrate all notes
   - **Upgrade folder** - Migrate current folder only
4. Review the analysis (shows how many notes need migration)
5. Configure options:
   - Extract summaries from note content
   - Overwrite existing metadata (if any)
6. Start migration
7. View results

**Migration is safe**: It only adds metadata to frontmatter, existing content and tags are preserved.

### Step 4: Create Dashboards

Generate `.base` files for different views:

1. Open Command Palette (`Ctrl/Cmd+P`)
2. Search for "Create Bases dashboard"
3. Choose a target folder for dashboards
4. Select templates:
   - **Knowledge Base** - All processed notes with status
   - **Research Tracker** - Research notes and web summaries
   - **Pending Review** - Notes awaiting processing
   - **Content by Type** - Grouped by content type
   - **Processing Errors** - Track failed processing
5. Click "Create Dashboards"

Dashboards are saved as `.base` files which you can customize further.

## How It Works

### Automatic Metadata Addition

When you use AI Organiser features, metadata is automatically added:

**URL Summarization:**
```markdown
---
aio_summary: "Comprehensive guide to TypeScript generics..."
aio_status: processed
aio_type: research
aio_source: url
aio_source_url: https://example.com/article
aio_processed: 2026-01-22T10:30:00Z
aio_model: gpt-4o
aio_word_count: 2500
tags: [typescript, programming, generics]
---
```

**PDF Summarization:**
```markdown
---
aio_summary: "Research paper on machine learning architectures..."
aio_status: processed
aio_type: research
aio_source: pdf
aio_processed: 2026-01-22T11:15:00Z
aio_model: claude-3-5-sonnet
aio_word_count: 8000
tags: [ml, deep-learning, research]
---
```

**YouTube Summarization:**
```markdown
---
aio_summary: "Conference talk about modern web development practices..."
aio_status: processed
aio_type: reference
aio_source: youtube
aio_source_url: https://youtube.com/watch?v=...
aio_processed: 2026-01-22T12:00:00Z
aio_word_count: 3200
tags: [webdev, conference, javascript]
---
```

### Migration Process

The migration tool analyzes existing notes and adds metadata:

1. **Extract Summary**: Looks for summary sections or uses first paragraph
2. **Determine Status**: `processed` if note has tags, `pending` otherwise
3. **Detect Type**: Analyzes content patterns (research, meeting, project keywords)
4. **Add Timestamps**: Uses file modification time
5. **Calculate Metrics**: Word count, detected language

### Dashboard Templates

Five built-in templates are provided:

#### 1. Knowledge Base
Shows all processed notes with filtering by status, type, and tags.

**Columns:**
- Note name
- Summary (280 chars)
- Status badge
- Content type
- Processing date
- Tags

#### 2. Research Tracker
Focused on research notes and web summaries.

**Columns:**
- Note name
- Summary
- Source type (URL/PDF)
- Source URL (clickable)
- Date
- Tags

#### 3. Pending Review
Notes that haven't been processed yet.

**Columns:**
- Note name
- Word count
- Content type
- Created date
- Tags

#### 4. Content by Type
Grouped view organizing notes by content type.

**Groups:** note, research, meeting, project, reference

#### 5. Processing Errors
Track notes where AI processing failed.

**Use case:** Retry failed processing, identify problematic content

## Advanced Usage

### Custom Dashboard Creation

You can create custom `.base` files:

```yaml
---
name: My Custom Dashboard
description: Notes processed this month
filters:
  - field: {aio_processed}
    operator: gte
    value: 2026-01-01
  - field: {aio_status}
    operator: equals
    value: processed
columns:
  - field: name
    label: Note
    width: 300
  - field: {aio_summary}
    label: Summary
    width: 400
  - field: {aio_type}
    label: Type
    width: 100
sorting:
  - field: {aio_processed}
    order: desc
---
```

### Metadata Queries

Use Dataview or Bases queries:

**Dataview Example:**
```dataview
TABLE aio_summary AS "Summary", aio_type AS "Type"
FROM ""
WHERE aio_status = "processed"
SORT aio_processed DESC
```

**Filter by Source:**
```dataview
TABLE aio_summary AS "Summary", aio_source_url AS "URL"
FROM ""
WHERE aio_source = "url"
AND aio_type = "research"
```

### API for Developers

If you're extending AI Organiser:

```typescript
import { updateAIOMetadata, getAIOMetadata } from './utils/frontmatterUtils';
import { AIO_META } from './core/constants';

// Update metadata
await updateAIOMetadata(app, file, {
    [AIO_META.SUMMARY]: 'Brief description...',
    [AIO_META.STATUS]: 'processed',
    [AIO_META.TYPE]: 'research'
});

// Read metadata
const metadata = getAIOMetadata(app, file);
console.log(metadata[AIO_META.STATUS]);
```

## Troubleshooting

### Metadata Not Appearing

**Problem:** Structured metadata not added after summarization

**Solutions:**
1. Check Settings → Obsidian Bases Integration → Enable structured metadata is ON
2. Verify file has frontmatter (starts with `---`)
3. Try manually running migration on the note

### Dashboard Not Showing Notes

**Problem:** `.base` file created but shows no notes

**Solutions:**
1. Ensure Obsidian Bases plugin is installed and enabled
2. Verify notes have the required metadata fields
3. Check filter conditions in `.base` file
4. Reload Obsidian (`Ctrl/Cmd+R`)

### Migration Shows No Notes Need Migration

**Problem:** Migration says all notes are up to date

**Solutions:**
1. Notes may already have `aio_status` property
2. Enable "Overwrite existing metadata" option
3. Check if notes are in excluded folders

### Summary Hook Too Long

**Problem:** `aio_summary` exceeds 280 characters

**Solutions:**
- Automatic: Parser truncates at sentence boundaries
- Manual: Edit frontmatter to shorten
- 280 chars is optimized for Bases preview pane

## Best Practices

### 1. Gradual Migration
- Start with one folder
- Review results before migrating entire vault
- Use "Extract summaries" option for better hooks

### 2. Dashboard Organization
- Create a dedicated "Dashboards" folder
- Name dashboards clearly: "Research - 2026", "Meeting Notes", etc.
- Keep templates, customize copies

### 3. Metadata Maintenance
- Re-run migration after major content updates
- Use "Overwrite existing" sparingly
- Let AI update metadata automatically during processing

### 4. Content Type Classification
- Review auto-detected types for accuracy
- Manually adjust types in frontmatter if needed
- Common patterns:
  - Meeting → Contains "agenda", "attendees"
  - Research → Contains "study", "paper", "findings"
  - Project → Contains "roadmap", "milestone"

### 5. Search and Discovery
- Use status filters to find pending notes
- Group by type for content audits
- Sort by processed date to see recent additions

## Privacy Considerations

- Metadata stays in your vault (local-first)
- No external services access metadata
- Model names recorded only if enabled
- Source URLs stored only for web content

## Integration with Other Features

### Semantic Search
- Bases dashboards + semantic search = powerful discovery
- Find notes by meaning, then view in dashboard
- Related notes sidebar complements dashboard views

### Tag Generation
- AI-generated tags appear in dashboards
- Filter dashboards by specific tags
- Combined tagging + metadata = rich organization

### RAG (Chat with Vault)
- Metadata helps RAG identify relevant context
- Content type filters improve retrieval
- Status tracking shows which notes are indexed

## FAQ

**Q: Do I need Obsidian Bases plugin to use this?**
A: No, but recommended. Metadata is useful even without Bases (Dataview, search, etc.)

**Q: Will this slow down my vault?**
A: No. Metadata is standard frontmatter. Minimal impact on performance.

**Q: Can I disable metadata for specific folders?**
A: Currently no, but you can exclude folders from processing in settings.

**Q: What happens if I uninstall Obsidian Bases?**
A: Metadata remains in notes (harmless). You can still use it with Dataview.

**Q: Can I customize metadata properties?**
A: Currently fixed to `aio_*` namespace. Future versions may support customization.

**Q: Does this work with mobile Obsidian?**
A: Yes! Metadata syncs across devices. Dashboards work on mobile too.

## Support

- GitHub Issues: Report bugs or request features
- Discussions: Share custom dashboards and workflows
- Documentation: Check AGENTS.md for developer details

## Changelog

**Version 1.x (Current)**
- ✅ Structured metadata system
- ✅ Migration tool with 4-stage UI
- ✅ 5 built-in dashboard templates
- ✅ Automatic summarization integration
- ✅ Bilingual support (EN/ZH-CN)

**Future Plans**
- [ ] Custom metadata fields
- [ ] Dashboard templates marketplace
- [ ] Metadata analytics and insights
- [ ] Bulk metadata editing
- [ ] Smart re-classification

## Examples

See `docs/bases_examples.md` for:
- Sample dashboards
- Real-world workflows
- Custom query recipes
- Integration patterns

---

**Created:** January 2026  
**Updated:** January 22, 2026  
**Version:** 1.0
