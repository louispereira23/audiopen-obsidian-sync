import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangesPage, ChangesQuery, Library, SyncNote } from "../src/api.ts";
import { TFile, TFolder } from "./obsidian-stub.ts";
import { SyncEngine, emptyState, followRename } from "../src/sync.ts";

class FakeVault {
  files = new Map<string, { file: TFile; content: string }>();
  folders = new Set<string>();

  getAbstractFileByPath(path: string) {
    if (this.files.has(path)) return this.files.get(path)!.file;
    if (this.folders.has(path)) return new TFolder(path);
    return null;
  }
  getMarkdownFiles() {
    return [...this.files.values()].map((entry) => entry.file);
  }
  async create(path: string, content: string) {
    assert.ok(!this.files.has(path), `create over existing ${path}`);
    const parent = path.split("/").slice(0, -1).join("/");
    assert.ok(!parent || this.folders.has(parent), `missing folder ${parent}`);
    const file = new TFile(path);
    this.files.set(path, { file, content });
    return file;
  }
  async createFolder(path: string) {
    this.folders.add(path);
  }
  async read(file: TFile) {
    return this.files.get(file.path)!.content;
  }
  async modify(file: TFile, content: string) {
    this.files.get(file.path)!.content = content;
  }
  // Test helpers acting as the user
  userEdit(path: string, content: string) {
    this.files.get(path)!.content = content;
  }
  userDelete(path: string) {
    this.files.delete(path);
  }
  userMove(from: string, to: string) {
    const entry = this.files.get(from)!;
    this.files.delete(from);
    entry.file.path = to;
    this.files.set(to, entry);
  }
  content(path: string) {
    return this.files.get(path)?.content;
  }
}

function fakeApp(vault: FakeVault) {
  return {
    vault,
    fileManager: {
      async renameFile(file: TFile, to: string) {
        vault.userMove(file.path, to);
      },
    },
  };
}

class FakeApi {
  calls: ChangesQuery[] = [];
  pages: Omit<ChangesPage, "until">[];
  folders: Library["folders"];
  constructor(pages: Omit<ChangesPage, "until">[], folders: Library["folders"]) {
    this.pages = pages;
    this.folders = folders;
  }
  async library(): Promise<Library> {
    return { folders: this.folders };
  }
  async changes(_token: string, query: ChangesQuery): Promise<ChangesPage> {
    this.calls.push(query);
    const page = this.pages[this.calls.length - 1] ?? { notes: [], deleted_note_ids: [], next_after_id: 0, has_more: false };
    return { ...page, until: 1_000 };
  }
}

function note(id: number, title: string, overrides: Partial<SyncNote> = {}): SyncNote {
  return {
    id,
    created_at: Date.UTC(2026, 8, 20),
    modified_at: null,
    title,
    body: `Body of ${title}`,
    original_transcript: null,
    folder_id: null,
    pinned: false,
    note_tag_association: [],
    folders_note_mapping: null,
    ...overrides,
  };
}

function page(notes: SyncNote[], extra: Partial<ChangesPage> = {}) {
  return { notes, deleted_note_ids: [], next_after_id: notes.at(-1)?.id ?? 0, has_more: false, ...extra };
}

async function runSync(
  vault: FakeVault,
  state: ReturnType<typeof emptyState>,
  pages: ReturnType<typeof page>[],
  full = false,
  folders: Library["folders"] = [],
) {
  const api = new FakeApi(pages, folders);
  const engine = new SyncEngine(
    fakeApp(vault) as never,
    api as never,
    "token",
    state,
    { folder: "AudioPen", includeTranscript: true, full },
    async () => {},
  );
  return { result: await engine.run(), api };
}

test("first sync creates files in folders and records the cursor", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  const { result } = await runSync(vault, state, [
    page([note(1, "Idea"), note(2, "Plan", { folders_note_mapping: { id: 5, name: "Work", Universal: false } })]),
  ]);
  assert.equal(result.created, 2);
  assert.match(vault.content("AudioPen/Idea.md")!, /Body of Idea/);
  assert.match(vault.content("AudioPen/Work/Plan.md")!, /Body of Plan/);
  assert.equal(state.lastSyncedUntil, 1_000);
});

