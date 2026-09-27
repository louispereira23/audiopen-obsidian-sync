import { test } from "node:test";
import assert from "node:assert/strict";
import type { SyncNote } from "../src/api.ts";
import {
  contentHash,
  displayTitle,
  notePath,
  renderNote,
  safeFileName,
  toObsidianTag,
  withNumberSuffix,
} from "../src/render.ts";

function note(overrides: Partial<SyncNote> = {}): SyncNote {
  return {
    id: 42,
    created_at: Date.UTC(2026, 8, 20, 9, 30),
    modified_at: null,
    title: "Morning thoughts",
    body: "First line.\n\nSecond paragraph.",
    original_transcript: "um so first line\nand then second",
    folder_id: 7,
    pinned: false,
    note_tag_association: [
      { tag: { id: 1, tag_name: "Big Ideas" } },
      { tag: { id: 2, tag_name: "work" } },
      { tag: null },
    ],
    folders_note_mapping: { id: 7, name: "Journal", Universal: false },
    ...overrides,
  };
}

test("renders frontmatter, body and collapsed transcript", () => {
  const md = renderNote(note(), { includeTranscript: true });
  assert.match(md, /^---\ntitle: "Morning thoughts"\n/);
  const keys = [...md.split("---")[1].matchAll(/^(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ["title", "created", "modified", "folder", "tags"]);
  assert.doesNotMatch(md, /42/);
  assert.match(md, /\nfolder: "Journal"\n/);
  assert.match(md, /\ntags:\n  - "Big-Ideas"\n  - "work"\n---\n/);
  assert.match(md, /---\n\nFirst line\.\n\nSecond paragraph\.\n\n> \[!quote\]- Original transcript\n> um so first line\n> and then second\n$/);
  assert.doesNotMatch(md, /pinned/);
});

test("omits transcript when disabled or empty", () => {
  assert.doesNotMatch(renderNote(note(), { includeTranscript: false }), /transcript/);
  assert.doesNotMatch(renderNote(note({ original_transcript: "  " }), { includeTranscript: true }), /transcript/);
});

test("escapes YAML-hostile titles", () => {
  const md = renderNote(note({ title: 'He said: "hi" #1' }), { includeTranscript: false });
  assert.match(md, /title: "He said: \\"hi\\" #1"/);
});

test("universal and missing folders go to the root folder", () => {
  assert.equal(notePath("AudioPen", note()), "AudioPen/Journal/Morning thoughts.md");
  assert.equal(
    notePath("AudioPen", note({ folders_note_mapping: { id: 1, name: "All Notes", Universal: true } })),
    "AudioPen/Morning thoughts.md",
  );
  assert.equal(notePath("AudioPen", note({ folders_note_mapping: null })), "AudioPen/Morning thoughts.md");
});

test("file names drop characters that break paths or links", () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n'), "a b c d e f g h i j k l m n");
  assert.equal(safeFileName("...hidden"), "hidden");
  assert.equal(notePath(" Voice / Notes ", note({ title: "Q3: plan?" })), "Voice/Notes/Journal/Q3 plan.md");
  assert.equal(withNumberSuffix("AudioPen/Idea.md", 2), "AudioPen/Idea (2).md");
});

test("untitled notes get a dated title", () => {
  assert.match(displayTitle(note({ title: "  " })), /^Untitled 2026-09-20 \d\d:\d\d$/);
  assert.equal(notePath("AudioPen", note({ title: "///" })), "AudioPen/Journal/Untitled.md");
});

test("tags are valid Obsidian tags", () => {
  assert.equal(toObsidianTag("#Big  Ideas!"), "Big-Ideas");
  assert.equal(toObsidianTag("2026"), "_2026");
  assert.equal(toObsidianTag("café/menu"), "café/menu");
});

test("hash changes with content", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
});
