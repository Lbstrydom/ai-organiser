# Slice S1 rollout checklist (for the vault owner)

Manual steps, in order. Nothing here is done for you: the plugin never edits your vault settings or your Google account on its own. Each step says how to check it worked. A feature that is not set up stays off and changes nothing. The order matters: a later step needs the one before it.

## 1. Update and turn on what you want
- Update the plugin from the community store once a release containing S1 is published. (Merging code does not ship it.)
- Features are off by default. Turn on, in *Settings > AI Organiser > Features*: **Inbox sweep**, **Google Tasks export**, **Capture inbox** (for the hand-back review), **Agent index** and **AI workspaces** (for AI project workspaces). Check: each shows its own section in settings.

## 2. Set up the inbox
- Run **Set up inbox sweep** (settings, Inbox sweep, or the command palette): choose your inbox folder(s), say what must be kept out, and read the preview. Capture inbox shares the same inbox folders. Check: the setup finishes with "Inbox sweep is set up".
- Optional: in the same *Inbox sweep* settings section, under **Reading the sweep skips**, add folders of articles and clippings (for example Web Reader, Clippings), and/or turn on **Skip clipped articles anywhere**. The sweep then leaves them alone; the capture inbox still clarifies and files them.
- Why first: your PARA inbox folder is only recognised as an inbox once a sweep or capture inbox folder points at it.

## 3. PARA folders
- *Settings > Projects > PARA folders*: add your Inbox, Projects, Areas, Reference and Archive folders (type to search, or pick from the list). Setting a folder moves nothing. Folders are kept even when a line below the rows complains; the lines say what to fix. Check: no lines under the list (an Inbox folder that is not yet an inbox folder says so; go back to step 2).

