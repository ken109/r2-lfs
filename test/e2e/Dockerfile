# Tests that change the global git config run only in this container; see CONTRIBUTING.md.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git git-lfs ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:pkg

ENV R2_LFS_E2E_CONTAINER=1 CI=true WRANGLER_SEND_METRICS=false
CMD ["pnpm", "exec", "vitest", "run", "--project", "e2e"]
