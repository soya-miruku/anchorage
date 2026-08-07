package core

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

/*
The MCP Toolkit, read through `docker mcp`.

An MCP server is a container that grants an AI agent a set of tools. Browsing what is on offer,
and seeing what each one would be allowed to do before enabling it, is the part of the Toolkit a
GUI is unambiguously better at than a terminal — a catalogue of 52 servers with per-server tool
lists and environment requirements is a scrolling problem, not a reading problem.

Getting a machine-readable surface out of this plugin took some finding, and the shape of this
file is the result:

  - `catalog list` has no JSON. It prints a three-column table whose data rows are separated by
    a tab-pipe and whose header is separated by a space-pipe, which is why the parser below
    splits on the pipe and trims rather than trusting either.
  - `catalog show --format json` *does* emit JSON, though the command's own usage line does not
    mention the flag. That is where everything worth showing lives.
  - `profile list` has no JSON either, and prints prose when empty.

Everything here was verified against docker/mcp-gateway v0.43.3 with a real catalogue built from
Docker's own published legacy catalogue, rather than against invented output. That mattered:
none of these formats are documented, and two of the three would have been guessed wrong.
*/

const (
	// Catalog reads can pull an OCI artifact, and `show` on a large catalogue is a few hundred
	// kilobytes of JSON to render.
	mcpReadTimeout = 3 * time.Minute
	mcpOutputLimit = 16 * 1024 * 1024
	// One catalogue here carries 52 servers, each with a tool list. The cap exists so a
	// hostile or enormous catalogue cannot produce a response the transport must reject; the
	// count before truncation is always reported.
	maxMCPServers = 400
	maxMCPTools   = 100
)

func mcpUnavailable(stderr string) bool {
	return dockerPluginMissing(stderr)
}

func mcpPluginError(stderr string) *OpError {
	return opError("mcp_unavailable",
		"The Docker MCP plugin is not installed for this Docker CLI.", nil,
		map[string]any{"stderr": stderr})
}

func (s *Service) runMCP(ctx context.Context, contextName string, argv []string) (commandResult, error) {
	if s.docker == nil {
		return commandResult{}, opError("docker_not_found", "Docker CLI is unavailable.", nil, nil)
	}
	full := append([]string{"mcp"}, argv...)
	if err := validateCLIArgv(full, s.docker.binary, "pinned"); err != nil {
		return commandResult{}, err
	}
	return s.docker.run(ctx, withContext(contextName, full...), s.defaultCWD, nil, mcpOutputLimit)
}

/*
parseMCPTable reads one of the plugin's pipe-separated tables.

Captured from `docker mcp catalog list`, with `cat -A` so the whitespace is not guesswork:

	Reference | Digest | Title$
	local/probe:v1^I| fbd2d2ec…^I| Probe$

The header uses a space before the pipe and the data rows use a tab, so the split is on the
pipe alone and every cell is trimmed. Rows whose first cell matches the header are dropped, and
so is the plugin's prose when a list is empty — "No catalogs found. Use `docker mcp …`" has no
pipe in it and produces no cells.
*/
func parseMCPTable(stdout string, header string) [][]string {
	rows := [][]string{}
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || !strings.Contains(trimmed, "|") {
			continue
		}
		cells := []string{}
		for _, cell := range strings.Split(trimmed, "|") {
			cells = append(cells, strings.TrimSpace(cell))
		}
		if len(cells) == 0 || cells[0] == "" {
			continue
		}
		if strings.EqualFold(cells[0], header) {
			continue
		}
		rows = append(rows, cells)
	}
	return rows
}

// mcpCatalogDocument is `catalog show --format json`. The flag is real but undocumented in the
// command's own usage line, which is why the shape below is bound to captured output.
type mcpCatalogDocument struct {
	Ref     string `json:"ref"`
	Source  string `json:"source"`
	Title   string `json:"title"`
	Digest  string `json:"digest"`
	Servers []struct {
		Type     string `json:"type"`
		Image    string `json:"image"`
		Snapshot struct {
			Server struct {
				Name        string `json:"name"`
				Title       string `json:"title"`
				Description string `json:"description"`
				Image       string `json:"image"`
				Env         []struct {
					Name  string `json:"name"`
					Value string `json:"value"`
				} `json:"env"`
				Tools []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
				} `json:"tools"`
				Metadata struct {
					Category    string   `json:"category"`
					Tags        []string `json:"tags"`
					License     string   `json:"license"`
					Owner       string   `json:"owner"`
					GithubStars int      `json:"githubStars"`
				} `json:"metadata"`
			} `json:"server"`
		} `json:"snapshot"`
	} `json:"servers"`
}

