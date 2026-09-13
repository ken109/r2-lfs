# r2-lfs

A Git LFS server that runs on Cloudflare Workers and keeps objects in R2.
Your Git history stays on GitHub; only the large files move.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ken109/r2-lfs)

## Why

GitHub LFS counts **every version you have ever pushed** toward storage. The only way to delete
old versions is to delete the repository (or ask support). That is painful for binary assets that
change often, like `.blend` files, textures and game builds.

With r2-lfs:

- Storage costs $0.015/GB-month with 10 GB free, and there are no egress fees ([R2 pricing](https://developers.cloudflare.com/r2/pricing/))
- Old versions are yours to delete: `pnpm gc` removes objects that no recent commit references
- A [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/) can still keep recent uploads from being deleted, even by you
- One deployment serves any number of repositories

## Deploy

Click **Deploy to Cloudflare** above. Cloudflare copies this repository into your GitHub account,
creates the R2 bucket and deploys the Worker. The setup page asks for the settings below; the only
one you must fill in is `ALLOWED_OWNERS`.

To deploy by hand instead:

```sh
pnpm install
pnpm exec wrangler r2 bucket create r2-lfs
# edit "vars" in wrangler.jsonc, then:
pnpm run deploy
```

## Configuration

| Name | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `ALLOWED_OWNERS` | var | (required) | Comma-separated GitHub users or orgs allowed to use the server. `*` allows anyone. |
| `AUTH_MODE` | var | `github` | `github` or `token`, see [Authentication](#authentication). |
| `STORAGE_LAYOUT` | var | `per-repo` | `per-repo` stores objects under `<owner>/<repo>/<oid>`. `shared` stores them once under `_shared/<oid>` for all repositories. |
| `TRANSFER_MODE` | var | `auto` | `presigned`, `proxy`, or `auto` (presigned when the R2 credentials are set, proxy otherwise). See [Transfers](#transfers). |
| `PROXY_MAX_UPLOAD_MB` | var | `100` | Largest upload accepted in proxy mode. Set it to your plan's request body limit. |
| `R2_ACCOUNT_ID` | var | | Presigned mode: your Cloudflare account ID. |
| `R2_BUCKET_NAME` | var | `r2-lfs` | Presigned mode: must match `bucket_name` of the `BUCKET` binding. |
| `R2_ACCESS_KEY_ID` | secret | | Presigned mode: an R2 API token with Object Read & Write on the bucket. |
| `R2_SECRET_ACCESS_KEY` | secret | | Presigned mode: the secret for that token. |
| `AUTH_TOKENS` | secret | | Token mode: comma-separated `<scope>:<r\|rw>:<token>` entries. |

If a setting is invalid, every LFS request fails with a 500 whose message lists all of the
problems, so `git push` shows you what to fix.

### Authentication

**`github`**: Git sends a GitHub token as the password. The Worker asks the GitHub API what your
account can do on the repository with that name. You can download if you can read the repository,
and upload if you can push to it. Results are cached for 60 seconds.

Any token that can read the repository works, such as a fine-grained token with *Metadata: read*
on the repository. GitHub reports your **account's** role, not the token's scopes, so a read-only
token belonging to a collaborator can still upload.

**`token`**: Only the static tokens in `AUTH_TOKENS` are accepted. A scope is `owner/repo`,
`owner/*` or `*`. Tokens must be at least 16 characters; generate one with `openssl rand -hex 32`.

```
my-name/*:rw:3f1c...,my-name/assets:r:9a7b...
```

`ALLOWED_OWNERS` applies in both modes. Without it, anyone could point their own GitHub repository
at your bucket.

### Transfers

**`proxy`** needs no extra setup. The Worker streams uploads into R2 and checks that the content
hashes to the oid. Uploads are limited by the Workers request body size (100 MB on Free and Pro).
Larger objects fail in the batch step with a message telling you to switch to presigned mode.

**`presigned`** gives Git time-limited URLs so that it talks to R2 directly, with no size limit
from Workers. Create an R2 API token under *R2 > Manage API tokens* with *Object Read & Write* on
the bucket, then set the four `R2_*` settings. After an upload, the Worker checks the stored size.
R2 cannot verify a SHA-256 checksum on a presigned upload, so the content hash is not checked
in this mode.

## Using it in a repository

Commit a `.lfsconfig` at the root of the repository:

```ini
[lfs]
  url = https://r2-lfs.<your-subdomain>.workers.dev/<owner>/<repo>
  locksverify = false
```

The first `git push` asks for credentials for the Worker's host. Use any username and your GitHub
token (or an `AUTH_TOKENS` token) as the password. Your credential helper remembers them. To store
them up front:

```sh
printf 'protocol=https\nhost=r2-lfs.<your-subdomain>.workers.dev\nusername=git\npassword=<token>\n' | git credential approve
```

### Moving an existing repository off GitHub LFS

```sh
git lfs fetch --all origin     # download every version from GitHub LFS
# add the .lfsconfig above and commit it
git lfs push --all origin      # upload every version to r2-lfs
```

Once clones use the new `.lfsconfig`, the objects on GitHub are no longer read. GitHub keeps
billing for them until you delete and recreate the repository there.

## Protecting recent uploads

A bucket lock rule stops R2 from deleting or overwriting objects younger than the retention
period, whether the request comes from a leaked credential, a bad script, or you:

```sh
pnpm exec wrangler r2 bucket lock add r2-lfs keep-90-days "" --retention-days 90
```

## Deleting old versions

`pnpm gc` scans a local clone and deletes objects in its prefix that are no longer needed. It keeps:

- every object referenced by a commit from the last `--keep-days` days (default 90), on any local
  or remote-tracking ref
- every object referenced by the tip of any ref, however old
- every object uploaded less than `--min-age-days` ago (default 30), so pushes from other machines
  that you have not fetched yet are safe

```sh
export R2_ACCOUNT_ID=... R2_BUCKET_NAME=r2-lfs R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
pnpm gc --repo ../my-repo            # dry run: shows what would be deleted
pnpm gc --repo ../my-repo --apply
```

With `STORAGE_LAYOUT=shared`, pass `--shared` and a `--repo` for **every** repository that uses the
bucket. Otherwise objects that only the missing repositories need will be deleted.

Checking out a commit older than `--keep-days` will fail for files whose objects were deleted.
That is the trade-off you are choosing.

## Limitations

- File locking (`git lfs lock`) is not implemented. Set `locksverify = false` as shown above.
- In `shared` layout, anyone who can upload to one repository can upload any object. In presigned
  mode, where hashes are not checked, a malicious uploader could store bad content under an oid
  that another repository needs. Use `per-repo` when repositories have different writers.
- Only the `basic` transfer adapter and SHA-256 are supported, which is what git-lfs uses by default.

## Development

```sh
pnpm install
pnpm test        # runs inside the Workers runtime with a local R2
pnpm typecheck
pnpm dev         # local server on http://localhost:8787 (put settings in .dev.vars)
```

## License

MIT
