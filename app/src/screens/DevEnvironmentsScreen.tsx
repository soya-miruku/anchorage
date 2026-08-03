import {
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { AnchorageIcon } from "../components/AnchorageIcon";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

export function DevEnvironmentsScreen({
  store,
}: {
  store: AnchorageStore;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [menuEnvironmentId, setMenuEnvironmentId] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");

  if (store.isHost) {
    return (
      <UnsupportedSurface
        testId="devenv-screen"
        title="Dev Environments"
        description="No live Dev Environments provider is connected to this Anchorage build."
        commandQuery="compose"
        onOpenCommand={store.openCommandCenter}
      />
    );
  }

  const openCreate = () => {
    setName("");
    setRepository("");
    setCreateOpen(true);
  };

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!store.createDevEnvironment(name, repository)) return;
    setCreateOpen(false);
  };

  return (
    <section
      className="dev-environments-screen screen"
      data-testid="devenv-screen"
    >
      <header className="dev-environments-header">
        <div>
          <h1>Dev Environments</h1>
          <p>
            Reproducible workspaces built from a repo and a devcontainer spec.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={openCreate}>
          Create environment
        </button>
      </header>

      {store.devEnvironments.length > 0 ? (
        <div className="dev-environments-grid">
          {store.devEnvironments.map((environment) => {
            const menuOpen = menuEnvironmentId === environment.id;
            const opened = store.openedEnvironmentId === environment.id;
            return (
              <article
                className="dev-environment-card"
                data-testid={`devenv-${environment.id}`}
                key={environment.id}
              >
                <div className="dev-environment-card__heading">
                  <span
                    className={`dev-environment-card__dot dev-environment-card__dot--${environment.state}`}
                    aria-hidden="true"
                  />
                  <h2>{environment.name}</h2>
                  <span
                    className={`dev-environment-card__state dev-environment-card__state--${environment.state}`}
                  >
                    {environment.state === "running" ? "Running" : "Stopped"}
                  </span>
                </div>
                <div className="dev-environment-card__repo">
                  {environment.repository}
                </div>
                <div className="dev-environment-card__tags">
                  {environment.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <div className="dev-environment-card__divider" />
                <div className="dev-environment-card__actions">
                  <button
                    className="dev-environment-card__open"
                    type="button"
                    onClick={() => store.setOpenedEnvironmentId(environment.id)}
                  >
                    {opened ? "Opened" : "Open in editor"}
                  </button>
                  <div className="dev-environment-card__menu-wrap">
                    <button
                      className="dev-environment-card__more"
                      type="button"
                      aria-label={`More actions for ${environment.name}`}
                      aria-expanded={menuOpen}
                      onClick={() =>
                        setMenuEnvironmentId(menuOpen ? null : environment.id)
                      }
                    >
                      <AnchorageIcon name="more" size={17} />
                    </button>
                    {menuOpen && (
                      <div
                        className="dev-environment-menu"
                        data-testid={`devenv-menu-${environment.id}`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            store.toggleDevEnvironment(environment.id);
                            setMenuEnvironmentId(null);
                          }}
                        >
                          {environment.state === "running" ? "Stop" : "Start"}
                        </button>
                        <button
                          className="dev-environment-menu__delete"
                          type="button"
                          onClick={() => {
                            store.deleteDevEnvironment(environment.id);
                            setMenuEnvironmentId(null);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="dev-environments-empty" data-testid="devenv-empty">
          <span className="dev-environments-empty__icon">
            <TerminalWindowIcon aria-hidden="true" size={24} weight="light" />
          </span>
          <h2>No dev environments yet</h2>
          <p>
            Point Anchorage at a Git repository and it will build an isolated,
            shareable workspace with the toolchain already installed.
          </p>
          <button className="primary-button" type="button" onClick={openCreate}>
            Create from repository
          </button>
        </div>
      )}

      {createOpen && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="create-environment-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-environment-title"
            onSubmit={submitCreate}
          >
            <div className="create-environment-dialog__heading">
              <div>
                <h2 id="create-environment-title">Create environment</h2>
                <p>Build a workspace from a Git repository.</p>
              </div>
              <button
                type="button"
                aria-label="Close create environment"
                onClick={() => setCreateOpen(false)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>
            <label>
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="platform-dev"
                autoFocus
              />
            </label>
            <label>
              <span>Repository</span>
              <input
                value={repository}
                onChange={(event) => setRepository(event.currentTarget.value)}
                placeholder="github.com/acme/platform"
              />
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
                disabled={!name.trim() || !repository.trim()}
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
