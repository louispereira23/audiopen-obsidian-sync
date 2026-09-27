// Minimal stand-ins for the Obsidian runtime, which has no Node build.
// test/setup.ts points the "obsidian" import at this file.
export class TAbstractFile {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export const normalizePath = (p: string) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
