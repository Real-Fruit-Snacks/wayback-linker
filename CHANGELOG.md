# Changelog

## 1.0.2 - 2026-06-29

- Add **Archive all vault links with Wayback Machine** command palette action.
- Scan every Markdown note, confirm the vault-wide scope, and archive each unique URL once before replacing successful links across the vault.
- Document the vault-wide command in the README and GitHub Pages site.

## 0.2.0 - 2026-06-18

- Store Internet Archive access and secret keys in Obsidian's secure keychain.
- Automatically migrate legacy credentials out of plugin `data.json`.
- Remove the legacy **Remember secret key** setting.
- Require Obsidian 1.11.4 or newer for the SecretStorage API.

## 0.1.0 - 2026-06-18

- Archive external links in the active Obsidian note.
- Replace successful captures with fresh Wayback Machine URLs.
- Optionally fall back to the latest existing snapshot.
- Archive individual links from the editor context menu.
- Show batch progress, fallback results, failures, and throttle retries.
- Support authenticated Save Page Now requests with session-only secrets by default.
- Skip existing Wayback links and image URLs.
- Include automated unit tests and production build checks.
