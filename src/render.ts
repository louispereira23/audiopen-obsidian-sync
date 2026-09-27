import type { SyncNote } from "./api.ts";

/** Pure note → Markdown / path helpers. No Obsidian imports, so they can be
 *  unit-tested under plain Node.
 */

export type RenderOptions = {
  includeTranscript: boolean;
};

export function renderNote(note: SyncNote, options: RenderOptions): string {
  const tags = noteTags(note).map(toObsidianTag).filter((tag) => tag.length > 0);
  const folder = folderName(note);

  const frontmatter = [
    "---",
    `title: ${yamlString(displayTitle(note))}`,
    `created: ${localDateTime(note.created_at)}`,
    `modified: ${localDateTime(note.modified_at ?? note.created_at)}`,
  ];
  if (folder) frontmatter.push(`folder: ${yamlString(folder)}`);
  if (tags.length > 0) {
    frontmatter.push("tags:");
    for (const tag of unique(tags)) frontmatter.push(`  - ${yamlString(tag)}`);
  }
  if (note.pinned) frontmatter.push("pinned: true");
  frontmatter.push("---");

  const parts = [frontmatter.join("\n"), (note.body ?? "").trim()];

  const transcript = (note.original_transcript ?? "").trim();
  if (options.includeTranscript && transcript.length > 0) {
    const quoted = transcript
      .split(/\r?\n/)
      .map((line) => (line.length > 0 ? `> ${line}` : ">"))
      .join("\n");
    parts.push(`> [!quote]- Original transcript\n${quoted}`);
  }

  return parts.filter((part) => part.length > 0).join("\n\n") + "\n";
}

/** Vault-relative path the note should live at, before collision handling. */
export function notePath(root: string, note: SyncNote): string {
  const folder = folderName(note);
  const segments = [cleanRoot(root)];
  if (folder) segments.push(safeFileName(folder) || "Folder");
  segments.push(`${safeFileName(displayTitle(note)) || "Untitled"}.md`);
  return segments.filter((segment) => segment.length > 0).join("/");
}

/** Fallback path when `notePath` is taken by a different note:
 *  `Idea.md` → `Idea (2).md`.
 */
export function withNumberSuffix(path: string, n: number): string {
  return path.replace(/\.md$/, ` (${n}).md`);
}

export function displayTitle(note: SyncNote): string {
  const title = (note.title ?? "").trim();
  if (title.length > 0) return title;
  return `Untitled ${localDateTime(note.created_at).replace("T", " ").slice(0, 16)}`;
}

/** Folder name, or null for notes at the root ("Universal" folders such as
 *  All Notes are not real folders).
 */
export function folderName(note: SyncNote): string | null {
  const folder = note.folders_note_mapping;
  if (!folder || folder.Universal) return null;
  const name = (folder.name ?? "").trim();
  return name.length > 0 ? name : null;
}

export function noteTags(note: SyncNote): string[] {
  return (note.note_tag_association ?? [])
    .map((association) => association?.tag?.tag_name?.trim() ?? "")
    .filter((name) => name.length > 0);
}

/** Obsidian tags allow letters, numbers, `_`, `-` and `/`, and can't be
 *  purely numeric.
 */
export function toObsidianTag(name: string): string {
  const tag = name
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_\-/]/gu, "")
    .replace(/-{2,}/g, "-");
  return /^\d+$/.test(tag) ? `_${tag}` : tag;
}

/** Strips characters that are invalid in file names on any platform or that
 *  break Obsidian links (`# ^ [ ] |`).
 */
export function safeFileName(name: string): string {
  return withoutControlCharacters(name)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();
}

function withoutControlCharacters(text: string): string {
  return Array.from(text, (char) => (char.charCodeAt(0) < 0x20 ? " " : char)).join("");
}

export function cleanRoot(root: string): string {
  return root
    .split("/")
    .map((segment) => safeFileName(segment))
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** 32-bit FNV-1a, hex. Used to tell whether a file still holds exactly what
 *  the plugin last wrote.
 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}

/** `YYYY-MM-DDTHH:mm:ss` in local time: the format Obsidian's date-time
 *  property type reads.
 */
export function localDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** JSON strings are valid YAML double-quoted scalars. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
