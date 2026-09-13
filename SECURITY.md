# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/ken109/r2-lfs/security/advisories/new).
Do not open a public issue.

Include what an attacker can do, the configuration it needs (`AUTH_MODE`, `STORAGE_LAYOUT`,
`TRANSFER_MODE`), and steps to reproduce. You should get a first response within a week.

## Supported versions

Fixes go into the latest release. Update the Worker (redeploy) and the CLI (`npx r2-lfs@latest`)
to receive them.

## What r2-lfs protects

- **Who can read and write objects.** Requests must come from an owner in `ALLOWED_OWNERS` and carry
  credentials that the GitHub API or the token directory accepts for that repository.
- **Integrity in proxy mode.** R2 rejects uploads whose content does not hash to the oid.
- **Deletion.** The Worker cannot delete objects. Deletion needs R2 API credentials, and bucket lock
  rules can refuse it within their retention period.
- **Tokens.** Tokens are stored as SHA-256 hashes and compared in constant time.

## Known limits

- In presigned mode, R2 does not verify SHA-256 checksums, so a client with write access can store
  content that does not match its oid. The Worker checks the size only.
- In the `shared` layout, write access to any repository allows writing any object. Use `per-repo`
  when repositories have different writers.
- With `AUTH_MODE=github`, access follows the GitHub account's role on the repository, not the
  token's scopes.
