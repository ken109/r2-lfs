import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";

import { createToken, getTokens, revokeToken } from "./-functions.ts";
import { ActionStatus, Caption, CopyButton, Failure, PageHeader, RouteError, RoutePending, Time, useAction } from "./-ui.tsx";

export const Route = createFileRoute("/_admin/tokens")({
  loader: () => getTokens(),
  component: TokensPage,
  errorComponent: RouteError,
  pendingComponent: RoutePending,
});

const layout = getRouteApi("/_admin");

function TokensPage(): ReactNode {
  const tokens = Route.useLoaderData();
  const { authMode } = layout.useLoaderData();
  const router = useRouter();
  const action = useAction();
  const [created, setCreated] = useState<{ label: string; token: string }>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const data = { label: String(fields.get("label")), scope: String(fields.get("scope")), permission: String(fields.get("permission")) };
    await action.run("create", () => createToken({ data }), {
      success: (value) => `Created ${value.entry.label}`,
      after: async (value) => {
        setCreated({ label: value.entry.label, token: value.token });
        form.reset();
        await router.invalidate();
      },
    });
  }

  async function revoke(id: string, label: string) {
    if (!confirm(`Revoke ${label}? Clients using it stop working within 30 seconds.`)) return;
    await action.run(`revoke:${id}`, () => revokeToken({ data: { id } }), {
      success: (value) => `Revoked ${value.label}`,
      after: () => router.invalidate(),
    });
  }

  return (
    <>
      <PageHeader title="Tokens">
        Tokens kept in the bucket, as <code>r2-lfs token</code> manages them. Only their hashes are stored.
      </PageHeader>
      {authMode === "token" ? null : (
        <p className="notice warn">This server checks {authMode} permissions, so it does not accept these tokens.</p>
      )}

      <section>
        <h2>New token</h2>
        <div className="panel">
          <form className="inline" onSubmit={submit}>
            <label className="field">
              Label
              <input name="label" required placeholder="ci" autoComplete="off" />
            </label>
            <label className="field">
              Repositories
              <input name="scope" required placeholder="my-org/*" className="mono" autoComplete="off" />
            </label>
            <label className="field">
              Permission
              <select name="permission" defaultValue="write">
                <option value="read">read</option>
                <option value="write">write</option>
                <option value="admin">admin (can unlock others' locks)</option>
              </select>
            </label>
            <button type="submit" className="primary" disabled={action.busy !== undefined}>
              {action.busy === "create" ? "Creating…" : "Create"}
            </button>
          </form>
          {created ? (
            <div className="notice">
              Token for <strong>{created.label}</strong>. Copy it now: it is not shown again.
              <div className="secret">
                <code id="new-token">{created.token}</code>
                <CopyButton text={created.token} target={() => document.getElementById("new-token")} />
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <ActionStatus action={action} />

      <section>
        <h2>Tokens</h2>
        {tokens.ok ? (
          <div className="table-wrap">
            {tokens.value.length === 0 ? (
              <p className="empty">No tokens in the bucket.</p>
            ) : (
              <table>
                <Caption>Tokens in the bucket</Caption>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Repositories</th>
                    <th>Permission</th>
                    <th>Created</th>
                    <th>ID</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.value.map((token) => (
                    <tr key={token.id}>
                      <td>{token.label}</td>
                      <td className="mono">{token.scope}</td>
                      <td>
                        <span className="badge">{token.permission}</span>
                      </td>
                      <td>
                        <Time iso={token.created} />
                      </td>
                      <td className="mono">{token.id}</td>
                      <td className="num">
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Revoke ${token.label}`}
                          disabled={action.busy !== undefined}
                          onClick={() => revoke(token.id, token.label)}
                        >
                          {action.busy === `revoke:${token.id}` ? "Revoking…" : "Revoke"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <Failure message={tokens.message} />
        )}
      </section>
    </>
  );
}
