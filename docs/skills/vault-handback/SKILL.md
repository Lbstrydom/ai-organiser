---
name: vault-handback
description: Turns the end of a working session into notes for an Obsidian vault run by the AI Organiser plugin. Use when the user asks to hand back, wrap up, save the session, send this to the vault or inbox, or capture a thought for later. Two outputs - one end-of-session hand-back (a Handoff section the plugin reviews) or one capture per note (plain sentences the capture inbox and sweep read). Writes a NEW file into the drop folder when a file tool exists; otherwise prints paste-ready text.
---

# Vault hand-back

The user keeps an Obsidian vault with the AI Organiser plugin. Nothing you write is committed by itself: every note lands in an inbox, and the user reviews it there. Your job is to produce notes in the exact shape the plugin reads, and to deliver them without touching anything else.

Make output only when the user asks. Default to **one hand-back per session**. Make captures only when the user asks for them.

## Pick the output

| The user wants | Write |
|---|---|
| To end the session, hand back, or record what was decided and what happens next | One **hand-back** note |
| To save a thought, a reminder or one commitment for later | One **capture** note per item |

If you are unsure, ask once. Never make both from one request unless the user asks for both.

## Output 1: the hand-back

The plugin's **Review AI hand-back** reads this note. It parses the `## Handoff` section with a fixed grammar, matches the project, and shows every item unticked. Decisions and questions go into the project note only if the user ticks them. Next actions go into the usual task review.

The grammar, exactly as the plugin defines it:

<!-- vault-handback:contract -->
```markdown
## Handoff
Project ID: <project id, only if the user gave it>
Chat project: <name> (claude|chatgpt)

### Decisions
- Suggested: <text>
- Decided: <text>

### Next actions
- [ ] <text> @context (waiting: <person>) (due: YYYY-MM-DD)

### Deliverables
- <file name>: <one line> (draft|released)

### Questions
- <text>
```

Rules:

- Put a `# <title>` heading first, then the `## Handoff` heading. Use exactly the heading `## Handoff` (level 2) and the four `###` section names above, in that order. Leave out a section that has nothing in it, but keep at least one.
- Write `Project ID:` **only** if the user gave you the project's id in this chat (it looks like `3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b`). Never guess one and never invent one. Without it, write the `Chat project:` line alone: the review then suggests the project and the user picks.
- `Chat project:` is the name of the chat project you are working in, then `(claude)`.
- **Decisions default to `Suggested:`.** Write `Decided:` only for something the user said they decided, in this chat, in so many words.
- A next action is one task: a verb, a person or thing, one line. Add one context from `@office @home @call @computer @agenda @errand` when it fits. Add `(waiting: <person>)` only when someone else must act first, and `(due: YYYY-MM-DD)` only for a date the user stated. Write real dates, never "next Friday".
- Deliverables are files the session produced or changed: the file name, a colon, one line, then `(draft)` or `(released)`.
- Questions are the open questions the user still has to answer.
- Plain lines only. No tables, no nested lists, no links you were not given.
- Never put the hand-back inside a code fence in the delivered note. The plugin does not see a `## Handoff` heading that sits in a fence.

Example:

<!-- vault-handback:example handback -->
```markdown
---
aio-handback: true
created-by: "claude"
---
# Website relaunch session

## Handoff
Chat project: Website brain (claude)

### Decisions
- Suggested: Build the new site as a static site
- Decided: Launch in March

### Next actions
- [ ] Email Dana the draft site map @computer (due: 2026-11-20)
- [ ] Ask the designer for the logo files (waiting: Sam)

### Deliverables
- sitemap_v02.md: page list with owners (draft)

### Questions
- Who signs off the final copy?
```

## Output 2: captures

The capture inbox and the inbox sweep read these notes as the user's own text. The sweep proposes tasks only from lines it can quote, so write clear, complete sentences.

Rules:

- **One capture per note.** Two unrelated thoughts are two notes.
- At least one full sentence of real words. State a commitment directly, with the person and the date: "Call Priya on 2026-11-12 about the venue deposit." Not "venue stuff".
- No `## Handoff` heading in a capture.
- No web links in a capture that holds a task: the sweep may treat a note with a source link as reading, not as a task.
- Keep it short: well under 12,000 characters.

Example:

<!-- vault-handback:example capture -->
```markdown
---
created-by: "claude"
---
Call Priya on 2026-11-12 about the venue deposit. She needs the final head count before then.
```

<!-- vault-handback:example capture -->
```markdown
---
created-by: "claude"
---
Idea for the onboarding guide: start with one finished example project, then explain the folders.
```

## Properties (the part between the `---` lines)

- Allowed: `created-by: "claude"` on every note, and `aio-handback: true` on a hand-back. Nothing else is needed.
- **Quote every text value** with double quotes. An unquoted colon (`title: Pricing: annual`) makes the properties unreadable, and the plugin then keeps the whole note out.
- **Never write any of these**, in properties or anywhere else in the note:
  - `aio-id` or `aio-role`: they are a project's identity. A second note carrying one makes the project a duplicate, and nothing resolves for that project until the user removes one.
  - `capture-id` or `capture-status`: the capture inbox owns them; they block its Accept.
  - any HTML comment starting with `aio:` (such as `aio:handoff`, `aio:capture`, `aio:sweep`): the plugin writes those markers and computes their ids itself.
- Do not write into a project note, a sweep report or any existing note. The plugin's own review is the only way into those.

## Deliver it

Check your output against the rules above before you deliver it.

**If you have a tool that writes files into the user's vault:**

1. Write each note as a **new** file in the folder `0 Inbox/From Claude/`. If that folder does not exist, stop and tell the user. Do not create it yourself.
2. Name it `YYYY-MM-DD <short title>.md` with today's date. Use only letters, digits, spaces, hyphens and full stops in the title. Leave out `\ / : * ? " < > | # ^ [ ]`.
3. **Never overwrite and never append.** If a file with that name already exists, do not write it. Tell the user, and offer a different name.
4. Write nowhere else in the vault.
5. Afterwards, say which files you wrote. For a hand-back, tell the user to open it and run **Review AI hand-back**.

**Otherwise (no file tool, for example in a chat on the web or a phone):**

1. Print the note name on its own line: `Note name: YYYY-MM-DD <short title>`.
2. Below it, print the note exactly as it should be saved, starting with its `---` line. **Do not wrap it in a code fence**, so the user can copy it straight into a new note.
3. For several captures, repeat the name and the note for each one, separated by a line with `* * *`.
4. Tell the user to save it in their inbox folder; for a hand-back, to open it and run **Review AI hand-back**.
