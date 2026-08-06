import { useEffect, useState } from "react";

import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { SecretSummary } from "../types";

/**
 * What this capability does and does not protect, stated in every engine state — on a Swarm
 * manager, on an engine with no Swarm at all, and in the browser preview. Shared so the two
 * branches below cannot drift apart, and so the claim is never a side effect of the surface
 * happening to be reachable.
 */
const SECRETS_POSTURE =
  "A workload that receives a secret can read its own environment and send the value anywhere. " +
  "References keep plaintext out of config and history — they do not constrain what an " +
  "authorised process does next.";

/**
 * A timestamp, or the transport's own words for one.
 *
 * The Engine reports RFC3339; the CLI reports "2 hours ago", which is not a moment this build
 * can recover. Rendering the second one as if it were the first would manufacture a precision
 * the transport never supplied, so each is shown as it arrived.
 */
function formatMoment(exact?: string, display?: string) {
  if (exact) {
    const parsed = new Date(exact);
    if (!Number.isNaN(parsed.getTime())) {
      const iso = parsed.toISOString();
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    }
  }
  return display?.trim() || "—";
}

/** Structured labels from the Engine, or the CLI's own comma-joined string. */
function formatLabels(secret: SecretSummary) {
  const entries = Object.entries(secret.labels ?? {});
  if (entries.length > 0) {
    return entries.map(([key, value]) => `${key}=${value}`).join(", ");
  }
  return secret.labelsText?.trim() || "—";
}

/**
 * Why the secret store is unreachable, and what would change it.
 *
 * An engine that never joined a swarm and a worker inside one refuse identically, but the
 * fixes are opposite — create a swarm here, or point at the manager. Docker's own
 * LocalNodeState is what separates them, so it drives the sentence rather than a single
 * catch-all message.
 */
function swarmExplanation(nodeState: string) {
  switch (nodeState) {
    case "inactive":
      return "This engine has not joined a swarm, so it has no secret store at all. `docker swarm init` would create one.";
    case "active":
      return "This engine is in a swarm but is not a manager, so it cannot read the store. Only a manager node can, and Anchorage would have to be pointed at that node's Docker context.";
    case "pending":
      return "This engine is still joining a swarm. The store becomes readable if it settles as a manager.";
    case "locked":
      return "This engine's swarm is locked. Its store stays sealed until the manager is unlocked with `docker swarm unlock`.";
    case "error":
      return "This engine reports its swarm as failed, so the store cannot be read.";
    default:
      return "This engine did not report a swarm state, so the store could not be read.";
  }
}


/**
 * Creating a secret.
 *
 * The value lives in this component's state and nowhere else — it is handed straight to
 * `bridge.secrets.create`, which base64-encodes it at the boundary and sends it to the Engine
 * API in a JSON body. It never becomes an argv element, which is the reason this screen does
 * not shell out: argv is world-readable in /proc for the life of the process and lands in this
 * codebase's own command receipts.
 *
 * The field is cleared the moment the create succeeds. There is no "show" toggle: the value
 * cannot be read back afterwards from anywhere, so a control implying otherwise would be a lie
 * about the one property this screen exists to explain.
 */
function CreateSecret({ store }: { store: AnchorageStore }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const busy = store.secretBusy === name && name.length > 0;

  return (
    <form
      className="secret-create"
      data-testid="secret-create"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || !value) return;
        void store
          .secretAction({ action: "create", name: name.trim(), value })
          .then((ok) => {
            if (!ok) return;
            setName("");
            setValue("");
          });
      }}
    >
      <h2>Create a secret</h2>
      <div className="secret-create__row">
        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="api-token"
            maxLength={64}
            pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
            required
          />
        </label>
        <label>
          <span>Value</span>
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Stored once, never readable again"
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      <p className="secret-create__note">
        Written straight to the Engine API. The value is never placed on a command line, never
        logged, and cannot be read back — by Anchorage or by anything else.
      </p>
      {store.secretError && (
        <p className="capability-error" role="alert" data-testid="secret-action-error">
          {store.secretError}
        </p>
      )}
    </form>
  );
}

