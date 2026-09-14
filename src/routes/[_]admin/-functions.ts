// Server functions of the admin UI. They run in the Worker, which reaches them only after Cloudflare Access let the
// request through (src/server.ts), and do their work through the AdminApi it passes as request context.

import { createServerFn } from "@tanstack/react-start";

export const getOverview = createServerFn({ method: "GET" }).handler(({ context }) => context.admin.overview());

export const getStorage = createServerFn({ method: "GET" }).handler(({ context }) => context.admin.storage());

export const getTokens = createServerFn({ method: "GET" }).handler(({ context }) => context.admin.tokens());

export const createToken = createServerFn({ method: "POST" })
  .inputValidator((input: { label: string; scope: string; permission: string }) => input)
  .handler(({ context, data }) => context.admin.createToken(data));

export const revokeToken = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(({ context, data }) => context.admin.revokeToken(data.id));

export const getLocks = createServerFn({ method: "GET" })
  .inputValidator((input: { repository: string; cursor?: string }) => input)
  .handler(({ context, data }) => context.admin.locks(data.repository, data.cursor));

export const unlock = createServerFn({ method: "POST" })
  .inputValidator((input: { repository: string; id: string }) => input)
  .handler(({ context, data }) => context.admin.unlock(data.repository, data.id));
