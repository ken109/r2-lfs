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

- **Who can read and write objects.** Requests must be for a repository `ALLOWED_REPOS` covers and carry
  credentials that the GitHub API or the token directory accepts for that repository.
- **Integrity.** R2 rejects proxy uploads whose content does not hash to the oid, and the Worker hashes
  presigned uploads before moving them into place.
- **Deletion.** The Worker cannot delete objects. Deletion needs R2 API credentials, and bucket lock
  rules can refuse it within their retention period.
- **Tokens.** Tokens created with `r2-lfs token` are stored as SHA-256 hashes; tokens in `AUTH_TOKENS`
  live in an encrypted Worker secret. All are compared in constant time.

## Known limits

- With `VERIFY_UPLOADS=off` in presigned mode, the Worker checks only the size, so a client with write
  access can store content that does not match its oid, and in the `shared` layout claim an object by
  its oid and size.
- In the `shared` layout, a repository that uploaded an object can learn that it is also stored for
  another repository, because the upload is checked rather than repeated.
- With `AUTH_MODE=github`, access follows the GitHub account's role on the repository, not the
  token's scopes.