/** A removal cannot be undone by retyping what is on screen, because the value was never on it. */
function RemoveSecret({
  store,
  secret,
}: {
  store: AnchorageStore;
  secret: SecretSummary;
}) {
  const [confirming, setConfirming] = useState(false);
  const busy = store.secretBusy === secret.id;

  if (!confirming) {
    return (
      <button
        type="button"
        className="ghost-button ghost-button--danger"
        data-testid={`secret-remove-${secret.id}`}
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        Remove
      </button>
    );
  }
  return (
    <span className="secret-row__confirm">
      <button
        type="button"
        className="ghost-button ghost-button--danger"
        data-testid={`secret-remove-confirm-${secret.id}`}
        disabled={busy}
        onClick={() => {
          setConfirming(false);
          void store.secretAction({ action: "remove", id: secret.id });
        }}
      >
        {busy ? "Removing…" : "Delete for good"}
      </button>
      <button type="button" className="ghost-button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}

function HostSecrets({ store }: { store: AnchorageStore }) {
  useEffect(() => {
    void store.refreshSecrets();
  }, [store.refreshSecrets]);

  const swarm = store.secretsSwarm;
  const secrets = store.secrets;
  const status = store.secretsStatus;
  const manager = swarm?.manager === true;

  return (
    <section className="resource-screen screen" data-testid="secrets-screen">
      <header className="resource-header">
        <div>
          <h1>Secrets</h1>
          <p>
            {status === "loading" && swarm === null
              ? "Reading the Swarm secret store…"
              : manager
                ? `${secrets.length} secret reference${secrets.length === 1 ? "" : "s"}`
                : "No Swarm secret store on this engine"}
          </p>
          {/* The label carries the meaning; the colour only reinforces it. Four themes ship,
              one of them greyscale, so nothing here may rest on hue. */}
          {swarm && (
            <p
              className={`swarm-chip swarm-chip--${manager ? "manager" : "absent"}`}
              data-testid="secrets-swarm-chip"
            >
              {manager ? "Swarm manager" : "Not a Swarm manager"}
              <span className="resource-dim"> · node state {swarm.nodeState}</span>
            </p>
          )}
          {status === "error" && (
            <p className="capability-error" role="status">
              Live secrets unavailable: {store.secretsError}
            </p>
          )}
        </div>
      </header>

      {/*
        The single most important fact about this screen, and the reason it has no inspect
        control: Docker discards the plaintext at creation. Stated rather than implied,
        because a list of things called "secrets" invites the assumption that opening one
        shows a value.
      */}
      <div className="secrets-notice" data-testid="secrets-value-notice">
        <strong>Docker never returns a secret's value.</strong>
        <p>
          The daemon discards the plaintext once a secret exists. No API call and no CLI
          command reads it back — only the containers it is granted to ever see it. What is
          listed here is references and metadata, and Anchorage has no verb that could
          fetch more.
        </p>
      </div>

      {/*
        The trap this screen exists to avoid. `docker secret` and Docker Pass are two
        different mechanisms, and one being live says nothing about the other.
      */}
      <div className="secrets-notice" data-testid="secrets-pass-notice">
        <strong>These are Swarm secrets, not se:// references.</strong>
        <p>
          Docker Pass is a separate secrets engine with its own store, and it is what
          resolves <code>se://</code> references. Anchorage does not project it: nothing on
          this screen resolves an <code>se://</code> reference, whether or not Docker Pass
          is installed on this host.
        </p>
      </div>

      {manager && <CreateSecret store={store} />}

      {!swarm && status === "error" ? (
        <div className="empty-state" data-testid="secrets-error-state">
          <strong>Secrets unavailable</strong>
          <p>
            The last refresh failed, so nothing can be listed. This is not the same as an
            engine without a secret store — that state is reported by name.
          </p>
        </div>
      ) : !swarm ? (
        <p className="resource-dim secrets-pending" role="status">
          Reading the Swarm secret store…
        </p>
      ) : !manager ? (
        <div className="empty-state" data-testid="secrets-no-swarm">
          <strong>This engine is not a Swarm manager</strong>
          <p>{swarmExplanation(swarm.nodeState)}</p>
          <p>
            That is a different thing from a manager whose store is empty: there is no store
            here to be empty.
          </p>
          {swarm.reason && (
            <p className="resource-dim" data-testid="secrets-swarm-reason">
              Docker said: “{swarm.reason}”
            </p>
          )}
        </div>
      ) : secrets.length === 0 ? (
        <div className="empty-state" data-testid="secrets-empty">
          <strong>This Swarm holds no secrets</strong>
          <p>
            The engine is a Swarm manager and its secret store answered — it is empty.
            Creating and removing secrets is out of scope for this build; that stays with{" "}
            <code>docker secret create</code>.
          </p>
        </div>
      ) : (
        <>
          <div className="secrets-table__head">
            <span>Name</span>
            <span>ID</span>
            <span>Created</span>
            <span>Updated</span>
            <span>Labels</span>
            <span className="sr-only">Actions</span>
          </div>
          <div className="secrets-table__body" data-testid="secrets-table-body">
            {secrets.map((secret) => (
              <div
                className="secret-row"
                key={secret.id}
                data-testid={`secret-${secret.id}`}
              >
                <span className="secret-row__name">
                  <strong>{secret.name}</strong>
                  {/* An external driver means the value never entered Swarm's own store,
                      which changes where an operator has to go looking for it. */}
                  {secret.driver && (
                    <span className="usage-pill">{secret.driver}</span>
                  )}
                </span>
                <span className="resource-mono resource-secondary">{secret.id}</span>
                <span className="resource-muted">
                  {formatMoment(secret.createdAt, secret.createdDisplay)}
                </span>
                <span className="resource-muted">
                  {formatMoment(secret.updatedAt, secret.updatedDisplay)}
                  {secret.version !== undefined && secret.version > 0 && (
                    <span className="resource-dim"> · v{secret.version}</span>
                  )}
                </span>
                <span className="resource-muted" title={formatLabels(secret)}>
                  {formatLabels(secret)}
                </span>
                <span className="secret-row__actions">
                  <RemoveSecret store={store} secret={secret} />
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {store.secretsLimitations.length > 0 && (
        <ul className="secrets-limitations" data-testid="secrets-limitations">
          {store.secretsLimitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}

      <p className="secrets-posture" data-testid="secrets-screen-posture">
        {SECRETS_POSTURE}
      </p>
    </section>
  );
}

/**
 * Docker Pass is the subject of the unavailable branch; Swarm secrets are named only to keep
 * them apart from it. `docker secret` is a live Engine surface on a Swarm manager and the
 * host branch above lists it — but it resolves no se:// reference, which is what this
 * destination is still missing.
 */
export function SecretsScreen({ store }: { store: AnchorageStore }) {
  if (store.isHost) {
    return <HostSecrets store={store} />;
  }
  return (
    <UnsupportedSurface
      testId="secrets-screen"
      title="Secrets"
      description="The browser preview never connects to a daemon, so no secret references are listed here; on a live engine Anchorage lists Swarm secrets, which only a Swarm manager can serve. Docker Pass — the separate secrets engine that resolves se:// references — is a different mechanism with its own store, and Anchorage does not project it in any mode."
      posture={SECRETS_POSTURE}
      commandQuery="secret"
      onOpenCommand={store.openCommandCenter}
    />
  );
}
