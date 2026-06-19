# Security

## Credentials

Wayback Linker can authenticate to Internet Archive Save Page Now with an access key and secret key. Version 0.2.0 and newer store both credentials through Obsidian's secure `SecretStorage` keychain API. They are not written to the plugin's `data.json` file.

When upgrading from version 0.1.0, saved legacy credentials are migrated into the keychain and removed from plugin data.

Never commit or publish:

- `.obsidian/plugins/wayback-linker/data.json`
- `.env`
- Internet Archive secret keys
- Vault contents containing private information

If a key is exposed, rotate it immediately at `https://archive.org/account/s3.php`.

## Reporting

Please report security issues privately through GitHub's security advisory feature for this repository rather than opening a public issue.
