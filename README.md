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
npx r2-lfs setup --owners your-github-name
```

`setup` creates the bucket, a lifecycle rule that empties the trash after 30 days, lock rules that
protect uploads for 90 days, and deploys the Worker. If you used the button, run
`npx r2-lfs setup --owners your-github-name --no-deploy` once to add the rules.

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

Every command accepts `--help`. Read-only commands accept `--json`.

Commands that list or change the bucket directly (`gc`, `restore`, `token`, and the bucket details
in `usage`, `verify` and `why`) need an R2 API token with **Object Read & Write** on the bucket
(_R2 > Manage API tokens_):

```sh
export R2_ACCOUNT_ID=... R2_BUCKET_NAME=r2-lfs R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
```

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
      - uses: ken109/r2-lfs@v0
        with:
          apply: true
        env:
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_BUCKET_NAME: r2-lfs
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

## Server configuration

These are Worker variables, set in `wrangler.jsonc`, on the Deploy to Cloudflare page, or by `setup`.

| Name                   | Kind   | Default    | Meaning                                                                                                             |
| ---------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_OWNERS`       | var    | (required) | Comma-separated GitHub users or orgs allowed to use the server. `*` allows anyone.                                  |
| `AUTH_MODE`            | var    | `github`   | `github` or `token`; see [Authentication](#authentication).                                                         |
| `STORAGE_LAYOUT`       | var    | `per-repo` | `per-repo` stores objects under `<owner>/<repo>/`. `shared` stores them once under `_shared/` for all repositories. |
| `TRANSFER_MODE`        | var    | `auto`     | `presigned`, `proxy`, or `auto` (presigned when the R2 credentials below are set). See [Transfers](#transfers).     |
| `PROXY_MAX_UPLOAD_MB`  | var    | `100`      | Largest upload accepted in proxy mode; your plan's request body limit.                                              |
| `R2_ACCOUNT_ID`        | var    |            | Presigned mode: your Cloudflare account ID.                                                                         |
| `R2_BUCKET_NAME`       | var    | `r2-lfs`   | Presigned mode: the name of the bucket bound as `BUCKET`.                                                           |
| `R2_ACCESS_KEY_ID`     | secret |            | Presigned mode: an R2 API token with Object Read & Write on the bucket.                                             |
| `R2_SECRET_ACCESS_KEY` | secret |            | Presigned mode: its secret.                                                                                         |
| `AUTH_TOKENS`          | secret |            | Token mode: comma-separated `<scope>:<r\|rw>:<token>` entries, in addition to tokens from `r2-lfs token`.           |

If a setting is invalid, LFS requests fail with a message listing every problem, and `r2-lfs doctor` shows it too.

### Authentication

**`github`.** Git sends a GitHub token as the password. The Worker asks the GitHub API what that
account can do on the repository with the same owner and name: reading allows downloads, pushing
allows uploads. Answers are cached for 60 seconds. GitHub reports the **account's** role, not the
token's scopes, so a read-only token that belongs to a collaborator can still upload.

**`token`.** Tokens created with `r2-lfs token create --scope owner/* --label laptop` (stored hashed
in the bucket, revocable within 30 seconds), plus any in the `AUTH_TOKENS` secret.

`ALLOWED_OWNERS` applies in both modes, so nobody can point their own repository at your bucket.

### Transfers

**`proxy`** needs no extra setup. The Worker streams uploads into R2 and R2 rejects content that
does not hash to the oid. Uploads are limited by the Workers request body size (100 MB on Free and
Pro); larger objects fail early with a message pointing at presigned mode.

**`presigned`** hands Git time-limited R2 URLs, so transfers skip the Worker and have no size limit.
R2 does not verify SHA-256 checksums on presigned uploads, so the Worker checks only the size.

## Security

- Tokens from `r2-lfs token` are stored as SHA-256 hashes; comparisons are constant-time.
- The Worker exposes no delete endpoint. Only holders of R2 API credentials can remove objects,
  and bucket lock rules stop even them within the retention period.
- gc copies an object to the trash before deleting it, and removes the copy again if the delete is
  refused, so a failure never loses data.
- In the `shared` layout, anyone who can upload to one repository can upload any object, and in
  presigned mode content hashes are not verified. Use `per-repo` when repositories have different writers.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- File locking (`git lfs lock`) is not implemented; `init` sets `locksverify = false`.
- Only the `basic` transfer adapter and SHA-256 oids are supported, which is what git-lfs uses by default.
- `github` authentication works only for repositories hosted on github.com.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
