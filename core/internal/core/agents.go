package core

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

/*
Docker Agent, read through `docker agent`.

Docker publishes a Linux plugin binary for every release of docker/docker-agent (formerly
cagent), and Anchorage can now install it, so this destination is reachable rather than
theoretical. What it is *not* is a chat window. `docker agent run` is an interactive terminal
application, and reimplementing it here would mean building a chat client and claiming parity
with a TUI that changes weekly. The screen answers the question a GUI is actually good at:
whether this machine is set up to run an agent at all, and with what.

Three reads, and unusually for this codebase all three are JSON:

  - `models --format json` — the models the agent can reach right now.
  - `toolsets --format json` — the tool types an agent configuration can grant.
  - `doctor --json` — which provider credentials are present, and where the config lives.

Two things about the environment are load-bearing and are recorded on the result rather than
hidden, because both would otherwise produce a confidently wrong screen:

 1. **Credentials are read from environment variables**, so what `doctor` reports depends on the
    environment *Anchorage* was launched with, not on the operator's shell profile. Started from
    a desktop launcher, a key exported in `.bashrc` is invisible, and the honest answer is "not
    visible from here" rather than "not set".

 2. **The CLI phones home by default.** Docker Agent collects anonymous usage data unless
    `TELEMETRY_ENABLED=false`. Opening a screen is not consent to that, so every invocation
    below sets it — the same reasoning that keeps the Models search behind a button.
*/

const (
	// Bounded tightly. All three are local reads of config and a provider table; the one that
	// can reach a network is `models`, which queries configured gateways.
	agentsReadTimeout = 90 * time.Second
	agentsOutputLimit = 4 * 1024 * 1024
)

/*
agentEnvironment is applied to every `docker agent` invocation Anchorage makes.

Telemetry is off because the operator did not ask for it by opening a screen. This does not
change what happens when they run `docker agent` themselves in a terminal, and the screen says
so rather than implying Anchorage has disabled it globally.
*/
func agentEnvironment() map[string]string {
	return map[string]string{"TELEMETRY_ENABLED": "false"}
}

func agentsUnavailable(stderr string) bool {
	return dockerPluginMissing(stderr)
}

func agentsPluginError(stderr string) *OpError {
	return opError("agents_unavailable",
		"The Docker Agent plugin is not installed for this Docker CLI.", nil,
		map[string]any{"stderr": stderr})
}

/*
runAgent executes one `docker agent` subcommand.

The plugin prints a welcome banner and a telemetry notice on first run, ahead of any JSON, so
callers take the payload from the first structural character rather than from the start of
stdout. That is why this returns the raw bytes and leaves slicing to `agentJSON` below.
*/
func (s *Service) runAgent(ctx context.Context, contextName string, argv []string) (commandResult, error) {
	if s.docker == nil {
		return commandResult{}, opError("docker_not_found", "Docker CLI is unavailable.", nil, nil)
	}
	full := append([]string{"agent"}, argv...)
	if err := validateCLIArgv(full, s.docker.binary, "pinned"); err != nil {
		return commandResult{}, err
	}
	return s.docker.run(ctx, withContext(contextName, full...), s.defaultCWD, agentEnvironment(), agentsOutputLimit)
}

/*
agentJSON finds the JSON in output that may be preceded by a banner.

`opener` is '[' or '{'. Taking the first occurrence is safe because everything before it is the
plugin's own preamble, which contains neither: the banner is prose and a URL.
*/
func agentJSON(stdout string, opener byte) string {
	payload := strings.TrimSpace(stdout)
	if index := strings.IndexByte(payload, opener); index > 0 {
		return payload[index:]
	}
	return payload
}

type agentModelEntry struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Default  bool   `json:"default"`
}

type agentToolsetEntry struct {
	Type    string `json:"type"`
	Summary string `json:"summary"`
	Docs    string `json:"docs"`
}

type agentDoctorReport struct {
	UserConfig struct {
		Path   string `json:"path"`
		Status string `json:"status"`
	} `json:"user_config"`
	Providers []struct {
		Provider string   `json:"provider"`
		EnvVars  []string `json:"env_vars"`
		Found    bool     `json:"found"`
	} `json:"providers"`
}

func (s *Service) agentsList(parent context.Context, params AgentsListParams) (AgentsListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return AgentsListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, agentsReadTimeout)
	defer cancel()

	result := AgentsListResult{
		ProtocolVersion:   ProtocolVersion,
		Context:           contextName,
		Models:            []AgentModel{},
		Toolsets:          []AgentToolset{},
		Providers:         []AgentProvider{},
		TelemetryDisabled: true,
		ObservedAt:        time.Now().UTC().Format(time.RFC3339Nano),
	}

	// Models is the read that decides whether the plugin is there at all, so its failure is
	// the one that becomes the screen's verdict. The other two are additive.
	models, err := s.runAgent(ctx, contextName, []string{"models", "--format", "json"})
	if err != nil {
		return AgentsListResult{}, err
	}
	if models.exitCode != 0 {
		stderr := strings.TrimSpace(string(models.stderr))
		if agentsUnavailable(stderr) {
			return AgentsListResult{}, agentsPluginError(stderr)
		}
		return AgentsListResult{}, opError("agents_list_failed",
			"Docker CLI could not list the models available to Docker Agent.", nil,
			map[string]any{"exitCode": models.exitCode, "stderr": stderr})
	}
	var modelEntries []agentModelEntry
	if payload := agentJSON(string(models.stdout), '['); payload != "" {
		if err := json.Unmarshal([]byte(payload), &modelEntries); err != nil {
			return AgentsListResult{}, opError("agents_list_unreadable",
				"Docker Agent returned a model list this build could not parse.", err, nil)
		}
	}
	for _, entry := range modelEntries {
		result.Models = append(result.Models, AgentModel{
			Provider: entry.Provider,
			Model:    entry.Model,
			Default:  entry.Default,
		})
	}

	// Toolsets and doctor are supplementary: a screen that lists the models but not the tool
	// types is diminished, not wrong, so neither is allowed to fail the whole read.
	if toolsets, err := s.runAgent(ctx, contextName, []string{"toolsets", "--format", "json"}); err == nil && toolsets.exitCode == 0 {
		var entries []agentToolsetEntry
		if payload := agentJSON(string(toolsets.stdout), '['); payload != "" {
			if json.Unmarshal([]byte(payload), &entries) == nil {
				for _, entry := range entries {
					result.Toolsets = append(result.Toolsets, AgentToolset{
						Type: entry.Type, Summary: entry.Summary, Docs: entry.Docs,
					})
				}
			}
		}
	}

	if doctor, err := s.runAgent(ctx, contextName, []string{"doctor", "--json"}); err == nil && doctor.exitCode == 0 {
		var report agentDoctorReport
		if payload := agentJSON(string(doctor.stdout), '{'); payload != "" {
			if json.Unmarshal([]byte(payload), &report) == nil {
				result.ConfigPath = report.UserConfig.Path
				result.ConfigStatus = report.UserConfig.Status
				for _, provider := range report.Providers {
					result.Providers = append(result.Providers, AgentProvider{
						Provider:    provider.Provider,
						Credentials: provider.EnvVars,
						Configured:  provider.Found,
					})
				}
			}
		}
	}

	return result, nil
}
