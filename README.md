# Wayback Linker

Wayback Linker is an Obsidian plugin that archives the external links in the active note with the Internet Archive's Wayback Machine and replaces each original link with the archived snapshot URL.

[![CI](https://github.com/Real-Fruit-Snacks/wayback-linker/actions/workflows/ci.yml/badge.svg)](https://github.com/Real-Fruit-Snacks/wayback-linker/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/Real-Fruit-Snacks/wayback-linker)](https://github.com/Real-Fruit-Snacks/wayback-linker/releases)

## What It Does

- Adds a ribbon button and command palette command.
- Adds a right-click editor menu action when the cursor is on an external URL.
- Finds external `http://` and `https://` links in the active Markdown note.
- Skips links that already point at `web.archive.org`.
- Sends each URL to Wayback Machine's Save Page Now endpoint and waits for the new capture job to finish.
- Replaces successful links only when Wayback returns a fresh snapshot URL.
- Can optionally fall back to Wayback's most recent existing snapshot if a fresh capture fails.

## Usage

- Click the ribbon button or run **Archive active note links with Wayback Machine** to process every external link in the active note.
- Right-click an external URL in the editor and choose **Archive link with Wayback Machine** to process just that link.
- Enable **Fall back to latest existing snapshot** if you want replacement links even when Wayback refuses or times out on a fresh capture.
- During full-note runs, a progress window shows the current URL, completed count, fresh captures, fallback links, and failures.
- If Wayback reports the active Save Page Now session limit, the plugin waits and retries before marking that URL failed or falling back.

## Internet Archive Login

Fresh Save Page Now captures may require an authenticated Internet Archive account.

1. Create or log in to your Internet Archive account.
2. Open `https://archive.org/account/s3.php`.
3. Copy your access key and secret key.
4. In Obsidian, open **Settings -> Wayback Linker**.
5. Paste the keys into **Internet Archive access key** and **Internet Archive secret key**.

The secret key is session-only by default and is not saved to your vault. If you enable **Remember secret key**, it will be stored in this plugin's local Obsidian data file, which may be inside your vault.

If you publish or push your vault to GitHub, keep **Remember secret key** off and add these patterns to your vault's `.gitignore`:

```gitignore
.obsidian/plugins/wayback-linker/data.json
.obsidian/plugins/wayback-linker/.env
```

## Development

```bash
npm install
npm test
npm run build
```

For live rebuilds while developing:

```bash
npm run dev
```

## Local Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release, or build the plugin locally.
2. Create a folder in your vault at `.obsidian/plugins/wayback-linker`.
3. Copy `manifest.json`, `main.js`, and `styles.css` into that folder.
4. Reload Obsidian and enable **Wayback Linker** under Community Plugins.

## Releasing

1. Update the version in `manifest.json`, `package.json`, and `versions.json`.
2. Commit the version change.
3. Tag the commit with the exact version, for example `0.1.0`.
4. Push the tag. GitHub Actions will run tests, build the plugin, and attach `main.js`, `manifest.json`, and `styles.css` to the release.

## Notes

Save Page Now saves one page at a time. Some sites may block archiving, require authentication, return a snapshot after a delay, throttle active capture sessions, or reject fresh captures for heavily archived hosts. By default, this plugin retries active-session throttles, then leaves unresolved links unchanged. If **Fall back to latest existing snapshot** is enabled, it will use Wayback's most recent available snapshot for that URL when a fresh capture fails.

## License

MIT. See [LICENSE](LICENSE).
