# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [private vulnerability reporting](SECURITY.md), not public issues.

## Development setup

You need Node.js 24, pnpm (the version in `package.json` is picked up by Corepack), git and git-lfs.
The published CLI supports Node.js 22.13 and later; `pnpm cli` runs TypeScript directly, which needs Node.js 24.

```sh
pnpm install
pnpm test        # Worker tests run in workerd with a local R2; CLI tests use real git
pnpm typecheck
pnpm lint        # oxlint (including layer rules) and oxfmt --check
pnpm format      # oxfmt, then oxlint --fix
pnpm build       # dist/cli.js and dist/worker.js
```

Run the CLI from source with `pnpm cli <command>`, and the Worker with `pnpm dev`. Put settings in
`.dev.vars`, which overrides the variables in `wrangler.jsonc`; at least `ALLOWED_OWNERS` is required,
for example `ALLOWED_OWNERS=your-github-name`. `.dev.vars.example` lists the secrets.

## How the code is organised

Read [docs/architecture.md](docs/architecture.md). In short: `domain/` holds rules and no I/O,
`app/` holds use cases that reach the outside world only through `ports.ts`, `infra/` implements
those ports, and `commands/` (CLI) or `http/` (Worker) are thin entry points. The lint config
rejects imports that break these boundaries.

## Pull requests

- Add or update tests for behaviour you change. Prefer testing use cases with the fakes in
  `test/cli/helpers.ts`, and domain logic directly.
- Keep `pnpm lint`, `pnpm typecheck` and `pnpm test` passing; CI runs them on Linux, macOS and Windows.
- Write commit messages (and PR titles, which become squash commit messages) in the
  [Conventional Commits](https://www.conventionalcommits.org/) style, such as
  `fix(gc): keep objects referenced by annotated tags`. `feat` and `fix` appear in the changelog;
  mark breaking changes with `!` or a `BREAKING CHANGE:` footer.
- Update the README when you change commands, options or server settings.

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Every push to `main` updates a release pull request that bumps the version in `package.json` and
`src/shared/contract.ts` and adds the new commits to [CHANGELOG.md](CHANGELOG.md).
Do not edit those by hand.

Merging the release pull request tags the release, creates the GitHub release, publishes to npm
with provenance through trusted publishing, and moves the `vX` tag used by the GitHub Action.
