# Development

```bash
npm install
npm run dev        # rebuilds main.js on change
npm test           # unit tests (render + sync engine against a fake vault)
npm run build      # typecheck + production main.js
```

To try a build in a vault, copy `main.js` and `manifest.json` into
`<vault>/.obsidian/plugins/audiopen/`, then enable **AudioPen** under
Settings → Community plugins.

## Releasing

```bash
npm version patch        # or minor / major: bumps manifest.json + versions.json, commits, tags
git push --follow-tags
```

Pushing the tag runs `.github/workflows/release.yml`, which lints, tests,
builds, attests `main.js` and `manifest.json`, and publishes the GitHub
release. `.npmrc` keeps tags free of a `v` prefix, which the Community
directory requires. `npm run lint` uses the same rules as the directory's
automated review, so run it before tagging.

Each new GitHub release reaches users as an update. The plugin is listed in
the Community directory (community.obsidian.md) as **Optional payment**: the
plugin itself is free, but it relies on a paid third-party service
(AudioPen Prime).
