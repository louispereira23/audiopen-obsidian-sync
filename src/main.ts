import { Notice, Plugin } from "obsidian";
import { AudioPenApi, AuthExpiredError, PrimeRequiredError } from "./api.ts";
import { AudioPenSettingTab, DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import { SyncEngine, emptyState, followRename, type SyncResult, type SyncState } from "./sync.ts";

/** Everything persisted to data.json. The login token is not here: it lives
 *  in Obsidian's secret storage, outside the vault.
 */
type PluginData = {
  settings: Settings;
  state: SyncState;
  lastSync: { at: number; summary: string } | null;
};

const TOKEN_SECRET_ID = "audiopen-sync-token";

/** Switching back to Obsidian syncs at most this often, so flicking between
 *  apps doesn't hit AudioPen on every focus.
 */
const RETURN_SYNC_MIN_GAP_MS = 60_000;

export default class AudioPenSyncPlugin extends Plugin {
  data!: PluginData;
  private syncing = false;
  private lastSyncStartedAt = 0;
  private autoSyncTimer: number | null = null;
  private statusBar: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.addSettingTab(new AudioPenSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();

    this.addRibbonIcon("mic", "Sync AudioPen notes", () => {
      void this.sync({ full: false, quiet: false });
    });
    this.addCommand({
      id: "sync",
      name: "Sync now",
      callback: () => void this.sync({ full: false, quiet: false }),
    });
    this.addCommand({
      id: "full-resync",
      name: "Full re-sync",
      callback: () => void this.sync({ full: true, quiet: false }),
    });

    this.app.workspace.onLayoutReady(() => {
      // Files carry no AudioPen id, so moves and renames have to be recorded
      // as they happen. Registered after layout-ready so the vault's initial
      // load doesn't fire them.
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (followRename(this.data.state, oldPath, file.path)) void this.savePluginData();
        }),
      );

      if (this.data.settings.syncOnStartup && this.isConnected()) {
        void this.sync({ full: false, quiet: true });
      }
      this.scheduleAutoSync();

      // Desktop: the window regains focus. Mobile: the app comes back to the
      // foreground, which shows up as the document becoming visible.
      this.registerDomEvent(window, "focus", () => this.syncOnReturn());
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") this.syncOnReturn();
      });
    });
  }

  /** Background sync when the user comes back to Obsidian. Follows the
   *  "Sync automatically" setting: Off means manual only.
   */
  private syncOnReturn(): void {
    if (this.data.settings.autoSyncMinutes <= 0 || !this.isConnected()) return;
    if (Date.now() - this.lastSyncStartedAt < RETURN_SYNC_MIN_GAP_MS) return;
    void this.sync({ full: false, quiet: true });
  }

  onunload(): void {
    this.clearAutoSync();
  }

  api(): AudioPenApi {
    return new AudioPenApi();
  }

  isConnected(): boolean {
    return this.token() !== null;
  }

  /** Verifies the emailed code, checks the plan, and stores the token. */
  async connect(email: string, code: string): Promise<void> {
    const api = this.api();
    const token = await api.verifyCode(email, code);
    const me = await api.me(token);
    if (me.p_account_type !== "Prime") throw new PrimeRequiredError();

    // A different account's notes shouldn't be matched against this one's.
    if (this.data.settings.email && this.data.settings.email !== email) {
      this.data.state = emptyState();
      this.data.lastSync = null;
    }
    this.app.secretStorage.setSecret(TOKEN_SECRET_ID, token);
    this.data.settings.email = email;
    await this.savePluginData();

    new Notice(`Connected to AudioPen as ${email}.`);
    void this.sync({ full: false, quiet: false });
  }

  async logOut(): Promise<void> {
    this.app.secretStorage.setSecret(TOKEN_SECRET_ID, "");
    await this.savePluginData();
  }

  async sync({ full, quiet }: { full: boolean; quiet: boolean }): Promise<void> {
    const token = this.token();
    if (!token) {
      if (!quiet) new Notice("Connect your AudioPen account in the AudioPen plugin settings first.");
      return;
    }
    if (this.syncing) {
      if (!quiet) new Notice("AudioPen sync is already running.");
      return;
    }

    this.syncing = true;
    this.lastSyncStartedAt = Date.now();
    this.statusBar?.setText("AudioPen: syncing…");
    try {
      const engine = new SyncEngine(
        this.app,
        this.api(),
        token,
        this.data.state,
        { ...this.data.settings, full },
        () => this.savePluginData(),
      );
      const result = await engine.run();
      const summary = describe(result);
      this.data.lastSync = { at: Date.now(), summary };
      await this.savePluginData();

      const changed = result.created + result.updated + result.skippedEdited.length > 0;
      if (!quiet || changed) new Notice(`AudioPen: ${summary}`, result.skippedEdited.length ? 10000 : 5000);
    } catch (error) {
      if (error instanceof AuthExpiredError) await this.logOut();
      if (!quiet || error instanceof AuthExpiredError || error instanceof PrimeRequiredError) {
        new Notice(`AudioPen: ${error instanceof Error ? error.message : String(error)}`);
      }
      console.error("AudioPen sync failed", error);
    } finally {
      this.syncing = false;
      this.statusBar?.setText("");
    }
  }

  scheduleAutoSync(): void {
    this.clearAutoSync();
    const minutes = this.data.settings.autoSyncMinutes;
    if (minutes <= 0) return;
    this.autoSyncTimer = window.setInterval(() => {
      if (this.isConnected()) void this.sync({ full: false, quiet: true });
    }, minutes * 60_000);
    this.registerInterval(this.autoSyncTimer);
  }

  lastSyncSummary(): string {
    const last = this.data.lastSync;
    if (!last) return "Not synced yet.";
    return `Last sync ${new Date(last.at).toLocaleString()}: ${last.summary}`;
  }

  async loadPluginData(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) },
      state: { ...emptyState(), ...(saved.state ?? {}) },
      lastSync: saved.lastSync ?? null,
    };
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  private token(): string | null {
    return this.app.secretStorage.getSecret(TOKEN_SECRET_ID) || null;
  }

  private clearAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }
}

function describe(result: SyncResult): string {
  const parts: string[] = [];
  if (result.created) parts.push(`${result.created} new`);
  if (result.updated) parts.push(`${result.updated} updated`);
  if (result.skippedEdited.length) {
    parts.push(`${result.skippedEdited.length} skipped because you edited them in Obsidian`);
  }
  if (result.skippedDeleted) {
    parts.push(`${result.skippedDeleted} not restored because you deleted them here (use Full re-sync)`);
  }
  return parts.length > 0 ? parts.join(", ") + "." : "everything is up to date.";
}
