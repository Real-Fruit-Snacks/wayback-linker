<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://real-fruit-snacks.github.io/wayback-linker/assets/logo-dark.svg" />
    <img alt="Wayback Linker" src="https://real-fruit-snacks.github.io/wayback-linker/assets/logo-light.svg" width="560" />
  </picture>

  **Archive external links in a note — or your whole vault — with the Wayback Machine, and replace them with durable snapshot URLs.**

  [![License: MIT](https://img.shields.io/badge/License-MIT-63f2ab.svg)](LICENSE)
  [![Latest release](https://img.shields.io/github/v/release/Real-Fruit-Snacks/wayback-linker?color=6bdcff&label=release)](https://github.com/Real-Fruit-Snacks/wayback-linker/releases)
  [![Obsidian](https://img.shields.io/badge/Obsidian-1.11%2B-f0c674.svg)](https://obsidian.md)

  [Documentation](https://real-fruit-snacks.github.io/wayback-linker/) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/Real-Fruit-Snacks/wayback-linker/issues)

</div>

---

## Overview

Wayback Linker sends the external `http(s)` links in your notes to the Internet Archive's **Save Page Now** service, waits for each capture to finish, and rewrites the link in place to the resulting `web.archive.org` snapshot URL. The sources you cite stay readable even after the original page changes or disappears.

Archiving works at three scopes:

- **Active note** — the ribbon button or a command processes every external link in the current Markdown note.
- **Whole vault** — a command scans every note, shows a confirmation with link/note/URL counts, archives each unique URL once, and replaces successful links across the vault.
- **Single link** — right-click any external URL in the editor and archive just that one.

Long runs show a live progress window with per-URL status and a Cancel button, plus a clickable status-bar counter. Links are only replaced when a capture actually succeeds — a failed or canceled URL keeps its original link untouched.

## Features

- **Fresh captures, verified** — asks Save Page Now for a new snapshot and checks the returned timestamp is actually fresh, not a stale capture served from cache.
- **Vault-wide scan with confirmation** — see exactly how many links, notes, and unique URLs are affected before anything runs.
- **Markdown-aware parsing** — handles `[text](url)` links, `<autolinks>`, and (optionally) bare pasted URLs, while skipping images and existing `web.archive.org` links.
- **Ignored domains** — list domains to skip (subdomains included), one per line or comma-separated.
- **Throttle handling** — when the Archive reports its active-session limit, the plugin waits and retries on a configurable schedule instead of failing.
- **Optional snapshot fallback** — if a fresh capture fails or times out, optionally fall back to the most recent existing snapshot from the availability and CDX APIs.
- **Cancelable runs** — stop a batch at any point; replacements already completed are kept, everything else is left unchanged.
- **Secure credentials** — Internet Archive S3 keys live in Obsidian's native keychain, never in plugin data files.
- **Desktop and mobile** — uses Obsidian's own networking API throughout, so it works on both.

## Installation

**Requires Obsidian 1.11.4 or newer.**

### Community plugins (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **Wayback Linker**, then **Install** and **Enable**.

### BRAT (for the latest pre-release)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add `Real-Fruit-Snacks/wayback-linker` as a beta plugin.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Real-Fruit-Snacks/wayback-linker/releases/latest) into `<your-vault>/.obsidian/plugins/wayback-linker/`, then enable Wayback Linker under **Settings → Community plugins**.

## Getting started

1. Open a note with external links and click the **archive** ribbon icon — or run a command from the palette.
2. Watch the progress window; each URL shows *Working*, *Fresh*, *Fallback*, or *Failed* as captures complete.
3. Successful links are rewritten in place to their `web.archive.org` snapshot.

### Commands

| Command | Description |
| --- | --- |
| Archive active note links with Wayback Machine | Archive every external link in the current note |
| Archive all vault links with Wayback Machine | Scan the vault, confirm the scope, then archive and replace across all notes |

You can also **right-click any external URL** in the editor and choose **Archive link with Wayback Machine** to process a single link.

### Settings

| Setting | Purpose |
| --- | --- |
| Delay between archive requests | Milliseconds to wait between Save Page Now requests (default 1500) |
| Archive bare URLs | Also replace plain pasted URLs that aren't inside Markdown links |
| Ignored domains | Domains to skip everywhere, including subdomains |
| Maximum wait for fresh captures | Seconds to wait for a capture before leaving the link unchanged |
| Fall back to latest existing snapshot | Use the newest existing snapshot when a fresh capture fails |
| Throttle retry delay / Maximum throttle retries | How patiently to retry when the Archive rate-limits |
| Internet Archive access key / secret key | Keychain entries for authenticated captures |
| Debug mode | Log errors and internals to the developer console |

### Internet Archive authentication

Fresh captures are more reliable with an authenticated account:

1. Log in at archive.org and open <https://archive.org/account/s3.php>.
2. Copy your access key and secret key.
3. In **Settings → Wayback Linker**, create keychain entries for both keys using the secure selectors.

Only the keychain entry *names* are written to `data.json` — the actual credentials stay in Obsidian's secure keychain.

## How replacement works

Wayback Linker is deliberately conservative about touching your notes:

- Notes are **re-read and re-parsed after archiving finishes**, so edits you make while captures run never cause a stale or misplaced replacement.
- A link is replaced only when the Archive returns a verified snapshot; failures, timeouts, and cancellations leave the original untouched.
- The single-link right-click flow re-checks that the exact link text is still where it was before replacing it.

## Privacy

The plugin talks only to the Internet Archive (`web.archive.org` / `archive.org`) over HTTPS — no telemetry, no third-party services. Be aware that archiving is inherently public: every URL you archive is sent to the Internet Archive, and successful captures become publicly visible snapshots. Use **Ignored domains** for anything you'd rather keep out.

## Architecture

```
wayback-linker/
├── main.ts            Plugin source (TypeScript, bundled with esbuild)
├── main.test.ts       Unit tests for parsing and replacement (Vitest)
├── manifest.json      Obsidian plugin manifest
├── styles.css         Plugin styles, scoped to .wayback-* classes
├── versions.json      Plugin version → minimum Obsidian version map
└── docs/              Documentation site and brand assets
```

- **Parsing and replacement are pure functions**, exported and unit-tested independently of Obsidian.
- **All network activity** goes through Obsidian's `requestUrl`, so it works on mobile and respects the platform.
- **Rate-limit citizenship** — configurable inter-request delay, Save Page Now session-limit detection, and bounded retries.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request.

## License

Released under the [MIT License](LICENSE).
