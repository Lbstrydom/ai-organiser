# The Google script

**Do not paste the `.gs` file in this folder.** It has no real secret or ids and will not work. The plugin generates the script for you: start from *Settings > AI Organiser > Google Tasks > Set up Google Tasks*.

One Google Apps Script deployment that serves **Google Tasks** (named lists, due dates, read-only completion check) and, if you use it, the **Drive folder inventory**. One URL, one secret.

The setup window copies the exact script with your secret filled in. Scripts come in two kinds:

- **Automatic lists** (the setup window's main choice): you paste once. The script keeps its approved lists in its own settings and the plugin sets them when you act, so changing your lists takes no trip to Google. [What this gives up](#what-the-script-can-and-cannot-do).
- **Lists locked in the script text** (the *Keep lists locked* buttons, and the command **Copy combined Google script** unless you already use automatic lists): you paste twice now and again after each list change. Nobody can change the lists without opening your script. The file next to this one, `aio-google-script-v2.template.gs`, is this kind, with placeholders, so you can read it before you trust it.

## Paste and deploy

1. In Obsidian open *Settings > AI Organiser > Google Tasks > Set up Google Tasks* and choose **Copy script**. The script is on your clipboard. (If you use the Drive inventory, the plugin uses the same secret for it, in its own secret storage.)
2. Go to <https://script.google.com> and create a **new project**. Delete the sample code and paste the script.
3. Click **Services** (the + beside it) and add **Google Tasks API**. If the script includes the inventory, also add **Drive API** (version v3).
4. **Deploy > New deployment > Web app**. Execute as **Me**; who has access: **Anyone** (the secret is what protects it). Copy the **web app URL**.
5. Back in the setup window: paste the URL and choose **Test connection**. If you use the inventory, paste **the same URL** in *Drive folder inventory* and press **Test** there.
6. The first time, Google asks you to authorise the script for your own account. Approve it.
7. Choose your lists in the window and press **Finish**. The plugin approves them and checks that the script took them. Nothing more needs pasting.

If you chose to keep the lists locked, the last step instead gives you **Copy final combined script**: paste it over the old code and choose **Deploy > Manage deployments > Edit > New version**. That second paste is needed because a locked script cannot read your lists until it is deployed. If you run **Copy combined Google script** before choosing a list, the script has no list yet: it deploys fine and cannot create tasks until you do this step.

**Later changes.** On automatic lists, adding or removing a list under *Your lists* needs nothing from Google. On locked lists, choose **Copy script** under *Your lists* (it checks which script your link runs). Either way, when you change Drive roots, run **Copy combined Google script**, because Drive roots always stay in the script text. To paste over, paste it over the old code and choose **Deploy > Manage deployments > Edit > New version**. The URL stays the same.

## Switching an existing script to automatic lists

*Your lists > Switch to automatic lists* copies the automatic script with the same secret. Paste it over the old code, deploy a new version of the same deployment, then choose **Finish the switch**. The link stays the same and the tasks already sent stay known to the script. Nothing changes until you do this. To go back, paste a locked script over it: the locked script ignores the stored lists and enforces its text again.

## What the script can and cannot do

- **Tasks**: create tasks in the approved lists (nothing else), and read whether the tasks **it created** are done. It never edits, completes, moves or deletes a task, and it cannot create or remove a list.
- **Inventory**: list file names, sizes and checksums inside the approved Drive folders and their subfolders. It never writes, shares or reads file contents.
- Google's own permission screen is wider than that (the Tasks service and the Drive API are account-wide); **the script, not Google, enforces the approved lists and folders**.

What someone holding the URL and the secret can do depends on the kind of script:

| | Locked in the script text | Automatic lists |
|---|---|---|
| Read all list titles | Yes | Yes |
| Create tasks in approved lists | Yes | Yes |
| Create tasks in any other list | **No** | **Yes**: they can approve it first, at most 8 at a time |
| Read the status of tasks the script created | Yes | Yes |
| Read other tasks; edit, complete, move or delete anything; create or remove lists | No | No |
| Read a list's contents after approving it | No | No |

So with automatic lists the lock still stops plugin bugs and routing mistakes, but it does not stop someone who has your secret: the real harm is unwanted or misleading tasks in any of your lists, not disclosure. The approved lists are in *Project Settings > Script properties*, so reading the script text alone no longer tells you what is approved. The plugin warns when the script approves a list you did not set up here; that detects a change, it does not prevent one. Drive folders stay in the script text in both kinds, and an export never changes the lists. Only your own action in the plugin does.

The script removes its oldest receipts once its storage nears Google's limit, so exports keep working. A removed receipt does not risk a duplicate (the task's marker is still found, and the task stays tied to its list), but the completion check then reports that task as unknown. Locked scripts have no such clean-up.

## Using a phone or another computer

The script's secret is stored on each device separately, so a new device starts without it. Do not copy a new script there: a script with a new secret stops your other devices once it is deployed.

1. On a device that works, open the Google Tasks setup window, open **Connect this device** and choose **Copy connection code**.
2. Get the code to the new device through something only you can read. It lets whoever holds it add tasks to your Google lists and, on automatic lists, approve other lists. Do not send it through anything shared, and do not keep it in a note.
3. On the new device, paste it into **Connection code** and choose **Connect**. It is saved only if your script accepts it.

With no working device, paste the secret from the `var SECRET` line in the script editor instead, with the web app link in the link field. If you cannot open the script either, **Replace secret** makes a new one and copies a script containing it. Your other devices then need connecting again.

To rotate the secret, regenerate it in the plugin and copy the script again.

## Older plugin versions

The standalone scripts (one for Tasks, one for the inventory) are unchanged and keep working. A plugin older than this one cannot read the combined script's answers: keep using the standalone script there.