func (s *Service) mcpList(parent context.Context, params MCPListParams) (MCPListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return MCPListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, mcpReadTimeout)
	defer cancel()

	catalogs, err := s.runMCP(ctx, contextName, []string{"catalog", "list"})
	if err != nil {
		return MCPListResult{}, err
	}
	if catalogs.exitCode != 0 {
		stderr := strings.TrimSpace(string(catalogs.stderr))
		if mcpUnavailable(stderr) {
			return MCPListResult{}, mcpPluginError(stderr)
		}
		return MCPListResult{}, opError("mcp_list_failed",
			"Docker CLI could not list MCP catalogs.", nil,
			map[string]any{"exitCode": catalogs.exitCode, "stderr": stderr})
	}

	result := MCPListResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Catalogs:        []MCPCatalog{},
		Profiles:        []MCPProfile{},
		ObservedAt:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	for _, row := range parseMCPTable(string(catalogs.stdout), "Reference") {
		catalog := MCPCatalog{Reference: row[0]}
		if len(row) > 1 {
			catalog.Digest = row[1]
		}
		if len(row) > 2 {
			catalog.Title = row[2]
		}
		result.Catalogs = append(result.Catalogs, catalog)
	}
	sort.SliceStable(result.Catalogs, func(left, right int) bool {
		return result.Catalogs[left].Reference < result.Catalogs[right].Reference
	})

	// Profiles are supplementary — a Toolkit with catalogues and no profiles is a normal
	// state, and losing the catalogue list because the profile table changed would be wrong.
	if profiles, err := s.runMCP(ctx, contextName, []string{"profile", "list"}); err == nil && profiles.exitCode == 0 {
		for _, row := range parseMCPTable(string(profiles.stdout), "Id") {
			profile := MCPProfile{ID: row[0]}
			if len(row) > 1 {
				profile.Title = row[1]
			}
			result.Profiles = append(result.Profiles, profile)
		}
	}
	return result, nil
}

func (s *Service) mcpCatalog(parent context.Context, params MCPCatalogParams) (MCPCatalogResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return MCPCatalogResult{}, err
	}
	reference := strings.TrimSpace(params.Reference)
	if reference == "" {
		return MCPCatalogResult{}, opError("reference_required",
			"A catalog reference is required.", nil, nil)
	}
	// The reference becomes an argv element. A leading dash is what turns one into a flag.
	if strings.HasPrefix(reference, "-") || len(reference) > 512 {
		return MCPCatalogResult{}, opError("invalid_reference",
			"A catalog reference must be 512 characters or fewer and must not begin with a dash.",
			nil, nil)
	}

	ctx, cancel := context.WithTimeout(parent, mcpReadTimeout)
	defer cancel()
	shown, err := s.runMCP(ctx, contextName, []string{"catalog", "show", "--format", "json", "--", reference})
	if err != nil {
		return MCPCatalogResult{}, err
	}
	if shown.exitCode != 0 {
		stderr := strings.TrimSpace(string(shown.stderr))
		if mcpUnavailable(stderr) {
			return MCPCatalogResult{}, mcpPluginError(stderr)
		}
		return MCPCatalogResult{}, opError("mcp_catalog_failed",
			"Docker CLI could not read that MCP catalog.", nil,
			map[string]any{"exitCode": shown.exitCode, "stderr": stderr})
	}

	payload := strings.TrimSpace(string(shown.stdout))
	if index := strings.IndexByte(payload, '{'); index > 0 {
		payload = payload[index:]
	}
	var document mcpCatalogDocument
	if payload != "" {
		if err := json.Unmarshal([]byte(payload), &document); err != nil {
			return MCPCatalogResult{}, opError("mcp_catalog_unreadable",
				"Docker CLI returned a catalog this build could not parse.", err, nil)
		}
	}

	result := MCPCatalogResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Reference:       document.Ref,
		Source:          document.Source,
		Title:           document.Title,
		Digest:          document.Digest,
		ServerCount:     len(document.Servers),
		Servers:         []MCPServer{},
		ObservedAt:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	if result.Reference == "" {
		result.Reference = reference
	}
	for index, entry := range document.Servers {
		if index >= maxMCPServers {
			result.Truncated = true
			break
		}
		snapshot := entry.Snapshot.Server
		server := MCPServer{
			Name:        snapshot.Name,
			Title:       snapshot.Title,
			Description: boundScoutField(snapshot.Description),
			Image:       snapshot.Image,
			Category:    snapshot.Metadata.Category,
			Tags:        snapshot.Metadata.Tags,
			License:     snapshot.Metadata.License,
			Owner:       snapshot.Metadata.Owner,
			GithubStars: snapshot.Metadata.GithubStars,
			Tools:       []MCPTool{},
			Secrets:     []string{},
		}
		if server.Image == "" {
			server.Image = entry.Image
		}
		if server.Tags == nil {
			server.Tags = []string{}
		}
		// The tool list is the point: it is what the server would be able to do once enabled,
		// and reading it before enabling is the whole reason to have this screen.
		server.ToolCount = len(snapshot.Tools)
		for toolIndex, tool := range snapshot.Tools {
			if toolIndex >= maxMCPTools {
				server.ToolsTruncated = true
				break
			}
			server.Tools = append(server.Tools, MCPTool{
				Name:        tool.Name,
				Description: boundScoutField(tool.Description),
			})
		}
		// Environment entries are what the server will demand before it can run. Naming them
		// is a disclosure, not a convenience: "this wants your Alfresco host and credentials"
		// is the thing to know before enabling it.
		for _, env := range snapshot.Env {
			if env.Name != "" {
				server.Secrets = append(server.Secrets, env.Name)
			}
		}
		result.Servers = append(result.Servers, server)
	}
	sort.SliceStable(result.Servers, func(left, right int) bool {
		return result.Servers[left].Name < result.Servers[right].Name
	})
	return result, nil
}
