# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [private vulnerability reporting](SECURITY.md), not public issues.

## Development setup

You need Node.js 24, pnpm (the version in `package.json` is picked up by Corepack), git and git-lfs.

```sh
pnpm install
pnpm test        # Worker tests run in workerd with a local R2; CLI tests use real git
pnpm typecheck
pnpm lint        # oxlint (including layer rules) and oxfmt --check
pnpm format      # oxfmt, then oxlint --fix
pnpm build       # dist/cli.js and dist/worker.js
```

Run the CLI from source with `pnpm cli <command>`, and the Worker with `pnpm dev`
(put settings in `.dev.vars`; see `.dev.vars.example`).

## How the code is organised

Read [docs/architecture.md](docs/architecture.md). In short: `domain/` holds rules and no I/O,
`app/` holds use cases that reach the outside world only through `ports.ts`, `infra/` implements
those ports, and `commands/` (CLI) or `http/` (Worker) are thin entry points. The lint config
rejects imports that break these boundaries.

## Pull requests

- Add or update tests for behaviour you change. Prefer testing use cases with the fakes in
  `test/cli/helpers.ts`, and domain logic directly.
- Keep `pnpm lint`, `pnpm typecheck` and `pnpm test` passing; CI runs them on Linux, macOS and Windows.
- Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) style,
  such as `fix(gc): keep objects referenced by annotated tags`.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Update the README when you change commands, options or server settings.

## Releasing

Maintainers only.

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `package.json` and `VERSION` in `src/shared/contract.ts` (a test keeps them equal).
3. Commit, tag `vX.Y.Z` and push the tag. The release workflow runs the checks, publishes to npm
   with provenance through trusted publishing, creates the GitHub release and moves the `vX` tag
   used by the GitHub Action.
