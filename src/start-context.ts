import type { AdminApi } from "./app/admin-api.ts";

// Shared by src/server.ts, which builds the context, and the admin UI's server functions, which read it.
declare module "@tanstack/react-router" {
  interface Register {
    /** What src/server.ts passes to every admin request, after Cloudflare Access let it through. */
    server: { requestContext: { admin: AdminApi } };
  }
}
