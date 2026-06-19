# Security

## Credentials

Wayback Linker can authenticate to Internet Archive Save Page Now with an access key and secret key. The secret key is session-only by default. Enabling **Remember secret key** stores it in the plugin's Obsidian `data.json` file.

Never commit or publish:

- `.obsidian/plugins/wayback-linker/data.json`
- `.env`
- Internet Archive secret keys
- Vault contents containing private information

If a key is exposed, rotate it immediately at `https://archive.org/account/s3.php`.

## Reporting

Please report security issues privately through GitHub's security advisory feature for this repository rather than opening a public issue.
