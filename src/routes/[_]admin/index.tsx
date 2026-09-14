import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_admin/")({
  component: AdminHome,
});

function AdminHome() {
  return (
    <main>
      <h1>r2-lfs</h1>
    </main>
  );
}
