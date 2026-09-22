// Server functions of the admin UI. They run in the Worker, which reaches them only after Cloudflare Access let the
// request through (src/server.ts), and do their work through the AdminApi it passes as request context.

import { createServerFn } from "@tanstack/react-start";

export const getOverview = createServerFn({ method: "GET" }).handler(({ context }) => context.admin.overview());

// POST: counting writes the report it keeps.
export const countStorage = createServerFn({ method: "POST" }).handler(({ context }) => context.admin.storage());

export const getLastStorage = createServerFn({ method: "GET" }).handler(({ context }) => context.admin.lastStorage());

export const getTokens = createServerFn({ method: "GET" }).handler(({ context }) => context.admin.tokens());

export const createToken = createServerFn({ method: "POST" })
  .inputValidator((input: { label: string; scope: string; permission: string }) => input)
  .handler(({ context, data }) => context.admin.createToken(data));

export const revokeToken = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(({ context, data }) => context.admin.revokeToken(data.id));

export const getLocks = createServerFn({ method: "GET" })
  .inputValidator((input: { repository: string; cursor?: string; path?: string }) => input)
  .handler(({ context, data }) => context.admin.locks(data.repository, data.cursor, data.path));

export const unlock = createServerFn({ method: "POST" })
  .inputValidator((input: { repository: string; id: string }) => input)
  .handler(({ context, data }) => context.admin.unlock(data.repository, data.id));

export const getActivity = createServerFn({ method: "GET" })
  .inputValidator((input: { hours: number; repository?: string }) => input)
  .handler(({ context, data }) => context.admin.activity(data.hours, data.repository));

export const getObjects = createServerFn({ method: "GET" })
  .inputValidator((input: { repository: string; in: "live" | "trash"; cursor?: string }) => input)
  .handler(({ context, data }) => context.admin.objects(data.repository, data.in, data.cursor));

export const changeObjects = createServerFn({ method: "POST" })
  .inputValidator((input: { repository: string; action: "trash" | "restore" | "tier"; oids: string[] }) => input)
  .handler(({ context, data }) => context.admin.changeObjects(data.repository, data.action, data.oids));

export const rotateSessionKey = createServerFn({ method: "POST" }).handler(({ context }) => context.admin.rotateSessionKey());

export const getAudit = createServerFn({ method: "GET" })
  .inputValidator((input: { cursor?: string }) => input)
  .handler(({ context, data }) => context.admin.audit(data.cursor));
