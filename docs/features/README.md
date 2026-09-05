# Feature Subsystem Docs

Operational detail for each subsystem, split out of [AGENTS.md](../../AGENTS.md) so the
canonical context file stays invariant-sized.

**AGENTS.md holds the invariants; these files hold the depth.** AGENTS.md keeps a
*what-it-is / when-you-need-it / pointer* stub per subsystem plus the rules that bind
every subsystem; the pipelines, component inventories, settings tables, test rosters and
phase histories live here. This mirrors the progressive-disclosure split a skill uses
between its `SKILL.md` and its `references/`.

| File | Covers |
|---|---|
| [presentation.md](presentation.md) | Consultant storyboard + storyline, chat/presentation builder, depth controls, per-slide polish, reliability fixes, side-rail workspace, the DOMPurify sanitizer, brand fidelity |
| [azure-and-llm.md](azure-and-llm.md) | Azure AI Foundry providers, Azure audio adapters, 429 pacing, LLM gateway-lite, Anthropic prompt caching |
| [audio-and-minutes.md](audio-and-minutes.md) | Recording, speaker-aware transcription, Deepgram diarization, narration enhancement, meeting minutes, the minutes controllers |
| [research-and-capture.md](research-and-capture.md) | Web research assistant, Claude web search, web reader, quick peek, Kindle sync, newsletter digest + story memory |
| [chat-and-rag.md](chat-and-rag.md) | Free chat + projects, smart document indexing, Mermaid chat, visual (page-image) search |
| [vault-tools.md](vault-tools.md) | Obsidian Bases, canvas toolkit, find-embeds hygiene scan |
| [content-pipeline.md](content-pipeline.md) | Document extraction, chunking, digitisation, translate/integrate, export, the `applyNoteEdit` write seam, reviewed edits |
| [platform.md](platform.md) | ProgressReporter, feature toggles, workflow-stage taxonomy, the settings UI map, command picker architecture |

## Conventions

- **One H2 per subsystem**, carrying the same heading it had in AGENTS.md, so an
  existing reference or search still lands on it.
- **Add depth here, add a stub row there.** A new subsystem needs a row in AGENTS.md's
  *Feature Subsystems* table; a genuinely repo-wide rule goes in its *Cross-Cutting
  Invariants* section instead of being buried in a dossier.
- **Links are relative to this directory** (`../../src/...`, `../<doc>.md`). References
  into `docs/plans/` and `docs/completed/` resolve only in a working checkout — those
  are gitignored by design, not rot.