test("pages are fetched with a fixed until and advancing after_id", async () => {
  const vault = new FakeVault();
  const { api } = await runSync(vault, emptyState(), [
    page([note(1, "A")], { has_more: true }),
    page([note(2, "B")]),
  ]);
  assert.deepEqual(
    api.calls.map((c) => [c.since, c.until, c.afterId]),
    [[null, null, 0], [null, 1_000, 1]],
  );
  assert.equal(vault.files.size, 2);
});

test("untouched files follow AudioPen edits and title changes", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea")])]);
  const { result } = await runSync(vault, state, [page([note(1, "Better idea", { body: "New body" })])]);
  assert.equal(result.updated, 1);
  assert.equal(vault.content("AudioPen/Idea.md"), undefined);
  assert.match(vault.content("AudioPen/Better idea.md")!, /New body/);
  assert.equal(state.notes["1"].path, "AudioPen/Better idea.md");
});

test("files edited in Obsidian are skipped, not overwritten", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea")])]);
  vault.userEdit("AudioPen/Idea.md", vault.content("AudioPen/Idea.md") + "\nMy own thoughts\n");
  const { result } = await runSync(vault, state, [page([note(1, "Idea", { body: "Changed in AudioPen" })])]);
  assert.deepEqual(result.skippedEdited, ["AudioPen/Idea.md"]);
  assert.match(vault.content("AudioPen/Idea.md")!, /My own thoughts/);
  assert.doesNotMatch(vault.content("AudioPen/Idea.md")!, /Changed in AudioPen/);
});

test("files deleted in Obsidian stay deleted until a full re-sync", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea")])]);
  vault.userDelete("AudioPen/Idea.md");

  const incremental = await runSync(vault, state, [page([note(1, "Idea", { body: "v2" })])]);
  assert.equal(incremental.result.skippedDeleted, 1);
  assert.equal(vault.files.size, 0);

  const full = await runSync(vault, state, [page([note(1, "Idea", { body: "v2" })])], true);
  assert.equal(full.result.created, 1);
  assert.match(vault.content("AudioPen/Idea.md")!, /v2/);
});

test("files the user moved are updated in place, not moved back", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea")])]);
  vault.folders.add("Projects");
  vault.userMove("AudioPen/Idea.md", "Projects/Idea.md");
  followRename(state, "AudioPen/Idea.md", "Projects/Idea.md");
  const { result } = await runSync(vault, state, [page([note(1, "Renamed", { body: "v2" })])]);
  assert.equal(result.updated, 1);
  assert.match(vault.content("Projects/Idea.md")!, /v2/);
  assert.equal(vault.content("AudioPen/Renamed.md"), undefined);
});

test("renaming a folder keeps its notes tracked", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  const work = { folders_note_mapping: { id: 5, name: "Work", Universal: false } };
  await runSync(vault, state, [page([note(1, "Plan", work)])]);
  followRename(state, "AudioPen/Work", "AudioPen/Work stuff");
  assert.equal(state.notes["1"].path, "AudioPen/Work stuff/Plan.md");
  assert.equal(state.notes["1"].autoPath, "AudioPen/Work/Plan.md");
});

test("notes deleted in AudioPen keep their file", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea")])]);
  await runSync(vault, state, [page([], { deleted_note_ids: [1] })]);
  assert.ok(vault.content("AudioPen/Idea.md"));
  assert.equal(state.notes["1"], undefined);
});

test("notes with the same title get numbered names, never the note id", async () => {
  const vault = new FakeVault();
  await runSync(vault, emptyState(), [page([note(101, "Idea"), note(202, "Idea"), note(303, "Idea")])]);
  assert.deepEqual([...vault.files.keys()].sort(), [
    "AudioPen/Idea (2).md",
    "AudioPen/Idea (3).md",
    "AudioPen/Idea.md",
  ]);
  for (const { content } of vault.files.values()) assert.doesNotMatch(content, /\b(101|202|303)\b/);
});

test("an unrelated file with the same name is left alone and reported", async () => {
  const vault = new FakeVault();
  vault.folders.add("AudioPen");
  await vault.create("AudioPen/Idea.md", "my own file");
  const { result } = await runSync(vault, emptyState(), [page([note(1, "Idea")])]);
  assert.equal(vault.content("AudioPen/Idea.md"), "my own file");
  assert.deepEqual(result.skippedEdited, ["AudioPen/Idea.md"]);
  assert.equal(vault.files.size, 1);
});

