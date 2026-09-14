import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { getOverview } from "./-functions.ts";
import { STYLES } from "./-ui.tsx";

export const Route = createFileRoute("/_admin")({
  loader: () => getOverview(),
  component: AdminLayout,
});

const PAGES = [
  { to: "/_admin", label: "Overview", exact: true },
  { to: "/_admin/tokens", label: "Tokens", exact: false },
  { to: "/_admin/locks", label: "Locks", exact: false },
] as const;

function AdminLayout(): ReactNode {
  const overview = Route.useLoaderData();
  return (
    <>
      <style>{STYLES}</style>
      <div className="shell">
        <nav className="sidebar" aria-label="Admin">
          <div className="brand">
            <span>r2</span>-lfs
          </div>
          {PAGES.map((page) => (
            <Link
              key={page.to}
              to={page.to}
              className="nav-link"
              activeProps={{ className: "nav-link active" }}
              activeOptions={{ exact: page.exact }}
            >
              {page.label}
            </Link>
          ))}
          <div className="who">Signed in as {overview.email}</div>
        </nav>
        <main>
          <Outlet />
        </main>
      </div>
    </>
  );
}
