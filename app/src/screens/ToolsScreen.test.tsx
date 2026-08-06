// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolsScreen } from "./ToolsScreen";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { MCPCatalogResult, MCPListResult, MCPServer } from "../types";

afterEach(cleanup);

// Shaped from a real `mcp.catalog` against mcp-gateway v0.43.3, reading a catalogue built from
// Docker's own published legacy catalogue.
const ALFRESCO: MCPServer = {
  name: "alfresco",
  title: "Alfresco",
  description: "A minimal MCP server for Alfresco providing tools via the REST API.",
  image: "angelborroy/alfresco-mcp-server@sha256:00fa",
  category: "productivity",
  tags: ["alfresco", "document-management"],
  license: "Apache License 2.0",
  owner: "AlfrescoLabs",
  githubStars: 6,
  tools: [
    { name: "search_nodes" },
    { name: "delete_node", description: "Remove a node" },
  ],
  toolCount: 10,
  secrets: ["ALFRESCO_HOST"],
};

const LIST: MCPListResult = {
  protocolVersion: "1",
  context: "default",
  catalogs: [
    { reference: "local/probe:v1", digest: "fbd2d2ec", title: "Probe" },
  ],
  profiles: [],
  observedAt: "2026-08-06T12:00:00.000Z",
};

const DETAIL: MCPCatalogResult = {
  protocolVersion: "1",
  context: "default",
  reference: "local/probe:v1",
  source: "legacy-catalog:docker-mcp",
  title: "Probe",
  digest: "fbd2d2ec",
  servers: [ALFRESCO],
  serverCount: 52,
  observedAt: "2026-08-06T12:00:00.000Z",
};

function createStore(overrides: Partial<AnchorageStore> = {}): AnchorageStore {
  return {
    isHost: true,
    mcpReport: LIST,
    mcpCatalogDetail: null,
    mcpStatus: "ready",
    mcpError: null,
    mcpCatalogLoading: null,
    refreshMcp: vi.fn(async () => undefined),
    openMcpCatalog: vi.fn(async () => undefined),
    closeMcpCatalog: vi.fn(),
    openCommandCenter: vi.fn(),
    ...overrides,
  } as unknown as AnchorageStore;
}

describe("ToolsScreen", () => {
  it("lists catalogues on arrival but does not open one", () => {
    // Opening a catalogue can pull an OCI artifact and returns a few hundred kilobytes. Nobody
    // should pay that just for arriving at the screen.
    const store = createStore();
    render(<ToolsScreen store={store} />);
    expect(store.refreshMcp).toHaveBeenCalled();
    expect(store.openMcpCatalog).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-catalogs")).toHaveTextContent("local/probe:v1");
  });

  it("opens a catalogue only when asked", () => {
    const store = createStore();
    render(<ToolsScreen store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(store.openMcpCatalog).toHaveBeenCalledWith("local/probe:v1");
  });

  it("keeps the catalogue's real size when the server list is capped", () => {
    render(<ToolsScreen store={createStore({ mcpCatalogDetail: DETAIL })} />);
    // One server rendered, 52 in the catalogue. Showing "1 server" would understate it.
    expect(screen.getByTestId("mcp-catalog-detail")).toHaveTextContent("52 servers");
  });

  it("puts the two disclosures on the closed row, not behind the click", () => {
    // The counts are what should make someone open the card. A row that said only "Alfresco"
    // gives no reason to look, which is how a server with ten tools gets enabled unread.
    render(<ToolsScreen store={createStore({ mcpCatalogDetail: DETAIL })} />);
    const row = screen.getByTestId("mcp-server-alfresco");
    expect(row).toHaveTextContent("10 tools");
    expect(row).toHaveTextContent("1 secret");
  });

  it("names every tool and every credential once opened", () => {
    render(<ToolsScreen store={createStore({ mcpCatalogDetail: DETAIL })} />);
    const row = screen.getByTestId("mcp-server-alfresco");
    // Collapsed to begin with: 52 servers times ten tools is 520 rows nobody is reading.
    expect(screen.queryByTestId("mcp-tools-alfresco")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { expanded: false }));
    expect(screen.getByTestId("mcp-tools-alfresco")).toHaveTextContent("delete_node");
    // The credential the container will be handed, named as such.
    const secrets = screen.getByTestId("mcp-secrets-alfresco");
    expect(secrets).toHaveTextContent("ALFRESCO_HOST");
    expect(secrets).toHaveTextContent(/credential handed to a container/u);
  });

  it("says it does not enable anything, and what does", () => {
    // Anchorage could add a server to a profile in one call and deliberately does not. Saying
    // so is the difference between a considered omission and a missing feature.
    render(<ToolsScreen store={createStore()} />);
    expect(screen.getByText(/does not enable/u)).toBeInTheDocument();
    expect(screen.getByText(/docker mcp profile server add/u)).toBeInTheDocument();
  });

  it("treats no catalogues as a normal state with a way forward", () => {
    render(
      <ToolsScreen
        store={createStore({ mcpReport: { ...LIST, catalogs: [] } })}
      />,
    );
    expect(screen.getByTestId("mcp-no-catalogs")).toHaveTextContent(
      "docker mcp catalog create",
    );
  });

  it("falls back to the install surface when the plugin is absent", () => {
    render(
      <ToolsScreen
        store={createStore({
          mcpStatus: "unavailable",
          mcpReport: null,
          pluginReport: null,
        })}
      />,
    );
    expect(screen.getByTestId("tools-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-catalogs")).toBeNull();
  });

  it("states what containerising a tool server does not buy", () => {
    render(<ToolsScreen store={createStore()} />);
    expect(screen.getByTestId("tools-screen-posture")).toHaveTextContent(
      /does not reduce the authority/u,
    );
  });
});
