import { XIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { AnchorageIcon } from "../components/AnchorageIcon";
import { SortableHeader } from "../components/SortableHeader";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { NetworkSummary } from "../types";
import { useTableSort, type ColumnSort } from "../utils/tableSort";

const NETWORK_COLUMNS: ReadonlyArray<
  ColumnSort<NetworkSummary, "name" | "driver" | "scope" | "subnet" | "attached">
> = [
  { key: "name", label: "Name", kind: "text", value: (row) => row.name },
  { key: "driver", label: "Driver", kind: "text", value: (row) => row.driver },
  { key: "scope", label: "Scope", kind: "text", value: (row) => row.scope ?? "" },
  { key: "subnet", label: "Subnet", kind: "text", value: (row) => row.subnets[0] ?? "" },
  // -1 means the transport could not report attachments; keep those rows last.
  {
    key: "attached",
    label: "Attached",
    kind: "number",
    value: (row) => (row.containerCount < 0 ? null : row.containerCount),
  },
];

export function NetworksScreen({ store }: { store: AnchorageStore }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [subnet, setSubnet] = useState("");
  const [gateway, setGateway] = useState("");
  const [internal, setInternal] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<NetworkSummary | null>(null);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [query, setQuery] = useState("");

  const removable = useMemo(
    () => store.networks.filter((network) => !network.predefined),
    [store.networks],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return store.networks;
    return store.networks.filter((network) =>
      [network.name, network.driver, network.id, ...network.subnets]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [store.networks, query]);

  const { sorted: networkRows, headerProps } = useTableSort(filtered, NETWORK_COLUMNS);

  if (!store.isHost) {
    return (
      <UnsupportedSurface
        testId="networks-screen"
        title="Networks"
        description="Network management needs a live Docker engine. The browser preview uses deterministic fixtures and never connects to a daemon."
        commandQuery="network ls"
        onOpenCommand={store.openCommandCenter}
      />
    );
  }

  const submitCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreateOpen(false);
    void store.createNetwork({
      name: trimmed,
      driver: driver.trim() || undefined,
      subnet: subnet.trim() || undefined,
      gateway: gateway.trim() || undefined,
      internal,
    });
  };

  return (
    <section className="resource-screen screen" data-testid="networks-screen">
      <header className="resource-header">
        <div>
          <h1>Networks</h1>
          <p>
            {store.networks.length} network
            {store.networks.length === 1 ? "" : "s"} · {removable.length} user-defined
          </p>
        </div>
        <div className="screen-header__actions">
          <button
            className="ghost-button"
            type="button"
            data-testid="networks-prune-open"
            disabled={store.networkMutationPending || removable.length === 0}
            onClick={() => setPruneOpen(true)}
          >
            Clean up
          </button>
          <button
            className="primary-button"
            type="button"
            data-testid="networks-create-open"
            disabled={store.networkMutationPending}
            onClick={() => {
              setName("");
              setDriver("bridge");
              setSubnet("");
              setGateway("");
              setInternal(false);
              setCreateOpen(true);
            }}
          >
            Create network
          </button>
        </div>
      </header>

      <div className="images-toolbar">
        <label className="registry-search images-toolbar__search">
          <span className="sr-only">Filter networks</span>
          <AnchorageIcon name="search" size={13} />
          <input
            data-testid="networks-filter"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter by name, driver, subnet or ID…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="networks-table__head">
        <SortableHeader label="Name" ariaSort={headerProps("name")["aria-sort"]} onClick={headerProps("name").onClick} />
        <SortableHeader label="Driver" ariaSort={headerProps("driver")["aria-sort"]} onClick={headerProps("driver").onClick} />
        <SortableHeader label="Scope" ariaSort={headerProps("scope")["aria-sort"]} onClick={headerProps("scope").onClick} />
        <SortableHeader label="Subnet" ariaSort={headerProps("subnet")["aria-sort"]} onClick={headerProps("subnet").onClick} />
        <SortableHeader label="Attached" ariaSort={headerProps("attached")["aria-sort"]} onClick={headerProps("attached").onClick} />
      </div>
      <div className="networks-table__body" data-testid="networks-table-body">
        {networkRows.map((network) => (
          <div
            className="network-row"
            key={network.id}
            data-testid={`network-${network.id}`}
          >
            <span className="network-row__name">
              <strong>{network.name}</strong>
              {network.predefined && (
                <span className="usage-pill">Built-in</span>
              )}
              {network.internal && <span className="usage-pill">Internal</span>}
            </span>
            <span className="resource-muted">{network.driver}</span>
            <span className="resource-muted">{network.scope ?? "—"}</span>
            <span className="resource-mono resource-secondary">
              {network.subnets.length > 0 ? network.subnets.join(", ") : "—"}
            </span>
            <span className="network-row__attached">
              {/* -1 means the transport could not report attachments. Unknown stays unknown. */}
              {network.containerCount < 0
                ? "Unknown"
                : `${network.containerCount} container${network.containerCount === 1 ? "" : "s"}`}
              <button
                className="volume-row__remove"
                type="button"
                aria-label={`Remove network ${network.name}`}
                title={
                  network.predefined
                    ? "Docker's built-in networks cannot be removed"
                    : "Remove"
                }
                disabled={network.predefined || store.networkMutationPending}
                onClick={() => setPendingRemove(network)}
              >
                <AnchorageIcon name="delete" size={12} />
              </button>
            </span>
          </div>
        ))}
        {networkRows.length === 0 && (
          <div className="empty-state" data-testid="networks-empty-state">
            <strong>No networks match</strong>
            <p>Clear the filter, or create a user-defined network.</p>
          </div>
        )}
      </div>

      {createOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="create-environment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-network-title"
            data-testid="create-network-dialog"
            onSubmit={submitCreate}
          >
            <div className="create-environment-dialog__heading">
              <div>
                <h2 id="create-network-title">Create network</h2>
                <p>Leave the address fields empty to let Docker allocate a subnet.</p>
              </div>
              <button
                type="button"
                aria-label="Close create network"
                onClick={() => setCreateOpen(false)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>
            <label>
              <span>Name</span>
              <input
                data-testid="create-network-name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="app-net"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label>
              <span>Driver</span>
              <input
                data-testid="create-network-driver"
                value={driver}
                onChange={(event) => setDriver(event.currentTarget.value)}
                placeholder="bridge"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>Subnet</span>
              <input
                data-testid="create-network-subnet"
                value={subnet}
                onChange={(event) => setSubnet(event.currentTarget.value)}
                placeholder="172.20.0.0/16"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span>Gateway</span>
              <input
                data-testid="create-network-gateway"
                value={gateway}
                onChange={(event) => setGateway(event.currentTarget.value)}
                placeholder="172.20.0.1"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="prune-option">
              <input
                type="checkbox"
                data-testid="create-network-internal"
                checked={internal}
                onChange={(event) => setInternal(event.currentTarget.checked)}
              />
              <span>
                Internal
                <small>Containers on this network get no external access.</small>
              </span>
            </label>
            <div className="create-environment-dialog__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={!name.trim() || store.networkMutationPending}
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingRemove && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="create-environment-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-network-title"
            data-testid="remove-network-dialog"
          >
            <div className="create-environment-dialog__heading">
              <div>
                <h2 id="remove-network-title">Remove network</h2>
                <p>
                  “{pendingRemove.name}” will be removed. Containers still
                  attached to it will be disconnected by Docker.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close remove network"
                onClick={() => setPendingRemove(null)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>
            <div className="create-environment-dialog__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setPendingRemove(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button primary-button--danger"
                type="button"
                data-testid="remove-network-confirm"
                onClick={() => {
                  const target = pendingRemove;
                  setPendingRemove(null);
                  void store.removeNetwork(target);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {pruneOpen && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="create-environment-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="prune-networks-title"
            data-testid="prune-networks-dialog"
          >
            <div className="create-environment-dialog__heading">
              <div>
                <h2 id="prune-networks-title">Clean up networks</h2>
                <p>
                  Docker removes every user-defined network no container is
                  attached to. Built-in networks are never touched.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close clean up networks"
                onClick={() => setPruneOpen(false)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>
            <div className="create-environment-dialog__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setPruneOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button primary-button--danger"
                type="button"
                data-testid="prune-networks-confirm"
                onClick={() => {
                  setPruneOpen(false);
                  void store.pruneNetworks();
                }}
              >
                Clean up
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
