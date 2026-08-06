import { useEffect, useState } from "react";

import { CapabilitySetup } from "../components/CapabilitySetup";
import { UnsupportedSurface } from "../components/UnsupportedSurface";
import { capabilityForView } from "../data/capabilities";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { MCPServer } from "../types";

/**
 * The MCP Toolkit.
 *
 * An MCP server is a container that grants an agent a set of tools. The decision worth
 * supporting is not "run this" — it is "should I let an agent have this", and that decision
 * needs two things in front of you before you make it: every tool the server would expose, and
 * every credential it will demand. Both sit in the catalogue and neither is visible from
 * `docker mcp catalog list`, which prints a reference, a digest and a title.
 *
 * So this is a browser with the disclosure attached: catalogues, the servers inside one, and
 * for each server what it could do and what it wants. Enabling is left to the CLI — a wrong
 * click here would grant an agent access to somebody's document store.
 */

const POSTURE =
  "Containerising a tool server limits its dependencies and its runtime blast radius. It does not reduce the authority you granted it — a token with write access still writes, whatever it runs inside. Every tool listed under a server is something an agent using it can call without asking you again.";

function ServerCard({ server }: { server: MCPServer }) {
  // Collapsed by default: a catalogue here carries 52 servers with ten tools each, and 520
  // rows nobody is reading yet buries the one they came for. The counts stay on the closed
  // row, so the disclosure is folded rather than hidden.
  const [open, setOpen] = useState(false);

  return (
    <article className="mcp-server" data-testid={`mcp-server-${server.name}`}>
      <button
        type="button"
        className="mcp-server__head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="mcp-server__name">{server.title || server.name}</span>
        <span className="mcp-server__counts">
          {server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
          {server.secrets.length > 0 &&
            ` · ${server.secrets.length} ${
              server.secrets.length === 1 ? "secret" : "secrets"
            }`}
        </span>
      </button>

      {server.description && (
        <p className="mcp-server__description">{server.description}</p>
      )}

      <p className="mcp-server__meta">
        {server.category && <span>{server.category}</span>}
        {server.owner && <span>{server.owner}</span>}
        {server.license && <span>{server.license}</span>}
        {server.githubStars ? <span>{server.githubStars}★</span> : null}
      </p>

      {open && (
        <div className="mcp-server__detail">
          {server.secrets.length > 0 && (
            <div
              className="mcp-server__secrets"
              data-testid={`mcp-secrets-${server.name}`}
            >
              <h5>Wants</h5>
              <p>
                This server will not run until these are set. Each one is a
                credential handed to a container.
              </p>
              <ul>
                {server.secrets.map((secret) => (
                  <li key={secret}>
                    <code>{secret}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div
            className="mcp-server__tools"
            data-testid={`mcp-tools-${server.name}`}
          >
            <h5>Can</h5>
            <ul>
              {server.tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  {tool.description && <span>{tool.description}</span>}
                </li>
              ))}
            </ul>
            {server.toolsTruncated && (
              <p className="mcp-server__truncated">
                Showing the first {server.tools.length} of {server.toolCount}.
              </p>
            )}
          </div>
          {server.image && (
            <p className="mcp-server__image resource-mono">{server.image}</p>
          )}
        </div>
      )}
    </article>
  );
}

export function ToolsScreen({ store }: { store: AnchorageStore }) {
  const capability = capabilityForView("tools");
  if (!capability) {
    throw new Error("tools is missing from the capability catalogue");
  }

  const {
    isHost,
    mcpReport,
    mcpCatalogDetail,
    mcpStatus,
    mcpError,
    mcpCatalogLoading,
    refreshMcp,
    openMcpCatalog,
    closeMcpCatalog,
  } = store;

  useEffect(() => {
    if (isHost) void refreshMcp();
  }, [isHost, refreshMcp]);

  if (!isHost) {
    return (
      <UnsupportedSurface
        testId="tools-screen"
        title="Tools"
        description="The MCP Toolkit reads catalogues from a live machine. The browser preview uses deterministic fixtures and never runs the CLI."
        posture={POSTURE}
        commandQuery="mcp"
        onOpenCommand={store.openCommandCenter}
      />
    );
  }

  if (mcpStatus === "unavailable") {
    return (
      <CapabilitySetup
        store={store}
        capability={capability}
        testId="tools-screen"
        posture={POSTURE}
      />
    );
  }

  const catalogs = mcpReport?.catalogs ?? [];

  return (
    <section className="tools-screen screen" data-testid="tools-screen">
      <header className="tools-header">
        <div>
          <h1>Tools</h1>
          <p>
            Model Context Protocol servers, from the catalogues this machine knows
            about. Each server is a container that grants an agent a set of tools.
          </p>
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={() => void refreshMcp()}
          disabled={mcpStatus === "loading"}
        >
          {mcpStatus === "loading" ? "Reading…" : "Re-check"}
        </button>
      </header>

      <p className="tools-posture" data-testid="tools-screen-posture">
        {POSTURE}
      </p>

      {mcpError && (
        <div className="compose-notice" role="alert" data-testid="mcp-error">
          {mcpError}
        </div>
      )}

      {catalogs.length === 0 ? (
        <p className="models-empty" data-testid="mcp-no-catalogs">
          No catalogues on this machine. <code>docker mcp catalog create</code>{" "}
          builds one — from Docker&rsquo;s published catalogue, a community
          registry, or specific server images.
        </p>
      ) : (
        <section className="tools-block">
          <h2>Catalogues</h2>
          <ul className="mcp-catalogs" data-testid="mcp-catalogs">
            {catalogs.map((catalog) => (
              <li key={catalog.reference}>
                <div>
                  <span className="mcp-catalogs__ref">{catalog.reference}</span>
                  {catalog.title && (
                    <span className="mcp-catalogs__title">{catalog.title}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={mcpCatalogLoading === catalog.reference}
                  onClick={() => void openMcpCatalog(catalog.reference)}
                >
                  {mcpCatalogLoading === catalog.reference ? "Opening…" : "Open"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mcpReport && mcpReport.profiles.length > 0 && (
        <section className="tools-block">
          <h2>Profiles</h2>
          <ul className="mcp-profiles" data-testid="mcp-profiles">
            {mcpReport.profiles.map((profile) => (
              <li key={profile.id}>
                <code>{profile.id}</code>
                {profile.title && <span>{profile.title}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {mcpCatalogDetail && (
        <section className="tools-block" data-testid="mcp-catalog-detail">
          <div className="tools-block__heading">
            <h2>
              {mcpCatalogDetail.title || mcpCatalogDetail.reference} ·{" "}
              {mcpCatalogDetail.serverCount} servers
            </h2>
            <button
              type="button"
              className="ghost-button"
              onClick={closeMcpCatalog}
            >
              Close
            </button>
          </div>
          {mcpCatalogDetail.source && (
            <p className="tools-block__note">
              Source <code>{mcpCatalogDetail.source}</code>
            </p>
          )}
          <div className="mcp-servers">
            {mcpCatalogDetail.servers.map((server) => (
              <ServerCard key={server.name} server={server} />
            ))}
          </div>
          {mcpCatalogDetail.truncated && (
            <p className="mcp-server__truncated">
              Showing the first {mcpCatalogDetail.servers.length} of{" "}
              {mcpCatalogDetail.serverCount} servers.
            </p>
          )}
        </section>
      )}

      {/*
        Stated rather than left implicit. Anchorage could add a server to a profile in one
        call, and deliberately does not: the consequence of a mis-click is an agent with
        access to somebody's document store, which is not a thing to discover afterwards.
      */}
      <footer className="tools-footer">
        <p>
          Anchorage browses and discloses; it does not enable. Adding a server to a
          profile is <code>docker mcp profile server add</code> — one command, and a
          decision worth making deliberately.
        </p>
      </footer>
    </section>
  );
}
