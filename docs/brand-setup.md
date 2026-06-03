# Set up your own brand

AI Organiser can match every presentation and document export to *your* brand —
colours, fonts, minimum font sizes, layout zones, logos, and icons. This is
optional: without a brand pack the plugin uses a neutral built-in example. Add a
brand pack and tick **On-brand** per deck to apply it.

This guide is generic — no company names, no proprietary numbers. Copy the
example below and fill in your own values.

## 1. Create a brand folder

Make a folder anywhere in your vault, e.g. `999_Brand`. Put your brand pack
inside it. Then point the **Brand folder** setting at it:

> Settings → AI Organiser → Brand → **Brand folder path**

The folder path field is a browse-style picker — start typing and pick the
folder from the list.

## 2. Add `brand-guidelines.md`

This is the only required file. It is plain Markdown with four sections.

### `## Colors`

A Markdown table mapping a **role** to a **hex** value. Roles are matched by
keyword (primary, secondary, accent, background, text, link), so the exact
wording is flexible.

| Role        | Hex      |
|-------------|----------|
| Primary     | #1A3A5C  |
| Secondary   | #0F3460  |
| Accent      | #F5C842  |
| Background  | #FFFFFF  |
| Text        | #2D3748  |
| Link        | #1A3A5C  |

### `## Typography`

A bullet list. `Font` is required; the rest are optional and fall back to
sensible defaults.

- Font: Inter
- Font fallback: Helvetica
- Body pt: 14
- Min body pt: 12
- Min caption pt: 10
- Min table pt: 11

The `Min * pt` values override the **universal minimum font sizes** you set in
Settings → Brand. (The footer / slide-number strip is auto-placed and is the one
exception — it is not user-editable.)

### `## Layout`

Optional. Safe-area zones in inches on the 16:9 (13.33 × 7.5 in) slide canvas.
Each value reserves space so generated content never collides with your master
template's header, footer, or logo.

- Header band in: 1.0
- Content top in: 1.6
- Footer band in: 7.0
- Logo reserve in: 2.0
- Side margin in: 0.3

### `## Composition Rules`

Optional. A bullet list of plain-language rules. These are fed to the generator
as guidance and used as an on-brand audit checklist.

- Keep one idea per slide.
- Never put body text below 12 pt.
- Use the accent colour sparingly, for emphasis only.

## 3. Optional: logos

Drop logo files in the brand folder:

- `logo-light.png` or `logo-light.svg` — for light backgrounds
- `logo-dark.png` or `logo-dark.svg` — for dark backgrounds

Either file format works; the plugin picks whichever variant exists.

## 4. Optional: icons

Add an `icons/` subfolder with one `.svg` per concept, plus a
`manifest.json` mapping concept keywords to filenames:

```
999_Brand/
  brand-guidelines.md
  logo-light.svg
  logo-dark.svg
  icons/
    manifest.json
    growth.svg
    security.svg
```

`icons/manifest.json` example:

```json
{
  "growth": "growth.svg",
  "security": "security.svg"
}
```

## 5. Turn it on

1. Settings → AI Organiser → Brand → set **Brand folder path** to your folder.
2. The **Detected** block confirms what was found (guidelines / logo / icons).
3. Toggle **On-brand by default** to apply it to new decks automatically, or
   tick **On-brand** per deck when generating.

## Minimal copy-paste `brand-guidelines.md`

```markdown
## Colors

| Role       | Hex      |
|------------|----------|
| Primary    | #1A3A5C  |
| Secondary  | #0F3460  |
| Accent     | #F5C842  |
| Background  | #FFFFFF  |
| Text       | #2D3748  |
| Link       | #1A3A5C  |

## Typography

- Font: Inter
- Font fallback: Helvetica
- Body pt: 14
- Min body pt: 12
- Min caption pt: 10
- Min table pt: 11

## Layout

- Header band in: 1.0
- Content top in: 1.6
- Footer band in: 7.0
- Logo reserve in: 2.0
- Side margin in: 0.3

## Composition Rules

- Keep one idea per slide.
- Never put body text below 12 pt.
- Use the accent colour sparingly, for emphasis only.
```
