# AudioPen for Obsidian

The official AudioPen plugin. It syncs your AudioPen voice notes into your
Obsidian vault as Markdown files. Requires an AudioPen Prime plan.

## Getting started

1. In Obsidian, open **Settings → Community plugins → Browse**, search for
   **AudioPen**, then install and enable it.
2. Open the **AudioPen** plugin settings, enter your AudioPen email and select
   **Send code**.
3. Enter the code from your email and select **Connect**.

Your notes appear in an `AudioPen` folder within a few seconds.

It works in any vault: install it in your everyday vault and your notes land in
their own folder (you can rename it), or give AudioPen a vault of its own.

## How your notes look

- Each note becomes `AudioPen/<folder>/<title>.md`, grouped by your AudioPen
  folders.
- The title, dates, folder and tags are at the top as properties, followed by
  the note itself and the original transcript, folded away underneath.
- Notes with the same title are named `Title.md`, `Title (2).md`, and so on.

## When it syncs

Sync is one way, from AudioPen to Obsidian. It runs:

- when Obsidian starts,
- every 5 minutes (change this under **Sync automatically**),
- when you switch back to Obsidian,
- whenever you select the microphone icon or run **AudioPen: Sync now**.

Setting **Sync automatically** to Off leaves only startup and manual syncs.

## Your edits are safe

- **Notes you edit in Obsidian are never overwritten.** If the note later
  changes in AudioPen, that change is skipped and the sync message says so.
- **Notes you delete in Obsidian stay deleted.** **AudioPen: Full re-sync**
  brings them back.
- **Notes you move or rename in Obsidian stay where you put them** and keep
  getting updates. (A note moved while the plugin is turned off counts as
  deleted until you run a full re-sync.)
- **Notes deleted in AudioPen keep their file in Obsidian.**

## Disclosures

- **Payment required:** this plugin needs an AudioPen Prime subscription.
- **Account required:** you sign in with your AudioPen account (email and a
  one-time code).
- **Network use:** the plugin connects to AudioPen's servers
  (`xcmm-5zfz-tplj.n7c.xano.io`) to sign you in and download your notes. It
  only reads your notes; it never changes or deletes anything in AudioPen, and
  sends nothing from your vault. Your login is kept in Obsidian's secure
  storage, not in your vault.

## Help

Questions or problems: [audiopen.ai/support](https://www.audiopen.ai/support).
