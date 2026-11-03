import { type App, type TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import type { AudioPenApi, SyncNote } from "./api.ts";
import {
  UNCATEGORIZED_FOLDER,
  cleanRoot,
  contentHash,
  displayTitle,
  folderName,
  notePath,
  renderNote,
  withNumberSuffix,
  type RenderOptions,
} from "./render.ts";

/** What the plugin remembers about each note it has written. Files carry no
 *  AudioPen id, so this record is the only link between a note and its file.
 */
export type TrackedNote = {
  /** Where the file is now, kept current by `followRename`. */
  path: string;
  /** Hash of the exact content last written, to tell whether the user edited it. */
  hash: string;
  /** Where the plugin last put the file. If `path` differs, the user moved it
   *  and the plugin leaves it there. Defaults to `path` when missing.
   */
  autoPath?: string;
  /** The note had no AudioPen folder when last synced. When missing, a file
   *  sitting directly in the root folder counts as unfiled.
   */
  unfiled?: boolean;
};

export type SyncState = {
  /** Server `until` of the last completed sync; null before the first one. */
  lastSyncedUntil: number | null;
  /** Whether unfiled notes were last placed in the Uncategorized folder. */
  useUncategorized?: boolean;
  notes: Record<string, TrackedNote>;
};

export type SyncOptions = RenderOptions & {
  folder: string;
  /** Full re-sync: fetch every note and recreate files deleted in Obsidian. */
  full: boolean;
};

export type SyncResult = {
  created: number;
  updated: number;
  /** Notes whose file was edited in Obsidian, so AudioPen's version was not written. */
  skippedEdited: string[];
  /** Notes whose file was deleted in Obsidian (restored only by a full re-sync). */
  skippedDeleted: number;
  /** Titles of notes the vault refused to save; the next sync tries them again. */
  failed: string[];
};

const PAGE_SIZE = 50;
const MAX_NAME_SUFFIX = 100;

export function emptyState(): SyncState {
  return { lastSyncedUntil: null, notes: {} };
}

/** Keeps tracked paths current when the user moves or renames a file or a
 *  folder in Obsidian. Returns whether anything changed.
 */
export function followRename(state: SyncState, oldPath: string, newPath: string): boolean {
  let changed = false;
  for (const tracked of Object.values(state.notes)) {
    let next: string | null = null;
    if (tracked.path === oldPath) next = newPath;
    else if (tracked.path.startsWith(`${oldPath}/`)) next = newPath + tracked.path.slice(oldPath.length);
    if (next !== null) {
      tracked.autoPath ??= tracked.path;
      tracked.path = next;
      changed = true;
    }
  }
  return changed;
}

export class SyncEngine {
  private readonly app: App;
  private readonly api: AudioPenApi;
  private readonly token: string;
  private readonly state: SyncState;
  private readonly options: SyncOptions;
  /** Called after every page so progress survives an interrupted sync. */
  private readonly persist: () => Promise<void>;
  /** path → id of the note tracked there. */
  private owners = new Map<string, string>();
  /** Unfiled notes go in root/Uncategorized once the user has any folder. */
  private useUncategorized = false;

  constructor(
    app: App,
    api: AudioPenApi,
    token: string,
    state: SyncState,
    options: SyncOptions,
    persist: () => Promise<void>,
  ) {
    this.app = app;
    this.api = api;
    this.token = token;
    this.state = state;
    this.options = options;
    this.persist = persist;
  }

  async run(): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, skippedEdited: [], skippedDeleted: 0, failed: [] };
    this.owners.clear();
    for (const [id, tracked] of Object.entries(this.state.notes)) this.owners.set(tracked.path, id);

    // Creating or deleting a folder doesn't change any note, so the folder
    // list is checked on every sync.
    const library = await this.api.library(this.token);
    this.useUncategorized = library.folders.some((folder) => !folder.Universal);

    const since = this.options.full ? null : this.state.lastSyncedUntil;
    let until: number | null = null;
    let afterId = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await this.api.changes(this.token, { since, until, afterId, perPage: PAGE_SIZE });
      until = page.until;
      for (const note of page.notes) {
        // One note the vault won't take must not hold back every note after it.
        try {
          await this.applyNote(note, result);
        } catch (error) {
          console.error(`AudioPen: couldn't save note ${note.id}`, error);
          result.failed.push(displayTitle(note));
        }
      }
      // Notes deleted in AudioPen keep their Obsidian file; the plugin just
      // stops tracking them.
      for (const id of page.deleted_note_ids) this.untrack(String(id));
      afterId = page.next_after_id;
      hasMore = page.has_more && page.notes.length > 0;
      await this.persist();
    }

    if ((this.state.useUncategorized ?? false) !== this.useUncategorized) {
      await this.moveUnfiledNotes();
    }
    this.state.useUncategorized = this.useUncategorized;
    // After a failure the next sync starts where this one did, so it fetches
    // the failed note again instead of moving past it for good.
    this.state.lastSyncedUntil = result.failed.length > 0 ? since : until;
    await this.persist();
    return result;
  }

  private async applyNote(note: SyncNote, result: SyncResult): Promise<void> {
    const key = String(note.id);
    const tracked = this.state.notes[key];
    const content = renderNote(note, this.options);
    const hash = contentHash(content);
    const desired = this.inVaultCase(normalizePath(notePath(this.options.folder, note, this.useUncategorized)));
    const unfiled = folderName(note) === null;

    const file = tracked ? this.fileAt(tracked.path) : null;
    if (tracked && file) {
      const current = await this.app.vault.read(file);
      if (current === content) {
        this.track(key, file.path, hash, tracked.autoPath ?? tracked.path, unfiled);
        return;
      }
      if (contentHash(current) !== tracked.hash) {
        result.skippedEdited.push(file.path);
        return;
      }
      await this.app.vault.modify(file, content);
      const autoPath = tracked.autoPath ?? tracked.path;
      // Record the new content before any rename, so a rename that fails
      // can't make the next sync take this file for one the user edited.
      this.track(key, file.path, hash, autoPath, unfiled);

      // Follow AudioPen title / folder changes, but only if the file is still
      // where the plugin put it. A file the user moved stays where they put it.
      if (file.path === autoPath && file.path !== desired) {
        const target = await this.renameTarget(desired, file.path);
        if (target !== file.path) await this.app.fileManager.renameFile(file, target);
        this.track(key, target, hash, target, unfiled);
      }
      result.updated++;
      return;
    }

    if (tracked && !this.options.full) {
      result.skippedDeleted++;
      return;
    }
    await this.place(key, desired, content, hash, unfiled, result);
  }

  /** After the user creates their first AudioPen folder or deletes their
   *  last one, moves unfiled notes between the root folder and
   *  root/Uncategorized. Only files still where the plugin put them move;
   *  edited files move too, since moving doesn't touch their content.
   */
  private async moveUnfiledNotes(): Promise<void> {
    const root = this.inVaultCase(normalizePath(cleanRoot(this.options.folder)));
    const uncategorized = this.inVaultCase(normalizePath(`${root}/${UNCATEGORIZED_FOLDER}`));
    const [from, to] = this.useUncategorized ? [root, uncategorized] : [uncategorized, root];

    for (const [key, tracked] of Object.entries(this.state.notes)) {
      const autoPath = tracked.autoPath ?? tracked.path;
      const unfiled = tracked.unfiled ?? parentOf(autoPath) === root;
      if (!unfiled || tracked.path !== autoPath || parentOf(autoPath) !== from) continue;
      const file = this.fileAt(tracked.path);
      if (!file) continue;

      const fileName = file.path.split("/").pop() ?? file.path;
      const target = await this.renameTarget(normalizePath(`${to}/${fileName}`), file.path);
      if (target !== file.path) await this.app.fileManager.renameFile(file, target);
      this.track(key, target, tracked.hash, target, true);
    }
  }

  /** Puts a note that has no file yet at `desired`, or `desired (2)`,
   *  `(3)`… when another note owns that name. An untracked file already at a
   *  candidate path is either this note's file from a lost or other-device
   *  plugin state, or something the user made: identical content is adopted,
   *  anything else is left alone and reported rather than duplicated. Names
   *  that differ only in capitals count as the same name (see `findIgnoringCase`).
   */
  private async place(
    key: string,
    desired: string,
    content: string,
    hash: string,
    unfiled: boolean,
    result: SyncResult,
  ): Promise<void> {
    for (let n = 1; n <= MAX_NAME_SUFFIX; n++) {
      const path = n === 1 ? desired : withNumberSuffix(desired, n);
      const existing = this.findIgnoringCase(path);
      if (!existing) {
        await this.ensureFolder(parentOf(path));
        await this.app.vault.create(path, content);
        this.track(key, path, hash, path, unfiled);
        result.created++;
        return;
      }
      if (this.owners.has(existing.path) || !(existing instanceof TFile)) continue;
      if ((await this.app.vault.read(existing)) === content) {
        this.track(key, existing.path, hash, existing.path, unfiled);
        return;
      }
      result.skippedEdited.push(existing.path);
      return;
    }
    throw new Error(`Too many notes named "${desired}".`);
  }

  /** First free path among `desired`, `desired (2)`, … for moving an existing
   *  file, never touching any other file.
   */
  private async renameTarget(desired: string, currentPath: string): Promise<string> {
    for (let n = 1; n <= MAX_NAME_SUFFIX; n++) {
      const path = n === 1 ? desired : withNumberSuffix(desired, n);
      const existing = this.findIgnoringCase(path);
      // The file itself, even under new capitals, doesn't block its own name.
      if (existing?.path === currentPath) return path;
      if (!existing) {
        await this.ensureFolder(parentOf(path));
        return path;
      }
    }
    return currentPath;
  }

  /** The file or folder at `path`, matching names regardless of capitals.
   *  Windows and macOS keep "Idea.md" and "idea.md" as one file, and
   *  Obsidian refuses to create the second ("File already exists."), so
   *  every "is this name free?" check goes through here, on every platform,
   *  which also keeps a vault safe to open on another computer.
   */
  private findIgnoringCase(path: string): TAbstractFile | null {
    const exact = this.app.vault.getAbstractFileByPath(path);
    if (exact) return exact;
    let found: TAbstractFile | null = this.app.vault.getRoot();
    for (const segment of path.split("/")) {
      found = found instanceof TFolder ? childIgnoringCase(found, segment) : null;
      if (!found) return null;
    }
    return found;
  }

  /** `path` with each leading folder that already exists spelled the way the
   *  vault has it, so notes for AudioPen folders "Ideas" and "ideas" share
   *  one Obsidian folder instead of failing to create a second.
   */
  private inVaultCase(path: string): string {
    const segments = path.split("/");
    let folder = this.app.vault.getRoot();
    for (let i = 0; i < segments.length; i++) {
      const match = childIgnoringCase(folder, segments[i]);
      if (!(match instanceof TFolder)) break;
      segments[i] = match.name;
      folder = match;
    }
    return segments.join("/");
  }

  private track(key: string, path: string, hash: string, autoPath: string, unfiled: boolean): void {
    this.untrack(key);
    this.state.notes[key] = { path, hash, autoPath, unfiled };
    this.owners.set(path, key);
  }

  private untrack(key: string): void {
    const previous = this.state.notes[key];
    if (previous && this.owners.get(previous.path) === key) this.owners.delete(previous.path);
    delete this.state.notes[key];
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    let current = "";
    for (const segment of folder.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Can't create folder "${current}": a file has that name.`);
      await this.app.vault.createFolder(current);
    }
  }

  private fileAt(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }
}

function childIgnoringCase(folder: TFolder, name: string): TAbstractFile | null {
  const wanted = name.toLowerCase();
  return folder.children.find((child) => child.name.toLowerCase() === wanted) ?? null;
}

function parentOf(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}
