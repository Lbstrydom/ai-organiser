# Slice S1 rollout checklist (for the vault owner)

Manual steps, in order. Nothing here is done for you: the plugin never edits your vault settings or your Google account on its own. Each step says how to check it worked. A feature that is not set up stays off and changes nothing.

## 1. Update and turn on what you want
- Update the plugin from the community store once a release containing S1 is published. (Merging code does not ship it.)
- Features are off by default. Turn on, in *Settings > AI Organiser > Features*: **Inbox sweep**, **Google Tasks export**, **Capture inbox** (for the hand-back review), **Agent index** and **AI workspaces** (for AI project workspaces). Check: each shows its own section in settings.

## 2. PARA folders
- *Settings > Projects > PARA folders*: add your Inbox, Projects, Areas, Reference and Archive folders. Setting a folder moves nothing; problems (missing folder, protected, overlap) are listed under the rows. Check: no red lines under the list.

## 3. Adopt the projects you will work with
- Open each project note and run **Adopt note as project**. Accept the small edit (it adds a hidden id and `status: active`). Nothing is moved or renamed. Check: **Open project** lists it.

## 4. Google lists and routing
- Deploy the Google script first (step 5), then *Settings > Google Tasks > Your lists*: **Load my lists**, add the lists you use, mark the ones that need a date, and add routing rules (kind and optional context to a list or "report only"). Rules only pre-select; you approve every item. Check: in a sweep review each item shows a destination.
- Optional: turn on the **completion check** (read-only) and the **note link** (it puts your vault name and note path into the task in your own Google account; the setting says so).

## 5. Deploy the Google script (deploy #1)
- Follow [docs/google-script/README.md](google-script/README.md): *Copy combined Google script*, paste into a new Apps Script project, add the services, deploy as a web app, paste the same URL in the Google Tasks (and Drive inventory) settings, press Test. Check: *Settings > Integrations* shows the Google script row with the module versions and capabilities, and nothing waiting on a redeploy.
- Re-copy and redeploy (new version, same URL) whenever you change the list set.

## 6. AI sharing (default deny)
- *Settings > AI workspaces > Folders shared with AI apps*: add only the Areas or project folders you are happy to share with your AI apps, one per line. Nothing is shared until a folder is listed. Notes in protected, excluded or hidden folders are never included.
- For each project: **Edit AI workspace** (add the Claude or ChatGPT project link), **Copy AI project instructions**, **Create AI context pack**. Review the list of notes in the preview, then upload the pack file yourself. Check: the pack file appears in the pack folder and the project note shows an "AI workspace" block.
- Removing a folder stops future packs including it. A pack you already uploaded stays in that AI app until you delete it there.
- **Not in this slice**: applying the share list to the read-only connector and the chat vault map (a later change). Until then the connector keeps serving what it serves today.

## 7. Hand-backs
- End a chat session with the Handoff section the instructions ask for, save the reply as a note, open it and run **Review AI hand-back**. Tick what you want: decisions and questions become one reviewed edit to the project note; next actions go through the usual sweep review. Check: the project note has the new lines, each ending with an `aio:handoff` marker (do not delete them: they stop a repeat).
- **Process** (palette: "Open Process") lists captures to review, hand-backs with items left, and held tasks.

## 8. Weekly
- Run **Refresh task status** if you turned on the completion check. Look at **Process** for anything held.
