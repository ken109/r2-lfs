# r2-lfs

[![CI](https://github.com/ken109/r2-lfs/actions/workflows/ci.yml/badge.svg)](https://github.com/ken109/r2-lfs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/r2-lfs)](https://www.npmjs.com/package/r2-lfs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Git LFS server that runs on Cloudflare Workers and stores objects in R2, plus a CLI to set it up,
see where your storage goes, and clean up old versions safely.

Your Git history stays on GitHub (or anywhere). Only the large files move.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ken109/r2-lfs)

## Why

GitHub LFS counts **every version you have ever pushed** toward your storage quota, and the only way
to delete old versions is to delete the repository. That hurts for binary assets that change often,
such as `.blend` files, textures, audio and game builds.

r2-lfs keeps the same Git workflow and gives you control over what is kept:

- **Cheap to run.** R2 costs $0.015/GB-month with 10 GB free, and has no egress fees ([pricing](https://developers.cloudflare.com/r2/pricing/)).
- **Old versions are yours to delete.** `r2-lfs gc` removes objects that no recent commit needs, following rules you write.
- **Deletion is recoverable.** gc moves objects to a trash that expires on its own; `r2-lfs restore` brings them back.
- **Recent uploads can be made undeletable**, even by you, with an R2 [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/).
- **One deployment serves many repositories**, authenticated with GitHub permissions or your own tokens.

## Quick start

**1. Deploy the server.** Either click **Deploy to Cloudflare** above, or use the CLI (it runs Wrangler for you):

```sh
npx r2-lfs setup --repos 'your-github-name/*'
```

`setup` creates the bucket, a lifecycle rule that empties the trash after 30 days, lock rules that
protect uploads for 90 days, and deploys the Worker. If you used the button, run
`npx r2-lfs setup --repos 'your-github-name/*' --no-deploy` once to add the rules. Lock rules cover
each repository pattern up to its first `*`; a pattern with `*` in the owner, such as `*/assets`, gets none,
because its prefix would also cover the trash.

**2. Point a repository at it.**

```sh
cd your-repo
npx r2-lfs init --server https://r2-lfs.<your-subdomain>.workers.dev --track blender
git add .lfsconfig .gitattributes && git commit -m "Store LFS objects on r2-lfs"
git push
```

With the GitHub CLI logged in, `init` configures git to answer the server's password prompt with your
`gh` login, so there is no token to create or paste.

**3. Check everything works.**

```sh
npx r2-lfs doctor
```

## The CLI

Install it globally with `npm i -g r2-lfs`, or run any command with `npx r2-lfs`. Node.js 22.13 or later.

| Command           | What it does                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`           | Create the bucket and its trash and lock rules, and deploy the Worker with Wrangler.                                                                             |
| `init`            | Write `.lfsconfig`, track file-type presets (`blender`, `images`, `video`, `audio`, `unity`, `unreal`, `archives`), and set up credentials.                      |
| `doctor`          | Check git-lfs, `lfs.url`, the server's settings, your credentials and access, and large files committed without LFS.                                             |
| `migrate`         | Copy every LFS version from GitHub LFS (or any LFS server) to r2-lfs, commit the config, and verify. `--import` also moves files committed without LFS into LFS. |
| `usage`           | List files by storage used across all their versions, with bucket totals, orphans and an estimated monthly cost.                                                 |
| `verify`          | Confirm the server has every object your branches and tags need (`--all` for every version, `--deep` to check hashes).                                           |
| `why <path\|oid>` | Show each version of a file, where it is used, and what gc would do with it.                                                                                     |
| `gc`              | Plan a cleanup from your git history and the bucket; with `--apply`, move old objects to the trash (or `-i` to pick them).                                       |
| `restore`         | List the trash and bring objects back by oid, path, date or all at once.                                                                                         |
| `archive <tag>`   | Pack a tag, LFS files included, into tar parts and publish them as a GitHub release.                                                                             |
| `token`           | Create, list and revoke tokens for servers using token authentication.                                                                                           |
| `transfer-agent`  | Upload in resumable parts through the Worker, past its request limit; `--install` registers it.                                                                  |

Every command accepts `--help`. Read-only commands accept `--json`.

Commands that list or change the bucket directly (`gc`, `restore`, `token`, and the bucket details
in `usage`, `verify` and `why`) need an R2 API token with **Object Read & Write** on the bucket
(_R2 > Manage API tokens_):

```sh
export R2_ACCOUNT_ID=... R2_BUCKET_NAME=r2-lfs R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
```

If the server has an `ENCRYPTION_KEY`, set `R2_LFS_ENCRYPTION_KEY` to the same key for `gc --apply` and
`restore`, whose copies inside R2 need it.

Set `R2_ENDPOINT` as well for a bucket in a jurisdiction, such as `https://<account id>.eu.r2.cloudflarestorage.com`.

Commands that talk to the server use the password git's credential helpers have for it. Set
`R2_LFS_TOKEN` to use a token instead, for example in CI.

## Cleaning up old versions

`r2-lfs gc` fetches every branch and tag, reads the history of all of them, lists the bucket,
and decides for each object. Remote tags are fetched to `refs/r2-lfs/tags/<remote>/`, so they never
overwrite or prune your own tags; `migrate` does the same. Objects those refs use are kept, so after
removing a remote, delete its refs with `git for-each-ref --format='delete %(refname)' refs/r2-lfs/tags/<remote>/ | git update-ref --stdin`.

- **keep** it if it is in the tree of any branch or tag tip, used by a commit from the last
  `keep_days` days, one of a file's newest `keep_versions` versions, or under a path marked `keep = "all"`
- **leave it alone** if it was uploaded less than `min_age_days` ago, so objects whose commits have
  not been pushed yet are safe
- otherwise **move it to the trash**, or to R2 Infrequent Access storage if a rule says so

Right before applying, gc fetches again and leaves alone anything that commits pushed in the meantime
need. Pushing content the bucket already has, such as a revert to an old version, does not upload it
again and so does not reset its age; if such a push races with gc, `r2-lfs restore` brings the object back.

It is a dry run unless you pass `--apply`. It refuses shallow and single-branch clones, whose missing
commits would make objects look unreferenced, and it stops if `git fetch` fails while applying. Tune it with a `.r2-lfs.toml` at the repository root:

```toml
keep_days = 90          # keep objects used by commits from the last 90 days
keep_versions = 0       # also keep the newest N versions of every file
min_age_days = 30       # never touch objects uploaded more recently than this
old_versions = "delete" # or "infrequent-access" to keep old versions on cheaper storage

# Rules are matched in order, like .gitattributes patterns. The first match wins.
[[rule]]
path = "textures/**"
keep_versions = 3

[[rule]]
path = "final/**"
keep = "all"
```

Trashed objects live under `_trash/` until the lifecycle rule created by `setup` expires them.
Use `r2-lfs restore --list` to see them and `r2-lfs restore <oid>` to bring one back.

Checking out a commit older than your policy keeps will fail for files whose objects were collected.
That is the trade-off gc makes; `r2-lfs archive <tag>` keeps full snapshots of releases you care about.

### Running gc in CI

Use the bundled action on a schedule. gc needs the full history:

```yaml
name: LFS cleanup
on:
  schedule:
    - cron: "0 3 * * 1"
  workflow_dispatch:

jobs:
  gc:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: ken109/r2-lfs@v0.1.0 # x-release-please-version
        with:
          apply: true
          version: 0.1.0 # x-release-please-version
        env:
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_BUCKET_NAME: r2-lfs
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

The action runs the CLI version it was released with. `@v0` follows every 0.x release, and before 1.0
a minor release may change what gc deletes, so pin an exact tag, as above, when applying.

## Server configuration

These are Worker variables, set in `wrangler.jsonc`, on the Deploy to Cloudflare page, or by `setup`.

| Name                    | Kind   | Default    | Meaning                                                                                                                                                                                                                                         |
| ----------------------- | ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_REPOS`         | var    | (required) | Comma-separated [repository patterns](#repository-patterns) the server serves, such as `my-name/*,my-org/assets`. `*` alone serves anyone's repositories. The older `ALLOWED_OWNERS` (`my-name,my-org`) still works and counts as `<owner>/*`.  |
| `AUTH_MODE`             | var    | `github`   | `github`, `gitlab`, `gitea`, `bitbucket` or `token`; see [Authentication](#authentication).                                                                                                                                                     |
| `AUTH_HOST`             | var    |            | A self-managed GitHub Enterprise Server, GitLab, Gitea or Forgejo, such as `https://git.example.com`.                                                                                                                                           |
| `STORAGE_LAYOUT`        | var    | `per-repo` | `per-repo` stores objects under `<owner>/<repo>/`. `shared` stores them once under `_shared/` for all repositories.                                                                                                                             |
| `TRANSFER_MODE`         | var    | `auto`     | `presigned`, `proxy`, or `auto` (presigned when the R2 credentials below are set). See [Transfers](#transfers).                                                                                                                                 |
| `PROXY_MAX_UPLOAD_MB`   | var    | `100`      | Largest upload accepted in proxy mode; your plan's request body limit.                                                                                                                                                                          |
| `MAX_OBJECT_MB`         | var    |            | The largest object accepted, in MB.                                                                                                                                                                                                             |
| `QUOTA_GB`              | var    |            | Storage each repository may use (the whole pool in the `shared` layout), in GB; uploads past it fail with 507.                                                                                                                                  |
| `R2_ACCOUNT_ID`         | var    |            | Presigned mode: your Cloudflare account ID.                                                                                                                                                                                                     |
| `R2_BUCKET_NAME`        | var    |            | Presigned mode: the name of the bucket bound as `BUCKET` (`r2-lfs` in `wrangler.jsonc`).                                                                                                                                                        |
| `R2_ACCESS_KEY_ID`      | secret |            | Presigned mode: an R2 API token with Object Read & Write on the bucket.                                                                                                                                                                         |
| `R2_SECRET_ACCESS_KEY`  | secret |            | Presigned mode: its secret.                                                                                                                                                                                                                     |
| `ACCESS_TEAM_DOMAIN`    | var    |            | Admin UI: your Cloudflare Access team domain, such as `my-team.cloudflareaccess.com`. See [Admin UI](#admin-ui).                                                                                                                                |
| `ACCESS_AUD`            | var    |            | Admin UI: the audience tag of the Access application that protects `/_admin`.                                                                                                                                                                   |
| `ACTIONS_OIDC`          | var    | `off`      | `read` or `write` lets GitHub Actions workflows use their own repository with an OIDC token. See [GitHub Actions](#github-actions).                                                                                                             |
| `ACTIONS_OIDC_AUDIENCE` | var    | `r2-lfs`   | The audience workflows request that token for.                                                                                                                                                                                                  |
| `VERIFY_UPLOADS`        | var    | `on`       | Presigned mode: hash each upload before it counts as stored. `off` checks only the size, for the Free plan.                                                                                                                                     |
| `AUTH_TOKENS`           | secret |            | Token mode: comma- or newline-separated `<repositories>:<r\|rw\|admin>:<token>` entries, where repositories are written as in [repository patterns](#repository-patterns), tokens of 16+ characters, in addition to tokens from `r2-lfs token`. |
| `ENCRYPTION_KEY`        | secret |            | 32 bytes as base64 (`openssl rand -base64 32`) or hex. R2 stores new objects encrypted with it (SSE-C), and transfers go through the Worker. Objects cannot be read without the key.                                                            |

The Worker also writes one Workers Analytics Engine data point per request to the `r2_lfs` dataset:
repository, endpoint, method, status and bytes proxied. Remove the `METRICS` binding to turn it off.

If a setting is invalid, LFS requests fail with a message listing every problem, and `r2-lfs doctor` shows it too.

### Authentication

**`github`, `gitlab`, `gitea`, `bitbucket`.** Git sends a token for that host as the password (for
Bitbucket, an app password with your user name, or an access token). The Worker asks the host's API what
that account can do on the repository with the same owner and name: reading allows downloads, writing
allows uploads, and admin (GitHub admin or maintain, GitLab Maintainer or Owner) also allows unlocking
other people's files. Answers are cached for 60 seconds. Hosts report the **account's** role, not the
token's scopes, so a read-only token that belongs to a collaborator can still upload. Redirects for renamed
or transferred repositories are not followed, so update `lfs.url` after moving a repository.

For GitHub Enterprise Server, a self-managed GitLab, Gitea or Forgejo, set `AUTH_HOST` to its address.
Repositories must be `owner/repo`; GitLab projects in subgroups cannot be addressed.

**`token`.** Tokens created with `r2-lfs token create --scope owner/* --label laptop` (stored hashed
in the bucket, revocable within 30 seconds), plus any in the `AUTH_TOKENS` secret. A scope is a
[repository pattern](#repository-patterns), so `--scope me/blender-*` limits a token to those repositories.

### Repository patterns

`ALLOWED_REPOS` entries and token scopes are written as `owner/repo`, case-insensitive. `*` stands for any characters within the owner
or the repository name but never crosses the `/`: `my-org/*` is every repository of `my-org`,
`me/blender-*` covers `me/blender-cube` but not `me/my-blender`, and `*` alone covers every repository.

`ALLOWED_REPOS` applies in both modes, so nobody can point a repository you did not list at your bucket.

### Transfers

**`proxy`** needs no extra setup. The Worker streams uploads into R2 and R2 rejects content that
does not hash to the oid. Uploads are limited by the Workers request body size (100 MB on Free and
Pro); larger objects fail early with a message pointing at presigned mode or multipart uploads.

**`presigned`** hands Git time-limited R2 URLs, so transfers skip the Worker. Objects can be up to
4.995 GiB, the most R2 accepts in one request. R2 does not check SHA-256 on presigned uploads, so they
land under `_incoming/` and the Worker hashes each one when git-lfs verifies it, then copies it into
place inside R2. Hashing a large file takes Worker CPU time beyond the Free plan's limit; set
`VERIFY_UPLOADS=off` there, which makes the Worker check only the size.

**Multipart uploads** lift both limits. Register the CLI as a git-lfs transfer agent with
`r2-lfs init --transfer-agent` (or `r2-lfs transfer-agent --install`), from a global install rather
than `npx`, since git config keeps its path. git-lfs then offers it to servers, and r2-lfs uses it in
proxy mode, or in presigned mode for objects over 4.995 GiB. The agent sends each object in parts of
`PROXY_MAX_UPLOAD_MB` (at least 5 MiB) through the Worker, and an interrupted push continues from the
last part it finished. When the parts are complete, the Worker checks the size and SHA-256 before
moving the object into place. Objects over 4.995 GiB are copied inside the Worker in 32 MB parts, which
takes more CPU time and subrequests than the Free plan allows. Downloads keep git-lfs's own transfer,
which resumes with a range request.

### Upgrading a shared-layout server

From 0.2.0, a repository in the `shared` layout reads only objects it has uploaded. After upgrading,
push every version once from each repository, for example with `git lfs push --all origin`; objects
the server already stores are checked rather than uploaded again.

## GitHub Actions

Workflows can fetch and push LFS files without a stored secret. Set `ACTIONS_OIDC` to `read` (or
`write`), and give the job an OIDC token; r2-lfs accepts it only for the repository the workflow runs in:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@v7
  - run: npx r2-lfs@0.1.0 credential --install # x-release-please-version
  - run: git lfs pull
```

`r2-lfs credential` is a git credential helper: it answers with `R2_LFS_TOKEN` when set, and inside
GitHub Actions with an OIDC token for the audience the server announces. File locks taken this way are
held by `<actor> (GitHub Actions)`.

## File locking

Binary files such as `.blend` cannot be merged, so two people editing one at the same time lose work.
r2-lfs supports Git LFS file locking:

```sh
git lfs lock scenes/hero.blend     # others see it as locked, and git-lfs refuses their pushes of it
git lfs locks                      # who holds what
git lfs unlock scenes/hero.blend
```

`r2-lfs init --lockable` tracks files as lockable, so git keeps them read-only in checkouts until you
lock them. Locks belong to one repository and are kept in a Durable Object. A lock is held by the GitHub
login in `github` mode, and by the token's label (or `AUTH_TOKENS #<n>`) in `token` mode. Anyone with
write access can lock and unlock their own locks; unlocking someone else's with `git lfs unlock --force`
needs the GitHub admin or maintain role, or a token created with `r2-lfs token create --admin`.

## Admin UI

The Worker serves an admin UI at `/_admin`. It stays closed until Cloudflare Access protects it:

1. In Cloudflare Zero Trust, add a self-hosted Access application for your Worker's host with the path
   `_admin`, and a policy for the people who may use it. Protect only that path: git-lfs cannot sign in
   through Access.
2. Copy the application's audience (AUD) tag and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, or pass
   `--access-team` and `--access-aud` to `r2-lfs setup`.

The Worker checks the token Access adds to every request against your team's signing keys, so the UI
refuses requests that did not come through that application.

## Security

- Tokens from `r2-lfs token` are stored as SHA-256 hashes; `AUTH_TOKENS` is an encrypted Worker secret. Comparisons are constant-time.
- The Worker exposes no delete endpoint. Only holders of R2 API credentials can remove objects,
  and bucket lock rules stop even them within the retention period.
- gc copies an object to the trash before deleting it, and removes the copy again if the delete is
  refused, so a failure never loses data.
- With `ENCRYPTION_KEY`, R2 stores objects encrypted with your key, so the bucket's contents are unreadable
  without it. The key never leaves the Worker, which is why transfers then go through it. Objects stored
  before the key was set stay readable and unencrypted.
- Stored content always hashes to its oid: R2 checks proxy uploads and the Worker checks presigned ones,
  unless `VERIFY_UPLOADS=off`.
- In the `shared` layout an object is stored once, but a repository can read it only after uploading its
  content itself, so knowing an oid is not enough. With `VERIFY_UPLOADS=off` in presigned mode, a
  writer can claim an object by its oid and size; use `per-repo` if that matters.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- Only SHA-256 oids are supported, which is what git-lfs uses. Transfers use git-lfs's `basic` adapter, or
  the `r2-lfs-multipart` agent for uploads when it is installed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
