import { AnchorageIcon } from "../components/AnchorageIcon";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import type { AnchorageStore } from "../store/useAnchorageStore";

/**
 * docker-features.md §24.9 ("A Desktop extension can include backend containers, Docker
 * socket access and host executables") and §6.11 (the safeguard Docker names is publisher
 * trust plus the permission list). Stated on both branches: the packaged host build is the
 * one users get and it offers no install at all, so attaching this to the Install button
 * would make the disclosure a side effect of the marketplace being reachable.
 */
const PRIVILEGE_DISCLOSURE =
  "Installing an extension can run backend containers, grant Docker socket access, and place executables on the host — closer to installing an application than to opening a web page. Anchorage does not review or contain what an installed extension then does; the safeguards are the publisher you trust and the permissions you read beforehand.";

export function ExtensionsScreen({ store }: { store: AnchorageStore }) {
  if (store.isHost) {
    return (
      <UnsupportedSurface
        testId="extensions-screen"
        title="Extensions"
        description="The desktop host does not expose an extension marketplace or installed-extension provider."
        posture={PRIVILEGE_DISCLOSURE}
        commandQuery=""
        onOpenCommand={store.openCommandCenter}
      />
    );
  }
  return (
    <section className="extensions-screen screen" data-testid="extensions-screen">
      <header>
        <h1>Extensions</h1>
        <p>{store.extensionSummary}</p>
        <p data-testid="extensions-privilege-disclosure">
          {PRIVILEGE_DISCLOSURE}
        </p>
      </header>

      <div className="extensions-grid">
        {store.extensions.map((extension) => {
          const installed = store.installedExtensions.has(extension.name);
          return (
            <article className="extension-card" key={extension.name}>
              <div className="extension-card__heading">
                <span
                  className="extension-card__initial"
                  aria-hidden="true"
                >
                  {extension.name.charAt(0)}
                </span>
                <div>
                  <h2>{extension.name}</h2>
                  <span>{extension.publisher}</span>
                </div>
              </div>
              <p>{extension.description}</p>
              <div className="extension-card__metrics">
                <span>
                  <AnchorageIcon name="rating" size={10} />
                  {extension.rating}
                </span>
                <span>·</span>
                <span>{extension.installs} installs</span>
              </div>
              <button
                className={`extension-card__action${
                  installed ? " extension-card__action--installed" : ""
                }`}
                type="button"
                aria-pressed={installed}
                onClick={() => store.toggleExtension(extension.name)}
              >
                {installed ? "Installed" : "Install"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
