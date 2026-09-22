import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";

import { createToken, getTokens, revokeToken, rotateSessionKey } from "./-functions.ts";
import { ActionStatus, Caption, CopyButton, Failure, PageHeader, RouteError, RoutePending, Time, useAction, useConfirm } from "./-ui.tsx";

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
  const { confirm, dialog } = useConfirm();
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

  async function revoke(id: string, label: string, permission: string) {
    const confirmed = await confirm({
      title: "Revoke token",
      body: (
        <p>
          Clients using <strong>{label}</strong> stop working within 30 seconds. This cannot be undone; a new token has to be handed out
          instead.
        </p>
      ),
      action: `Revoke ${label}`,
      danger: true,
      // An admin token can unlock anyone's files; make sure it is the one meant.
      ...(permission === "admin" ? { typeToConfirm: label } : {}),
    });
    if (!confirmed) return;
    await action.run(`revoke:${id}`, () => revokeToken({ data: { id } }), {
      success: (value) => `Revoked ${value.label}`,
      after: () => router.invalidate(),
    });
  }

  async function rotate() {
    const confirmed = await confirm({
      title: "Rotate session key",
      body: (
        <p>
          <strong>Every short-lived token</strong> stops working within 5 minutes, including the ones in transfers that are running now.
          Tokens from <code>r2-lfs token</code> and <code>AUTH_TOKENS</code> are not affected.
        </p>
      ),
      action: "Rotate session key",
      danger: true,
      typeToConfirm: "rotate",
    });
    if (!confirmed) return;
    await action.run("rotate", () => rotateSessionKey(), { success: () => "Rotated the session key" });
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
      {dialog}

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
                          onClick={() => revoke(token.id, token.label, token.permission)}
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

      <section>
        <h2>Short-lived tokens</h2>
        <div className="panel">
          <p className="lede" style={{ marginTop: 0 }}>
            The Worker signs its own tokens for transfer actions (12 hours) and for <code>r2-lfs credential</code> (1 hour), with a key it
            keeps in <code>_meta/session-key</code>. They keep the permission they were issued with until they expire. Rotating the key
            revokes all of them within 5 minutes; clients then sign in again with their Git host credentials, and transfers in progress fail
            and have to be retried.
          </p>
          <button type="button" className="danger" onClick={rotate} disabled={action.busy !== undefined}>
            {action.busy === "rotate" ? "Rotating…" : "Rotate session key"}
          </button>
        </div>
      </section>
    </>
  );
}
