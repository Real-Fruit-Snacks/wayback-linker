<div align="center">

  # Wayback Linker

  **Archive external links in your active note or whole vault with the Wayback Machine.**

  [![License: MIT](https://img.shields.io/badge/License-MIT-cba6f7.svg)](https://opensource.org/licenses/MIT)
  [![Version](https://img.shields.io/badge/version-0.2.3-89b4fa)](https://github.com/Real-Fruit-Snacks/wayback-linker/releases)
  
  [Documentation](https://Real-Fruit-Snacks.github.io/wayback-linker) • [Report Issue](https://github.com/Real-Fruit-Snacks/wayback-linker/issues) • [Request Feature](https://github.com/Real-Fruit-Snacks/wayback-linker/issues)

</div>

---

## Overview

Wayback Linker is an Obsidian plugin that automatically archives external links in your active note or across your vault using the Internet Archive's Wayback Machine. It seamlessly replaces each original link with the newly archived snapshot URL, ensuring your links never suffer from link rot.

### Key Features

- **Automated Archiving:** Processes every external `http://` and `https://` link in the active Markdown note.
- **Vault-Wide Scan:** Scans every Markdown note, confirms the scope, archives each unique URL once, and replaces successful links across the vault.
- **Save Page Now Integration:** Sends URLs directly to the Wayback Machine's capture endpoint.
- **Smart Replacement:** Replaces links only when a fresh snapshot URL is successfully generated.
- **Fallback Support:** Optionally falls back to the most recent existing snapshot if a fresh capture fails or times out.
- **Secure Credentials:** Utilizes Obsidian's native secure keychain to store your Internet Archive API keys.

---

## Getting Started

### Installation

**Manual install:**

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/Real-Fruit-Snacks/wayback-linker/releases).
2. Create `<your-vault>/.obsidian/plugins/wayback-linker/`.
3. Drop the three files into that folder.
4. Navigate to **Settings -> Community plugins** and enable **Wayback Linker**.

---

## Usage

You can trigger the archiving process in three ways:
1. Click the ribbon button or run **Archive active note links with Wayback Machine** from the command palette to process the entire note.
2. Run **Archive all vault links with Wayback Machine** from the command palette to scan every Markdown note, confirm the count, archive each unique URL once, and replace successful links across the vault.
3. Right-click an external URL in the editor and choose **Archive link with Wayback Machine** to process just that link.

### Internet Archive Login

Fresh captures may require an authenticated Internet Archive account.
1. Log in to your Internet Archive account and navigate to `https://archive.org/account/s3.php`.
2. Copy your access key and secret key.
3. In Obsidian, open **Settings -> Wayback Linker**.
4. Create separate keychain entries for both your access key and secret key using the secure selectors.

*Note: Only the selected secret IDs are written to `data.json`; the actual credentials remain in Obsidian's secure keychain.*

---

## Architecture / File Structure

```text
wayback-linker/
├── main.js          # Plugin entry
├── manifest.json    # Obsidian plugin manifest
├── styles.css       # Plugin styles
└── package.json     # Node dependencies and scripts
```

---

## Contributing

Contributions from the community are highly encouraged. Whether it's adding new features, improving the parser, or fixing bugs, your help is appreciated.

Please refer to the `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` files for full guidelines on how to submit pull requests and report issues.

---

## License

Distributed under the MIT License. See `LICENSE` for more information.

---

## Contact

Real-Fruit-Snacks - [https://github.com/Real-Fruit-Snacks](https://github.com/Real-Fruit-Snacks)

Project Link: [https://github.com/Real-Fruit-Snacks/wayback-linker](https://github.com/Real-Fruit-Snacks/wayback-linker)