## 4. Adopt the projects you will work with
- Open each project note and run **Adopt note as project** (AI Organiser's command picker, under Refine, or the command palette). Accept the small edit (it adds a hidden id and `status: active`). Nothing is moved or renamed. Check: **Open project** (picker, under Find) lists it.

## 5. Deploy the Google script (one paste)
- Open *Settings > Google Tasks > Set up Google Tasks*. Everything from here to the end of the first half of step 6 happens in that one window, so leave it open.
- Choose **Copy script**: the plugin writes the script with your secret filled in. Do not open or paste the `.gs` file in `docs/google-script/`: it is a read-only copy with placeholders and will not work. The window says what this script gives up (whoever holds its secret could approve another list and add tasks to it); if you would rather keep the lists locked in the script text, use a *Keep lists locked* button and paste twice.
- On a phone or a second computer, do not copy a script: the secret is stored per device, and a script with a new one stops your other devices. Open **Connect this device** in the same window and paste a connection code from a device that works. The code lets whoever holds it add tasks and, on automatic lists, approve lists, so do not send it through anything shared.
- Paste it into a new project at <https://script.google.com>, add the services, and deploy as a web app, following the steps in the window ([docs/google-script/README.md](google-script/README.md) has the same steps with more detail). Paste the web app link into the window. If you use Drive inventory, paste the same link there later.
- Already deployed **Copy combined Google script** from the command palette? That is the locked kind, and it has no list yet until you choose one, so it cannot create tasks. Paste the link and choose **Test connection**; do not copy it again. Step 6 then gives you the final paste, or you can move to automatic lists later with *Your lists > Switch to automatic lists*.

## 6. Google lists and routing
- In the same window choose **Test connection** (it says which script it found), go to the next step, choose **Load my lists** and pick your main list. With the automatic script you can also tick your other lists here.
- With the automatic script, press **Finish**: the plugin approves the lists and checks that the script took them. Nothing more needs pasting.
- With a locked script, on the last step choose **Copy final combined script**: it is the same combined script, now locked to your main list. This second paste is needed because the script could not read your lists until it was deployed. Paste it over the old one and deploy a new version (same link), then **Test again** until it says Ready. Finish stays blocked until then and says why. Check: *Settings > Integrations* shows the Google script row with the module versions and capabilities.
- Then *Your lists*: add the lists you use, turn on **Ask for a date on each item** for the ones that need one, and add routing rules (kind and optional context to a list or "report only"). Rules only pre-select; you approve every item. On the automatic script a change to the list set is approved as you make it, with no trip to Google. On a locked script, after you change the list set, choose **Copy script** under *Your lists* and redeploy (new version, same link). The button checks which script your link runs and copies the combined one; if it says it could not check, use **Copy combined Google script** from the command palette instead. Check: in a sweep review each item shows a destination, and the Integrations row lists nothing waiting on a redeploy.
- Optional: turn on the **completion check** (read-only) and the **note link** (it puts your vault name and note path into the task in your own Google account; the setting says so).

## 7. AI sharing (default deny)
- *Settings > AI workspaces > Folders shared with AI apps*: add only the Areas or project folders you are happy to share with your AI apps, one per line. Everything inside a listed folder is shareable, so list the narrowest folders. Nothing is shared until a folder is listed. Notes in protected, excluded or hidden folders are never included.
- Optional, to give a project the Area's standing context: put `area: "[[Your Area]]"` in the project note's properties, and an `AI context` heading in the Area note (the Area note must also sit in a shared folder). The pack and the instructions then include that section.
- For each project: **Edit AI workspace** (add the Claude or ChatGPT project link), **Copy AI project instructions**, **Create AI context pack**. Review the list of notes in the preview, then upload the pack file yourself. Check: the pack file appears in the pack folder and the project note shows an "AI workspace" block. Writing the project link into the note does not stop later packs.
- Removing a folder stops future packs including it. A pack you already uploaded stays in that AI app until you delete it there.
- Optional, desktop only, to keep a Claude project current without uploading again (the **live pack**): in *Settings > AI workspaces > Live pack folder (writes outside the vault)* enter an existing folder inside Google Drive for desktop, outside the vault (for example `G:\My Drive\1 Projects\pkm`), and choose **Check folder**. Then in **Edit AI workspace** choose **Turn on** under *Live pack*: tick the notes it may contain (the project note is required; new notes are never ticked for you) and choose **Turn on and write to Drive**. Copy the project instructions again and paste them into the Claude project: they now tell Claude to search Google Drive for `<project> - live pack.md`. Check: the file appears in the Drive folder; edit the project note and, after the quiet time (5 minutes by default) or **Refresh live pack now**, Drive shows the change; in Drive (web) the file's id is the same after two refreshes; a **new** chat in the Claude project, also on the phone, reads the new text.
- A note that newly becomes a source is held until you tick it (**Review notes**); a change to your sharing settings pauses the live pack until you review it, and if a ticked note is no longer shared the file is replaced with a short "no longer shared" note. **Turn off** does the same. The plugin never deletes the file in Drive, and copies an AI app has already read are not taken back. Turn the live pack off on the computer that writes it; elsewhere, turning it off is a request that computer carries out the next time it runs.

## 8. Connect an AI app (optional)
- Run **Set up agent index** and then **Build agent index** first (*Settings > Agent index*, or the command palette); the connector says "No index yet" until the index exists.
- Then follow *Settings > Connect an AI app*. The connector reads only notes inside the agent index scope. If you turn on the **AI sharing switch** (*AI workspaces > Apply this list to the connector and the vault map*), it also reads only notes inside the folders listed in step 7, and the vault map lists only those. While AI workspaces are on, the connector can hand an AI app the latest context pack of a project.

## 9. Hand-backs
- End a chat session with the Handoff section the instructions ask for, save the reply as a note, open it and run **Review AI hand-back**. Tick what you want: decisions and questions become one reviewed edit to the project note; next actions go through the usual sweep review. Check: the project note has the new lines, each ending with an `aio:handoff` marker (do not delete them: they stop a repeat).
- Optional, so Claude writes the hand-back for you: install the **vault-handback** skill (`docs/skills/vault-handback/`). Upload it as a zip to claude.ai (*Settings > Capabilities > Skills*), or copy the folder to `~/.claude/skills/` for Claude Code; `docs/skills/README.md` has the commands. For file delivery, create `0 Inbox/From Claude/` yourself; otherwise the skill prints text to paste into a new note. Then ask Claude to "hand back this session".
- A hand-back note left in a sweep inbox is skipped by the sweep (it has its own review). **Process** (palette: "Open Process") lists captures to review, hand-backs with items left to review, and held tasks.

## 10. Weekly
- Run **Refresh task status** if you turned on the completion check. Look at **Process** for anything held.
