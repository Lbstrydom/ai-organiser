# Default Configuration Files

These are the default configuration files that AI Organiser creates when you first run the plugin. They are placed in your vault at `AI-Organiser/Config/`.

## Files

| File | Purpose |
|------|---------|
| `taxonomy.md` | Defines themes and disciplines for 3-tier hierarchical tagging |
| `excluded-tags.md` | Tags the AI should never suggest |
| `writing-personas.md` | Personas for "Improve note with AI" command |
| `summary-personas.md` | Personas for URL/PDF/YouTube/Audio summarization |
| `summary-prompt.md` | Custom instructions for summarization |

## Customization

1. **Edit in Obsidian**: Open any config file directly in Obsidian and modify it
2. **Reset to defaults**: Use Settings → Configuration → "Reset to Defaults" to restore original files
3. **Add new entries**: Follow the format in each file to add your own themes, personas, etc.

## Format Reference

### Taxonomy (taxonomy.md)
Uses markdown tables with three columns: Name, Description, Use When

### Personas (writing-personas.md, summary-personas.md)
```markdown
### Persona Name (default)

> Short description shown in selection menu

\`\`\`
Full prompt instructions for the AI
\`\`\`
```

### Excluded Tags (excluded-tags.md)
Simple list, one tag per line or comma-separated

## Notes

- Changes take effect immediately (no restart needed)
- The plugin folder (`AI-Organiser/`) is automatically excluded from tagging operations
- Config files are cached for 30 seconds for performance
