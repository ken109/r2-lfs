import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";

import { createToken, getTokens, revokeToken } from "./-functions.ts";
import { Failure, formatDate, PageHeader } from "./-ui.tsx";

export const Route = createFileRoute("/_admin/tokens")({
  loader: () => getTokens(),
  component: TokensPage,
});

const layout = getRouteApi("/_admin");

function TokensPage(): ReactNode {
  const tokens = Route.useLoaderData();
  const { authMode } = layout.useLoaderData();
  const router = useRouter();
  const [created, setCreated] = useState<{ label: string; token: string }>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setFailure(undefined);
    const result = await createToken({
      data: { label: String(fields.get("label")), scope: String(fields.get("scope")), permission: String(fields.get("permission")) },
    });
    setBusy(false);
    if (!result.ok) return setFailure(result.message);
    setCreated({ label: result.value.entry.label, token: result.value.token });
    form.reset();
    await router.invalidate();
  }

  async function revoke(id: string, label: string) {
    if (!confirm(`Revoke ${label}? Clients using it stop working within 30 seconds.`)) return;
    setFailure(undefined);
    const result = await revokeToken({ data: { id } });
    if (!result.ok) setFailure(result.message);
    await router.invalidate();
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
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </button>
          </form>
          {created ? (
            <div className="notice" role="status">
              Token for <strong>{created.label}</strong>. Copy it now: it is not shown again.
              <div className="secret">
                <code>{created.token}</code>
                <button type="button" onClick={() => navigator.clipboard.writeText(created.token)}>
                  Copy
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {failure ? <Failure message={failure} /> : null}

      <section>
        <h2>Tokens</h2>
        {tokens.ok ? (
          <div className="table-wrap">
            {tokens.value.length === 0 ? (
              <p className="empty">No tokens in the bucket.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Repositories</th>
                    <th>Permission</th>
                    <th>Created</th>
                    <th>ID</th>
                    <th />
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
                      <td>{formatDate(token.created)}</td>
                      <td className="mono">{token.id}</td>
                      <td className="num">
                        <button type="button" className="danger" onClick={() => revoke(token.id, token.label)}>
                          Revoke
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
