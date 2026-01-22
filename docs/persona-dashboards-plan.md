# Persona Dashboards Implementation Plan

## Overview

Extend the dashboard templates system to support persona-filtered views. Each summarization persona (Student, Executive, Casual, Researcher, Technical) gets a dedicated dashboard template that filters notes by the `aio_persona` metadata field.

## Current Status: COMPLETE ✅

### All Phases Implemented
- ✅ Dashboard templates exist in `src/services/dashboardTemplates.ts` with 10 templates
- ✅ `DashboardCategory` type: `'default' | 'persona'`
- ✅ `getTemplatesByCategory()` helper function
- ✅ Each persona template has `personaId` and `icon` properties
- ✅ `aio_persona` field in `src/core/constants.ts` (line 39)
- ✅ `persona` in `AIOMetadata` interface (line 23)
- ✅ `DashboardCreationModal` showing categorized sections with icons
- ✅ i18n strings for `defaultTemplates` and `personaTemplates`
- ✅ URL summarization tracks persona (when `enableStructuredMetadata` is true)
- ✅ PDF summarization tracks persona
- ✅ YouTube summarization tracks persona
- ✅ Smart summarization passes persona through all flows

---

## Phase 1: Metadata Infrastructure

### 1.1 Add `aio_persona` to Constants

**File:** `src/core/constants.ts`

Add to `AIO_META` object:
```typescript
export const AIO_META = {
    status: 'aio_status',
    processed: 'aio_processed',
    type: 'aio_type',
    summary: 'aio_summary',
    source: 'aio_source',
    sourceUrl: 'aio_source_url',
    wordCount: 'aio_word_count',
    persona: 'aio_persona',  // NEW
};
```

### 1.2 Update AIOMetadata Interface

**File:** `src/utils/frontmatterUtils.ts`

Update the `AIOMetadata` interface:
```typescript
export interface AIOMetadata {
    status?: 'pending' | 'processed' | 'error';
    processed?: string;
    type?: string;
    summary?: string;
    source?: string;
    sourceUrl?: string;
    wordCount?: number;
    persona?: string;  // NEW - persona ID used during summarization
}
```

### 1.3 Track Persona During Summarization

**File:** `src/commands/summarizeCommands.ts`

In `summarizeTextWithLLM()` and related functions, after successful summarization:

```typescript
// After writing summary to frontmatter, also write persona
await updateAIOMetadata(file, {
    status: 'processed',
    processed: new Date().toISOString(),
    summary: summaryText,
    persona: personaId  // e.g., 'student', 'executive', 'casual', etc.
});
```

---

## Phase 2: Dashboard Templates (COMPLETE)

The 5 persona templates already exist in `dashboardTemplates.ts`:
1. **Study Notes** - filters `aio_persona: student`
2. **Executive Briefings** - filters `aio_persona: executive`
3. **Casual Reads** - filters `aio_persona: casual`
4. **Research Papers** - filters `aio_persona: researcher`
5. **Tech Documentation** - filters `aio_persona: technical`

---

## Phase 3: UI Enhancement

### 3.1 Update DashboardCreationModal

**File:** `src/ui/modals/DashboardCreationModal.ts`

Current state: Shows flat list of all templates.

Target state: Show templates in categorized sections:
- **Default Templates** (5)
- **Persona Templates** (5)

Implementation:
```typescript
import { getTemplatesByCategory, DashboardCategory } from '../../services/dashboardTemplates';

// In render method
const defaultTemplates = getTemplatesByCategory('default');
const personaTemplates = getTemplatesByCategory('persona');

// Render "Default Templates" section header
// Render default template options

// Render "Persona Templates" section header
// Render persona template options with icons
```

---

## Phase 4: Config File Support (Optional)

Allow users to define custom dashboard templates in a config file.

**Config file:** `AI-Organiser/dashboard-templates.json`

```json
{
  "templates": [
    {
      "name": "My Custom Dashboard",
      "description": "Custom filtered view",
      "fileName": "Custom Dashboard.base",
      "category": "custom",
      "content": "---\nname: Custom Dashboard\n..."
    }
  ]
}
```

This phase is optional and can be implemented later.

---

## Testing Checklist

### Phase 1 Testing
- [ ] Summarize a note with Student persona → check `aio_persona: student` in frontmatter
- [ ] Summarize a note with Executive persona → check `aio_persona: executive` in frontmatter
- [ ] Verify existing summaries still work (backward compatible)

### Phase 2 Testing (Already Complete)
- [x] Templates exist with correct filter syntax
- [x] Templates have category, personaId, and icon properties

### Phase 3 Testing
- [ ] Open dashboard creation modal → see categorized sections
- [ ] Create a persona dashboard → verify it filters correctly
- [ ] Persona templates show their icons in the picker

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/constants.ts` | Add `persona` to `AIO_META` |
| `src/utils/frontmatterUtils.ts` | Add `persona` to `AIOMetadata` interface |
| `src/commands/summarizeCommands.ts` | Track persona ID during summarization |
| `src/ui/modals/DashboardCreationModal.ts` | Categorized template picker UI |

## Acceptance Criteria

1. ✅ Dashboard templates exist with persona filtering
2. ✅ `aio_persona` field tracked during summarization
3. ✅ Notes summarized with a persona have `aio_persona` in frontmatter
4. ✅ Persona dashboards correctly filter notes by persona
5. ✅ Dashboard creation modal shows categorized sections
