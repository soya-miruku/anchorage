package core

import (
	"encoding/json"
	"strings"
	"testing"
)

/*
`docker agent` prints a welcome banner and a telemetry notice ahead of its JSON on first run,
which is the one thing here likely to break a parser. Captured verbatim from v1.122.0.
*/
const agentFirstRunOutput = `
Welcome to docker agent! 🚀

For any feedback, please visit: https://docker.qualtrics.com/jfe/form/SV_cNsCIg92nQemlfw

We collect anonymous usage data to help improve docker agent. To disable:
  - Set environment variable: TELEMETRY_ENABLED=false

[
  {
    "provider": "dmr",
    "model": "ai/qwen3:latest",
    "default": true
  }
]
`

func TestAgentJSONSurvivesTheFirstRunBanner(t *testing.T) {
	payload := agentJSON(agentFirstRunOutput, '[')

	var entries []agentModelEntry
	if err := json.Unmarshal([]byte(payload), &entries); err != nil {
		t.Fatalf("the banner was not stripped: %v\npayload=%q", err, payload)
	}
	if len(entries) != 1 || entries[0].Provider != "dmr" || !entries[0].Default {
		t.Fatalf("parsed %+v", entries)
	}
}

func TestAgentJSONLeavesCleanOutputAlone(t *testing.T) {
	// Second and later runs print no banner, so the common case must not be mangled.
	payload := agentJSON(`[{"provider":"openai","model":"gpt-4o"}]`, '[')
	var entries []agentModelEntry
	if err := json.Unmarshal([]byte(payload), &entries); err != nil {
		t.Fatalf("clean output should parse unchanged: %v", err)
	}
	if len(entries) != 1 || entries[0].Provider != "openai" {
		t.Fatalf("parsed %+v", entries)
	}
	// An object payload uses a different opener; doctor is the caller that needs it.
	if got := agentJSON("noise\n{\"user_config\":{}}", '{'); got != `{"user_config":{}}` {
		t.Fatalf("object payload = %q", got)
	}
}

func TestAgentDoctorReportDecodesDockersOwnShape(t *testing.T) {
	// Captured from `docker agent doctor --json` on v1.122.0.
	const payload = `{
	  "user_config": {"path": "/home/operator/.config/cagent/config.yaml", "status": "ok"},
	  "providers": [
	    {"provider": "anthropic", "env_vars": ["ANTHROPIC_API_KEY"], "found": false},
	    {"provider": "github-copilot", "env_vars": ["GITHUB_TOKEN", "GH_TOKEN"], "found": true}
	  ]
	}`
	var report agentDoctorReport
	if err := json.Unmarshal([]byte(payload), &report); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if report.UserConfig.Status != "ok" {
		t.Fatalf("config status = %q", report.UserConfig.Status)
	}
	if len(report.Providers) != 2 {
		t.Fatalf("providers = %d", len(report.Providers))
	}
	// A provider with several accepted variables must keep all of them: telling an operator to
	// set GITHUB_TOKEN when they already have GH_TOKEN would be wrong in both directions.
	if got := report.Providers[1]; len(got.EnvVars) != 2 || !got.Found {
		t.Fatalf("github-copilot parsed as %+v", got)
	}
}

func TestAgentInvocationsDisableTelemetry(t *testing.T) {
	// Docker Agent phones home unless told not to. Opening a screen is not consent to that,
	// and this is the only place that decision is enforced — the screen merely reports it.
	env := agentEnvironment()
	if env["TELEMETRY_ENABLED"] != "false" {
		t.Fatalf("telemetry must be disabled for Anchorage's own calls, got %v", env)
	}
}

func TestAgentsUnavailableRecognisesAnAbsentPlugin(t *testing.T) {
	for _, stderr := range []string{
		"docker: 'agent' is not a docker command.",
		"unknown command \"agent\" for \"docker\"",
	} {
		if !agentsUnavailable(stderr) {
			t.Fatalf("should be recognised as an absent plugin: %q", stderr)
		}
	}
	// An ordinary failure must not be reported as a missing plugin, or the screen would offer
	// to install something that is already there.
	if agentsUnavailable("Error: no model provider configured") {
		t.Fatal("a configuration failure is not a missing plugin")
	}
}

func TestAgentToolsetsDecodeWithTheirDocumentationLink(t *testing.T) {
	const payload = `[{"type":"shell","summary":"Execute shell commands in the user's environment","docs":"https://docker.github.io/docker-agent/tools/shell"}]`
	var entries []agentToolsetEntry
	if err := json.Unmarshal([]byte(payload), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if entries[0].Type != "shell" || !strings.HasPrefix(entries[0].Docs, "https://") {
		t.Fatalf("parsed %+v", entries[0])
	}
}
