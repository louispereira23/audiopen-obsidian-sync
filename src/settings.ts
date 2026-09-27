import { type App, Notice, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type AudioPenSyncPlugin from "./main.ts";

export type Settings = {
  /** Email of the connected AudioPen account (the token lives in secret storage). */
  email: string;
  folder: string;
  includeTranscript: boolean;
  /** 0 = off. */
  autoSyncMinutes: number;
  syncOnStartup: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  email: "",
  folder: "AudioPen",
  includeTranscript: true,
  autoSyncMinutes: 5,
  syncOnStartup: true,
};

type ControlKey = "folder" | "includeTranscript" | "autoSyncMinutes" | "syncOnStartup";

const AUTO_SYNC_CHOICES: Record<string, string> = {
  "0": "Off",
  "5": "Every 5 minutes",
  "15": "Every 15 minutes",
  "30": "Every 30 minutes",
  "60": "Every hour",
  "360": "Every 6 hours",
};

export class AudioPenSettingTab extends PluginSettingTab {
  private readonly plugin: AudioPenSyncPlugin;
  /** Email the login code was sent to, while waiting for the code. */
  private pendingEmail: string | null = null;
  private emailInput = "";
  private codeInput = "";
  private busy = false;

  constructor(app: App, plugin: AudioPenSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
    const connected = () => this.plugin.isConnected();
    return [
      {
        type: "group",
        heading: "Account",
        items: [
          {
            name: "Connected",
            desc: `Signed in as ${this.plugin.data.settings.email}.`,
            visible: connected,
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Log out").onClick(async () => {
                  await this.plugin.logOut();
                  this.update();
                }),
              );
            },
          },
          {
            name: "AudioPen email",
            desc: "We'll email you a one-time code. Syncing needs AudioPen Prime.",
            visible: () => !connected() && this.pendingEmail === null,
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder("you@example.com")
                    .setValue(this.emailInput)
                    .onChange((value) => (this.emailInput = value.trim())),
                )
                .addButton((button) =>
                  button
                    .setButtonText("Send code")
                    .setCta()
                    .setDisabled(this.busy)
                    .onClick(() => this.sendCode()),
                );
            },
          },
          {
            name: "Login code",
            desc: `Enter the code we emailed to ${this.pendingEmail ?? "you"}.`,
            searchable: false,
            visible: () => !connected() && this.pendingEmail !== null,
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder("1234")
                    .setValue(this.codeInput)
                    .onChange((value) => (this.codeInput = value.trim())),
                )
                .addButton((button) =>
                  button
                    .setButtonText("Connect")
                    .setCta()
                    .setDisabled(this.busy)
                    .onClick(() => this.connect()),
                )
                .addExtraButton((button) =>
                  button
                    .setIcon("x")
                    .setTooltip("Use a different email")
                    .onClick(() => {
                      this.pendingEmail = null;
                      this.update();
                    }),
                );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Sync",
        items: [
          {
            name: "Folder",
            desc: "Where your notes go in this vault. Applies to notes synced from now on.",
            control: { type: "text", key: "folder", placeholder: DEFAULT_SETTINGS.folder },
          },
          {
            name: "Include original transcript",
            desc: "Adds the raw transcript under each note, collapsed. Run a full re-sync to apply to existing notes.",
            control: { type: "toggle", key: "includeTranscript" },
          },
          {
            name: "Sync automatically",
            desc: "Also checks for new notes when you switch back to Obsidian. Off means you sync by hand.",
            control: { type: "dropdown", key: "autoSyncMinutes", options: AUTO_SYNC_CHOICES },
          },
          {
            name: "Sync when Obsidian starts",
            control: { type: "toggle", key: "syncOnStartup" },
          },
          {
            name: "Sync now",
            desc: this.plugin.lastSyncSummary(),
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText("Sync now")
                  .setDisabled(!connected())
                  .onClick(async () => {
                    await this.plugin.sync({ full: false, quiet: false });
                    this.update();
                  }),
              );
            },
          },
          {
            name: "Full re-sync",
            desc:
              "Downloads every note again and restores files you deleted here. " +
              "Notes you edited in Obsidian are still left alone.",
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText("Full re-sync")
                  .setDisabled(!connected())
                  .onClick(async () => {
                    await this.plugin.sync({ full: true, quiet: false });
                    this.update();
                  }),
              );
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.data.settings;
    // The dropdown works in strings; the setting is stored as a number.
    if (key === "autoSyncMinutes") return String(settings.autoSyncMinutes);
    return settings[key as ControlKey];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.data.settings;
    switch (key as ControlKey) {
      case "folder":
        settings.folder = String(value).trim() || DEFAULT_SETTINGS.folder;
        break;
      case "autoSyncMinutes":
        settings.autoSyncMinutes = Number(value);
        this.plugin.scheduleAutoSync();
        break;
      case "includeTranscript":
        settings.includeTranscript = Boolean(value);
        break;
      case "syncOnStartup":
        settings.syncOnStartup = Boolean(value);
        break;
    }
    await this.plugin.savePluginData();
  }

  private sendCode(): Promise<void> {
    return this.withBusy(async () => {
      const email = this.emailInput.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        new Notice("Enter a valid email address.");
        return;
      }
      await this.plugin.api().requestCode(email);
      this.pendingEmail = email;
      this.codeInput = "";
      new Notice(`Code sent to ${email}.`);
    });
  }

  private connect(): Promise<void> {
    return this.withBusy(async () => {
      if (this.pendingEmail === null) return;
      if (this.codeInput.length === 0) {
        new Notice("Enter the code from your email.");
        return;
      }
      await this.plugin.connect(this.pendingEmail, this.codeInput);
      this.pendingEmail = null;
      this.codeInput = "";
    });
  }

  private async withBusy(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await action();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.update();
    }
  }
}
