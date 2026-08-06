package core

import (
	"encoding/json"
	"testing"
)

/*
None of `docker mcp`'s list formats are documented, and two of the three would have been guessed
wrong. These pin them against output captured from v0.43.3 with `cat -A`, so the whitespace is
recorded rather than remembered.
*/

// Captured from `docker mcp catalog list`. The header separates on a space-pipe and the data
// row on a tab-pipe, which is the detail a parser written from a screenshot would miss.
const liveCatalogList = "Reference | Digest | Title\n" +
	"local/probe:v1\t| fbd2d2ec58d1a5890fe5c0eec2c454ef4851ccd9de5a995cabc9c14c8e9c9f57\t| Probe\n"

func TestParseMCPTableHandlesTheHeaderAndDataSeparatorsDiffering(t *testing.T) {
	rows := parseMCPTable(liveCatalogList, "Reference")

	if len(rows) != 1 {
		t.Fatalf("expected the header to be dropped and one row kept, got %d: %v", len(rows), rows)
	}
	if rows[0][0] != "local/probe:v1" {
		t.Fatalf("reference = %q", rows[0][0])
	}
	if rows[0][1] != "fbd2d2ec58d1a5890fe5c0eec2c454ef4851ccd9de5a995cabc9c14c8e9c9f57" {
		t.Fatalf("digest = %q", rows[0][1])
	}
	// The tab must not survive into the cell; it would show up in the UI as a gap.
	if rows[0][2] != "Probe" {
		t.Fatalf("title = %q", rows[0][2])
	}
}

func TestParseMCPTableIgnoresTheProseAnEmptyListPrints(t *testing.T) {
	/*
		The plugin does not print an empty table when there is nothing to list — it prints
		advice, and `profile list` prints several lines of it. None of it contains a pipe, so
		none of it produces a row. Without this the screen would show "No catalogs found. Use
		`docker mcp catalog create`" as though it were a catalogue named that.
	*/
	const empty = "No catalogs found. Use `docker mcp catalog create` or `docker mcp catalog pull <oci-reference>` to create a catalog.\n"
	if rows := parseMCPTable(empty, "Reference"); len(rows) != 0 {
		t.Fatalf("prose was read as data: %v", rows)
	}

	const profilesEmpty = `No profiles found. Use ` + "`docker mcp profile create --name <name>`" + ` to create a profile.

Tip: Get started quickly with a starter template:
  docker mcp template list       View available templates
  docker mcp template use <id>   Create a profile from a template
`
	if rows := parseMCPTable(profilesEmpty, "Id"); len(rows) != 0 {
		t.Fatalf("the empty-profile tip was read as data: %v", rows)
	}
}

func TestMCPCatalogDocumentDecodesTheUndocumentedJSON(t *testing.T) {
	/*
		`catalog show --format json` works but its own usage line does not mention the flag, so
		this shape is bound to captured output rather than to documentation. Trimmed from a real
		catalogue built out of Docker's published legacy catalogue.
	*/
	const payload = `{
	  "ref": "local/probe:v1",
	  "source": "legacy-catalog:docker-mcp",
	  "title": "Probe",
	  "digest": "fbd2d2ec",
	  "servers": [
	    {
	      "type": "image",
	      "image": "angelborroy/alfresco-mcp-server@sha256:00fa",
	      "snapshot": {
	        "server": {
	          "name": "alfresco",
	          "title": "Alfresco",
	          "description": "A minimal MCP server for Alfresco.",
	          "env": [{"name": "ALFRESCO_HOST", "value": "{{alfresco.alfresco_host}}"}],
	          "tools": [{"name": "search_nodes", "description": ""}],
	          "metadata": {
	            "githubStars": 6,
	            "category": "productivity",
	            "tags": ["alfresco", "document-management"],
	            "license": "Apache License 2.0",
	            "owner": "AlfrescoLabs"
	          }
	        }
	      }
	    }
	  ]
	}`
	var document mcpCatalogDocument
	if err := json.Unmarshal([]byte(payload), &document); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if document.Title != "Probe" || len(document.Servers) != 1 {
		t.Fatalf("document = %+v", document)
	}
	server := document.Servers[0].Snapshot.Server
	if server.Name != "alfresco" || server.Metadata.Owner != "AlfrescoLabs" {
		t.Fatalf("server = %+v", server)
	}
	// The two disclosures the screen exists to make: what it could do, and what it will demand.
	if len(server.Tools) != 1 || server.Tools[0].Name != "search_nodes" {
		t.Fatalf("tools = %+v", server.Tools)
	}
	if len(server.Env) != 1 || server.Env[0].Name != "ALFRESCO_HOST" {
		t.Fatalf("env = %+v", server.Env)
	}
	// The image lives on the snapshot for some entries and on the outer record for others, so
	// the projection falls back; here only the outer one is set.
	if document.Servers[0].Image == "" {
		t.Fatal("the outer image must be readable as a fallback")
	}
}

func TestMCPUnavailableRecognisesAnAbsentPlugin(t *testing.T) {
	for _, stderr := range []string{
		"docker: 'mcp' is not a docker command.",
		"unknown command \"mcp\" for \"docker\"",
	} {
		if !mcpUnavailable(stderr) {
			t.Fatalf("should be recognised as an absent plugin: %q", stderr)
		}
	}
	if mcpUnavailable("failed to read OCI catalog: UNAUTHORIZED") {
		t.Fatal("a registry failure is not a missing plugin")
	}
}
