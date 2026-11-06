# The combined Google script (deploy #1)

**Do not paste the `.gs` file in this folder.** It has no real secret or ids and will not work. The plugin generates the script for you: start from *Settings > AI Organiser > Google Tasks > Set up Google Tasks*.

One Google Apps Script deployment that serves **Google Tasks** (named lists, due dates, read-only completion check) and, if you use it, the **Drive folder inventory**. One URL, one secret.

The setup window copies the exact script, with your secret and your lists already filled in. The command **Copy combined Google script** copies the same script when you need it outside the window. The file next to this one, `aio-google-script-v2.template.gs`, is the same script with placeholders so you can read it before you trust it.

## Paste and deploy

1. In Obsidian open *Settings > AI Organiser > Google Tasks > Set up Google Tasks* and choose **Copy combined script**. The script is on your clipboard. (If you use the Drive inventory, the plugin uses the same secret for it, in its own secret storage.)
2. Go to <https://script.google.com> and create a **new project**. Delete the sample code and paste the script.
3. Click **Services** (the + beside it) and add **Google Tasks API**. If the script includes the inventory, also add **Drive API** (version v3).
4. **Deploy > New deployment > Web app**. Execute as **Me**; who has access: **Anyone** (the secret is what protects it). Copy the **web app URL**.
5. Back in the setup window: paste the URL and choose **Test connection**. If you use the inventory, paste **the same URL** in *Drive folder inventory* and press **Test** there.
6. The first time, Google asks you to authorise the script for your own account. Approve it.
7. Choose your main list in the window, then on its last step choose **Copy final combined script**, paste it over the old code and choose **Deploy > Manage deployments > Edit > New version**. You paste twice because the script cannot read your lists until it is deployed.

When you later change your lists, choose **Copy script** under *Your lists* (it checks which script your link runs); when you change Drive roots, run **Copy combined Google script**. Paste it over the old code and choose **Deploy > Manage deployments > Edit > New version**. The URL stays the same.

## What the script can and cannot do

- **Tasks**: create tasks in the lists the script lists as approved (nothing else), and read whether the tasks **it created** are done. It never edits, completes, moves or deletes a task, and it cannot create or remove a list.
- **Inventory**: list file names, sizes and checksums inside the approved Drive folders and their subfolders. It never writes, shares or reads file contents.
- Google's own permission screen is wider than that (the Tasks service and the Drive API are account-wide); **the script, not Google, enforces the approved lists and folders**. Anyone holding the URL and the secret can do exactly the things above and no more. To rotate the secret, regenerate it in the plugin and copy the script again.

## Older plugin versions

The standalone scripts (one for Tasks, one for the inventory) are unchanged and keep working. A plugin older than this one cannot read the combined script's answers: keep using the standalone script there.
