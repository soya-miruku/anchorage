import { useMemo, useState } from "react";

import type { AnchorageContainer } from "../types";

/**
 * Republishing a container's ports.
 *
 * This is not an edit and the dialog does not pretend otherwise. Docker fixes port bindings when
 * a container is created — `docker update` covers resources and restart policy, not bindings — so
 * the only supported route is to create a replacement. The consequences are stated up front
 * rather than discovered afterwards: the container gets a new ID, its writable layer is
 * discarded, and its log history goes with it, because logs belong to a container and not to a
 * name.
 *
 * Everything else is carried across from the container's own definition by the core, which
 * assembles the replacement from Docker's recorded `Config` and `HostConfig` rather than from a
 * list of fields somebody remembered to copy.
 */

type Binding = { host: string; container: string };

/** Parses Docker's own summary string, e.g. "8080:80/tcp, 9229:9229/tcp". */
function parseBindings(ports: string): Binding[] {
  return ports
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [left, right] = entry.split("->").map((part) => part.trim());
      const spec = right ?? left;
      const parts = spec.split(":");
      if (parts.length < 2) return [];
      const host = parts[parts.length - 2];
      const container = parts[parts.length - 1];
      if (!host || !container) return [];
      return [{ host, container: container.includes("/") ? container : `${container}/tcp` }];
    });
}

const NUMERIC_PORT = /^\d{1,5}$/u;
const CONTAINER_PORT = /^\d{1,5}(?:\/(?:tcp|udp|sctp))?$/u;

export function RebindPortsDialog({
  container,
  pending,
  onCancel,
  onConfirm,
}: {
  container: AnchorageContainer;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (ports: Record<string, string>) => void;
}) {
  const initial = useMemo(() => parseBindings(container.ports ?? ""), [container.ports]);
  const [bindings, setBindings] = useState<Binding[]>(initial);
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, patch: Partial<Binding>) => {
    setBindings((current) =>
      current.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    );
    setError(null);
  };

  const submit = () => {
    const ports: Record<string, string> = {};
    for (const entry of bindings) {
      const host = entry.host.trim();
      const target = entry.container.trim();
      if (!host && !target) continue;
      if (!NUMERIC_PORT.test(host)) {
        setError(`“${host || "empty"}” is not a host port. It has to be a number.`);
        return;
      }
      if (!CONTAINER_PORT.test(target)) {
        setError(
          `“${target || "empty"}” is not a container port. Use a number, optionally with /tcp, /udp or /sctp.`,
        );
        return;
      }
      // Docker would reject this at create time — after the original had already been parked —
      // so it is caught here where nothing has happened yet.
      if (ports[host] !== undefined) {
        setError(`Two bindings both publish host port ${host}.`);
        return;
      }
      ports[host] = target.includes("/") ? target : `${target}/tcp`;
    }
    onConfirm(ports);
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="dialog rebind-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebind-ports-title"
        data-testid="rebind-ports-dialog"
      >
        <div className="dialog__head">
          <h2 id="rebind-ports-title">Republish ports for {container.name}</h2>
          <button type="button" aria-label="Close republish ports" onClick={onCancel}>
            ×
          </button>
        </div>

        <p className="rebind-dialog__lede">
          Docker fixes port bindings when a container is created, so this <strong>replaces</strong>{" "}
          {container.name} with a new container that publishes what you choose. Everything Docker
          recorded — image, command, environment, mounts, networks, restart policy, health check —
          is carried across.
        </p>

        <ul className="rebind-dialog__losses">
          <li>The container gets a new identifier. Anything holding the current one goes stale.</li>
          <li>
            The writable layer is discarded: whatever a process wrote inside the container, rather
            than into a volume or bind mount, does not survive.
          </li>
          <li>Log history belongs to a container rather than a name, so it does not carry over.</li>
        </ul>

        <div className="rebind-dialog__bindings">
          {bindings.length === 0 && (
            <p className="resource-dim">
              Nothing is published. The container will still run; it just will not be reachable
              from the host on any port.
            </p>
          )}
          {bindings.map((binding, index) => (
            <div className="rebind-dialog__row" key={index}>
              <label>
                <span>Host</span>
                <input
                  data-testid={`rebind-host-${index}`}
                  value={binding.host}
                  inputMode="numeric"
                  onChange={(event) => update(index, { host: event.currentTarget.value })}
                />
              </label>
              <span aria-hidden="true">→</span>
              <label>
                <span>Container</span>
                <input
                  data-testid={`rebind-container-${index}`}
                  value={binding.container}
                  onChange={(event) => update(index, { container: event.currentTarget.value })}
                />
              </label>
              <button
                type="button"
                className="ghost-button"
                data-testid={`rebind-remove-${index}`}
                aria-label={`Remove binding ${index + 1}`}
                onClick={() => {
                  setBindings((current) => current.filter((_, position) => position !== index));
                  setError(null);
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost-button"
            data-testid="rebind-add"
            onClick={() => {
              setBindings((current) => [...current, { host: "", container: "" }]);
              setError(null);
            }}
          >
            Add binding
          </button>
        </div>

        {error && (
          <p className="capability-error" data-testid="rebind-error" role="status">
            {error}
          </p>
        )}

        <div className="dialog__actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            data-testid="rebind-confirm"
            disabled={pending}
            onClick={submit}
          >
            {pending ? "Replacing…" : "Replace container"}
          </button>
        </div>
      </div>
    </div>
  );
}
