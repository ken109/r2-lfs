# Changelog

## [0.2.0](https://github.com/ken109/r2-lfs/compare/v0.1.0...v0.2.0) (2026-09-14)


### ⚠ BREAKING CHANGES

* in the shared layout, existing objects are unreadable until each repository pushes them again, for example with git lfs push --all; objects the server already stores are checked rather than uploaded.

### Features

* **admin:** accept changes only from the admin UI's own origin ([60f3160](https://github.com/ken109/r2-lfs/commit/60f3160133f91a14d49dab0b8f6f24732796a619))
* **admin:** activity page from Workers Analytics Engine ([a568d12](https://github.com/ken109/r2-lfs/commit/a568d120407d19eac182437e3ec28433d822ad68))
* **admin:** overview, storage, tokens and locks pages ([2848420](https://github.com/ken109/r2-lfs/commit/28484207909715f7a7109cf6816dce53842f892b))
* allow * within names in token scopes ([fad430e](https://github.com/ken109/r2-lfs/commit/fad430e0514109084db42b45e2f864b854cf0e2b))
* **cli:** add a git credential helper for tokens and GitHub Actions ([2c1bbc4](https://github.com/ken109/r2-lfs/commit/2c1bbc4a9963a3794ef614d3a2c35c9cb38083bc))
* **cli:** create admin tokens, and have init turn lock verification on ([e13cac6](https://github.com/ken109/r2-lfs/commit/e13cac61df7411613e8faeec8924d6b978707d6c))
* **cli:** transfer-agent uploads objects in resumable parts ([fc15bab](https://github.com/ken109/r2-lfs/commit/fc15babc2957a120e16a756e162f7bdee183bb05))
* encrypt objects at rest with an SSE-C key ([b2255a7](https://github.com/ken109/r2-lfs/commit/b2255a74f2f093bb5bdef6659c063d6ca6f3b909))
* hash presigned uploads, and limit shared objects to the repositories that uploaded them ([5c445e9](https://github.com/ken109/r2-lfs/commit/5c445e958b75bd1fbec433000289cc195f5ebe8d))
* let GitHub Actions workflows authenticate with their OIDC token ([ad3d9c1](https://github.com/ken109/r2-lfs/commit/ad3d9c1cf9f2f86e31538f48a4408a875b33c03f))
* limit object size and repository storage, and record request metrics ([9404fa0](https://github.com/ken109/r2-lfs/commit/9404fa085df057b599073aba4c0d31c33928956a))
* mirror permissions from GitLab, Gitea, Forgejo, Bitbucket and GitHub Enterprise Server ([edf13b8](https://github.com/ken109/r2-lfs/commit/edf13b841bcf69e86f9570e05d51f852df12fbf1))
* put the admin UI behind Cloudflare Access ([52785ef](https://github.com/ken109/r2-lfs/commit/52785efb2dd18334dd45d5d4af27d0c5ab02cf4c))
* serve the repositories listed in ALLOWED_REPOS, with * within names ([c9adc8f](https://github.com/ken109/r2-lfs/commit/c9adc8f14e782180a600565329a460bbfa10de8a))
* **setup:** take repository patterns with --repos and lock each one's prefix ([51717ee](https://github.com/ken109/r2-lfs/commit/51717eeb08998324a27c2d19054b9c851ee16837))
* support Git LFS file locking ([e76cf5b](https://github.com/ken109/r2-lfs/commit/e76cf5bc2fbd9454e20c0c11833de1151a283f60))
* weekly upgrade pull requests for Deploy to Cloudflare copies ([1a2177b](https://github.com/ken109/r2-lfs/commit/1a2177b38c8bf0804db2ade386599d65ba21bc4b))
* **worker:** multipart uploads through the Worker for a custom transfer agent ([cbb8d68](https://github.com/ken109/r2-lfs/commit/cbb8d684ba0ad3251476cb570e6d07b1e033ec8d))
* **worker:** serve byte ranges so interrupted downloads resume ([3d29837](https://github.com/ken109/r2-lfs/commit/3d29837a8da1727dadbdb998625aa4b90ac13352))


### Bug Fixes

* accept owner names with underscores, such as Enterprise Managed Users ([ebf5fe3](https://github.com/ken109/r2-lfs/commit/ebf5fe37e0d34943fe973a408382e8f7fcd5cb8d))
* **action:** run the CLI version the action was released with ([20fe8eb](https://github.com/ken109/r2-lfs/commit/20fe8eb676bfc5e25a9f26328d15eedfb88dbb6d))
* **archive:** write to a fresh temporary directory when --output is omitted ([0100d8a](https://github.com/ken109/r2-lfs/commit/0100d8ace2dd902339d238e9cbea638cf869a72c))
* **cli:** reject blank day counts instead of reading them as zero ([af15e80](https://github.com/ken109/r2-lfs/commit/af15e806b41ed0ff630c9d3e6109491479176599))
* **cli:** setup sets R2_ACCOUNT_ID from the Wrangler login ([d5ddcee](https://github.com/ken109/r2-lfs/commit/d5ddceeaa65462a2788ee9ee289fbbd10cb37b0b))
* **gc:** fetch every branch and tag and refuse clones with incomplete history ([2cacaa0](https://github.com/ken109/r2-lfs/commit/2cacaa0042231bd1a75f30680650db05013b40a9))
* **gc:** judge each shared-layout repository by its own policy ([962fba7](https://github.com/ken109/r2-lfs/commit/962fba7972d56d30d8121306375419d352ef75b0))
* **gc:** match rule paths as .gitattributes does and read every pointer format git-lfs accepts ([b978540](https://github.com/ken109/r2-lfs/commit/b97854058b7a8dbb7d97641060179ef2c4e720b8))
* **gc:** read every commit regardless of skewed dates and log settings ([bd94e9a](https://github.com/ken109/r2-lfs/commit/bd94e9a6f36de77792a07263a3180c37a8f441ed))
* **gc:** recheck refs before applying and keep the trash copy when a delete may have succeeded ([92851ff](https://github.com/ken109/r2-lfs/commit/92851ffbf661c63540278fd19287b13c2755ac76))
* **migrate:** copy the objects of every branch and tag on the remote ([3c1f5e5](https://github.com/ken109/r2-lfs/commit/3c1f5e54516b4cecb2e02967f839a10c94d6417f))
* **setup:** pass wrangler a relative config path ([68791a2](https://github.com/ken109/r2-lfs/commit/68791a2dfa4c989a68ae80e486d5e29843c0e5fb))
* stop advising lfs.locksverify = false now that the server has locks ([aa9765d](https://github.com/ken109/r2-lfs/commit/aa9765d45ddba5712197d0a9489e6e6b46fa7243))
* **worker:** answer 404 when a valid token does not cover the repository ([6926c11](https://github.com/ken109/r2-lfs/commit/6926c11fb2df346e3bf421251d07cc6e0755a95c))
* **worker:** ignore a tokens file with an unexpected shape ([acbbdd6](https://github.com/ken109/r2-lfs/commit/acbbdd6c6b9b6e9b85c9118df131425f9b196511))
* **worker:** keep serving when ANALYTICS_API_TOKEN has no account id ([37d0306](https://github.com/ken109/r2-lfs/commit/37d0306639e2658c791c237bcaa85483743e4deb))
* **worker:** read small request bodies that an answer leaves unread ([97f3427](https://github.com/ken109/r2-lfs/commit/97f3427c8ee79db5325f88cb05add49fa8dae390))
* **worker:** refuse uploads R2 cannot store in one request ([48b5014](https://github.com/ken109/r2-lfs/commit/48b5014ecf40c4e0054a78f9423a7869e46cbb78))
* **worker:** reject a JSON array as a batch request body ([bbce1a6](https://github.com/ken109/r2-lfs/commit/bbce1a63dffeb96a4d2eebe4b9b3ea1f3c432ad8))
* **worker:** report ALLOWED_OWNERS without any owner as a configuration problem ([8060104](https://github.com/ken109/r2-lfs/commit/80601042c194b5a4ecb8d7afd9e357af164aef12))
* **worker:** retry lock calls that fail with a retryable Durable Object error ([be97ccb](https://github.com/ken109/r2-lfs/commit/be97ccb3da6892d7233da0d678bf11149e1c29cc))
* **worker:** stop following GitHub redirects when checking permissions ([ba5efc3](https://github.com/ken109/r2-lfs/commit/ba5efc3abf478d3a175ffccee1f0a7f8392b8410))

## 0.1.0 (2026-09-13)


### Features

* **cli:** add the r2-lfs CLI and a GitHub Action for gc ([f82cc59](https://github.com/ken109/r2-lfs/commit/f82cc59cb6228c2c08dc81080f8a0d4180f34798))
* Git LFS server on Cloudflare Workers backed by R2 ([288a65f](https://github.com/ken109/r2-lfs/commit/288a65f0da0cf6ad126440743643d31514816a94))

## Changelog