test("after plugin data is lost, unchanged files are adopted and edited ones are not duplicated", async () => {
  const vault = new FakeVault();
  await runSync(vault, emptyState(), [page([note(1, "Idea"), note(2, "Plan")])]);
  vault.userEdit("AudioPen/Plan.md", "my rewrite");

  const fresh = emptyState();
  const { result } = await runSync(vault, fresh, [page([note(1, "Idea"), note(2, "Plan")])], true);
  assert.equal(result.created, 0);
  assert.equal(vault.files.size, 2);
  assert.equal(fresh.notes["1"].path, "AudioPen/Idea.md");
  assert.equal(vault.content("AudioPen/Plan.md"), "my rewrite");
  assert.deepEqual(result.skippedEdited, ["AudioPen/Plan.md"]);
});

const WORK = { id: 5, name: "Work", Universal: false };
const ALL_NOTES = { id: 1, name: "All Notes", Universal: true };
const inWork = { folders_note_mapping: WORK };

test("unfiled notes stay in the root folder while the user has no folders", async () => {
  const vault = new FakeVault();
  await runSync(vault, emptyState(), [page([note(1, "Idea")])], false, [ALL_NOTES]);
  assert.ok(vault.content("AudioPen/Idea.md"));
});

test("unfiled notes go in Uncategorized once the user has a folder", async () => {
  const vault = new FakeVault();
  await runSync(vault, emptyState(), [page([note(1, "Idea"), note(2, "Plan", inWork)])], false, [ALL_NOTES, WORK]);
  assert.ok(vault.content("AudioPen/Uncategorized/Idea.md"));
  assert.ok(vault.content("AudioPen/Work/Plan.md"));
});

test("the first folder moves existing unfiled notes, keeping edits and user moves", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea"), note(2, "Draft"), note(3, "Kept"), note(4, "Plan", inWork)])]);
  vault.userEdit("AudioPen/Draft.md", "my rewrite");
  vault.folders.add("Projects");
  vault.userMove("AudioPen/Kept.md", "Projects/Kept.md");
  followRename(state, "AudioPen/Kept.md", "Projects/Kept.md");

  // No note changed; the user just created a folder in AudioPen.
  await runSync(vault, state, [page([])], false, [WORK]);
  assert.ok(vault.content("AudioPen/Uncategorized/Idea.md"));
  assert.equal(vault.content("AudioPen/Uncategorized/Draft.md"), "my rewrite");
  assert.ok(vault.content("Projects/Kept.md"));
  assert.ok(vault.content("AudioPen/Work/Plan.md"));
  assert.equal(vault.content("AudioPen/Idea.md"), undefined);

  // Edits made after the move are still recognised as edits.
  vault.userEdit("AudioPen/Uncategorized/Idea.md", "edited later");
  const { result } = await runSync(vault, state, [page([note(1, "Idea", { body: "v2" })])], false, [WORK]);
  assert.deepEqual(result.skippedEdited, ["AudioPen/Uncategorized/Idea.md"]);
});

test("deleting the last folder moves unfiled notes back to the root folder", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea"), note(2, "Plan", inWork)])], false, [WORK]);
  await runSync(vault, state, [page([])], false, []);
  assert.ok(vault.content("AudioPen/Idea.md"));
  assert.equal(vault.content("AudioPen/Uncategorized/Idea.md"), undefined);
  assert.ok(vault.content("AudioPen/Work/Plan.md"));
});

test("state saved before unfiled tracking still moves root notes", async () => {
  const vault = new FakeVault();
  const state = emptyState();
  await runSync(vault, state, [page([note(1, "Idea"), note(2, "Plan", inWork)])]);
  delete state.useUncategorized;
  for (const tracked of Object.values(state.notes)) delete tracked.unfiled;

  await runSync(vault, state, [page([])], false, [WORK]);
  assert.ok(vault.content("AudioPen/Uncategorized/Idea.md"));
  assert.ok(vault.content("AudioPen/Work/Plan.md"));
});
