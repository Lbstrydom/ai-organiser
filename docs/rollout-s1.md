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

## 5. Deploy the Google script (deploy #1)
- Open *Settings > Google Tasks > Set up Google Tasks*. Everything from here to the end of the first half of step 6 happens in that one window, so leave it open.
- Choose **Copy combined script**: the plugin writes the script with your secret filled in. Do not open or paste the `.gs` file in `docs/google-script/`: it is a read-only copy with placeholders and will not work.
- Paste it into a new project at <https://script.google.com>, add the services, and deploy as a web app, following the steps in the window ([docs/google-script/README.md](google-script/README.md) has the same steps with more detail). Paste the web app link into the window. If you use Drive inventory, paste the same link there later.
- Already deployed it with **Copy combined Google script** from the command palette? That is the same script. Paste the link and choose **Test connection**; do not copy it again.

## 6. Google lists and routing
- In the same window choose **Test connection** (it says whether it found the combined script), go to the next step, choose **Load my lists** and pick your main list.
- On the last step choose **Copy final combined script**: it is the same combined script, now locked to your main list. This second paste is needed because the script could not read your lists until it was deployed. Paste it over the old one and deploy a new version (same link), then **Test again** until it says Ready. Finish stays blocked until then and says why. Check: *Settings > Integrations* shows the Google script row with the module versions and capabilities.
- Then *Your lists*: add the lists you use, mark the ones that need a date, and add routing rules (kind and optional context to a list or "report only"). Rules only pre-select; you approve every item. After you change the list set, choose **Copy script** under *Your lists* and redeploy (new version, same link). The button checks which script your link runs and copies the combined one; if it says it could not check, use **Copy combined Google script** from the command palette instead. Check: in a sweep review each item shows a destination, and the Integrations row lists nothing waiting on a redeploy.
- Optional: turn on the **completion check** (read-only) and the **note link** (it puts your vault name and note path into the task in your own Google account; the setting says so).

## 7. AI sharing (default deny)
- *Settings > AI workspaces > Folders shared with AI apps*: add only the Areas or project folders you are happy to share with your AI apps, one per line. Everything inside a listed folder is shareable, so list the narrowest folders. Nothing is shared until a folder is listed. Notes in protected, excluded or hidden folders are never included.
- Optional, to give a project the Area's standing context: put `area: "[[Your Area]]"` in the project note's properties, and an `AI context` heading in the Area note (the Area note must also sit in a shared folder). The pack and the instructions then include that section.
- For each project: **Edit AI workspace** (add the Claude or ChatGPT project link), **Copy AI project instructions**, **Create AI context pack**. Review the list of notes in the preview, then upload the pack file yourself. Check: the pack file appears in the pack folder and the project note shows an "AI workspace" block. Writing the project link into the note does not stop later packs.
- Removing a folder stops future packs including it. A pack you already uploaded stays in that AI app until you delete it there.

## 8. Connect an AI app (optional)
- Run **Set up agent index** and then **Build agent index** first (*Settings > Agent index*, or the command palette); the connector says "No index yet" until the index exists.
- Then follow *Settings > Connect an AI app*. The connector reads only notes inside the agent index scope. If you turn on the **AI sharing switch** (*AI workspaces > Apply this list to the connector and the vault map*), it also reads only notes inside the folders listed in step 7, and the vault map lists only those. While AI workspaces are on, the connector can hand an AI app the latest context pack of a project.

## 9. Hand-backs
- End a chat session with the Handoff section the instructions ask for, save the reply as a note, open it and run **Review AI hand-back**. Tick what you want: decisions and questions become one reviewed edit to the project note; next actions go through the usual sweep review. Check: the project note has the new lines, each ending with an `aio:handoff` marker (do not delete them: they stop a repeat).
- A hand-back note left in a sweep inbox is skipped by the sweep (it has its own review). **Process** (palette: "Open Process") lists captures to review, hand-backs with items left to review, and held tasks.

## 10. Weekly
- Run **Refresh task status** if you turned on the completion check. Look at **Process** for anything held.
