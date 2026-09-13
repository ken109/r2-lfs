# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

### Added

- Git LFS server for Cloudflare Workers backed by R2: batch API, proxy and presigned transfers,
  GitHub or token authentication, per-repository or shared storage layout, and a Deploy to Cloudflare setup.
- `r2-lfs` CLI with `setup`, `init`, `doctor`, `migrate`, `usage`, `verify`, `why`, `gc`, `restore`,
  `archive` and `token`.
- Retention policy in `.r2-lfs.toml`, a trash with lifecycle expiry, and Infrequent Access tiering.
- GitHub Action to run `r2-lfs gc` on a schedule.

[Unreleased]: https://github.com/ken109/r2-lfs/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ken109/r2-lfs/releases/tag/v0.1.0
