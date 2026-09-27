// The same rules Obsidian's Community directory uses to scan releases.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Tests run under Node and are not part of the shipped plugin.
  { ignores: ["main.js", "node_modules/", "*.mjs", "test/"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
    rules: {
      // Passing brands replaces the rule's built-in list, so include every
      // proper noun the UI uses.
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["AudioPen Prime", "AudioPen", "Obsidian"] }],
    },
  },
]);
