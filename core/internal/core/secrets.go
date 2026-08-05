package core

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
)

// Swarm secrets are the only secret store Docker's own API exposes, and it exposes them as
// references. `GET /secrets` returns an id, a name and metadata; it never returns Spec.Data,
// because the daemon discards the plaintext once the secret exists. There is no API call and
// no CLI command that reads a value back — only the containers a secret is granted to ever
// see it. So there is no inspect-value path here, and there is nothing to add one to: every
// projection below is metadata by construction.
//
// The endpoint answers 503 on a node that is not a Swarm manager, which is the ordinary state
// of a Linux desktop engine. That is reported as a state on a successful result rather than
// raised as an error: "this manager holds no secrets" and "there is no secret store here"
// are different facts, and collapsing them into one empty list would misdescribe the engine.
//
// Docker Pass — the `se://` resolver — is a separate product with a separate store, and none
// of this reaches it. Listing Swarm secrets says nothing about whether `se://` resolves.

const (
	// Stated on every result, in both transports and in both Swarm states, because it is a
	// property of Docker rather than of this host or this transport.
	secretValueLimitation = "Docker never returns a secret's value after it is created. " +
		"These are references and metadata only; the plaintext is readable solely by the containers it is granted to."
	secretCLILimitation = "Remote CLI JSON reports creation and update times relative to now and labels as one string; " +
		"exact timestamps, the Swarm version index and structured labels are unavailable."
)

// engineSecret deliberately does not declare Spec.Data. The Engine omits it, and a field for
// it would be an invitation to populate one.
type engineSecret struct {
	ID      string `json:"ID"`
	Version struct {
		Index uint64 `json:"Index"`
	} `json:"Version"`
	CreatedAt string `json:"CreatedAt"`
	UpdatedAt string `json:"UpdatedAt"`
	Spec      struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
		Driver *struct {
			Name string `json:"Name"`
		} `json:"Driver"`
	} `json:"Spec"`
}

func projectSecret(raw engineSecret) SecretSummary {
	summary := SecretSummary{
		ID: raw.ID, Name: raw.Spec.Name, CreatedAt: raw.CreatedAt, UpdatedAt: raw.UpdatedAt,
		Version: raw.Version.Index, Labels: nonNilMap(raw.Spec.Labels),
	}
	// An external driver means the value never entered Swarm's own store at all, which
	// changes where an operator has to look; the built-in store reports no driver.
	if raw.Spec.Driver != nil {
		summary.Driver = raw.Spec.Driver.Name
	}
	return summary
}

func sortSecrets(secrets []SecretSummary) {
	sort.Slice(secrets, func(i, j int) bool { return secrets[i].Name < secrets[j].Name })
}

// notASwarmManager matches the daemon's refusal as the CLI relays it. Docker's wording is
// "This node is not a swarm manager." for both an unswarmed engine and a worker.
func notASwarmManager(stderr string) bool {
	lowered := strings.ToLower(stderr)
	return strings.Contains(lowered, "not a swarm manager") ||
		strings.Contains(lowered, "not part of a swarm")
}

func (s *Service) secretsList(parent context.Context, params SecretsListParams) (SecretsListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return SecretsListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.secretsListCLI(ctx, contextName)
		}
		return SecretsListResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.secretsListCLI(ctx, contextName)
		}
		return SecretsListResult{}, err
	}
	status, body, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/secrets", nil)
	if err != nil {
		return SecretsListResult{}, err
	}
	if status == http.StatusServiceUnavailable {
		// The common case, not a failure: this engine has no secret store to list.
		return SecretsListResult{
			Context: contextName, Source: "engine-api", APIVersion: client.apiVersion,
			Swarm: s.swarmRefusal(ctx, client, body), Secrets: []SecretSummary{},
			ObservedAt: nowUTC(), EndpointHash: endpoint.endpointHash,
			Limitations: []string{secretValueLimitation},
		}, nil
	}
	if status < 200 || status >= 300 {
		return SecretsListResult{}, engineHTTPError("secrets_list_failed",
			"Docker Engine rejected the secret list request.", status, body)
	}
	var raw []engineSecret
	if err := json.Unmarshal(body, &raw); err != nil {
		return SecretsListResult{}, opError("secrets_list_invalid",
			"Docker Engine returned invalid secret JSON.", err, map[string]any{
				"context": contextName,
			})
	}
	secrets := make([]SecretSummary, 0, len(raw))
	for _, item := range raw {
		secrets = append(secrets, projectSecret(item))
	}
	sortSecrets(secrets)
	return SecretsListResult{
		Context: contextName, Source: "engine-api", APIVersion: client.apiVersion,
		// The answer is its own evidence: Docker serves /secrets only from an active manager,
		// so no second /info round trip is spent confirming what a 200 already establishes.
		Swarm:      SwarmSurface{Manager: true, NodeState: "active"},
		Secrets:    secrets,
		ObservedAt: nowUTC(), EndpointHash: endpoint.endpointHash,
		Limitations: []string{secretValueLimitation},
	}, nil
}

// swarmRefusal describes a 503 in the engine's own terms.
//
// A worker node and an engine that was never swarmed both refuse identically, but the fixes
// differ — `docker swarm init` against one, "ask the manager" against the other — so
// LocalNodeState is fetched to tell them apart. Only on this path: the cost is paid where
// the answer is otherwise ambiguous, never on the successful one.
func (s *Service) swarmRefusal(ctx context.Context, client *engineClient, body []byte) SwarmSurface {
	// Manager stays false whatever /info reports. The endpoint refused, and that observation
	// outranks a claim made about it elsewhere.
	surface := SwarmSurface{Manager: false, NodeState: "unknown", Reason: engineMessageFrom(body)}
	status, info, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/info", nil)
	if err != nil || status < 200 || status >= 300 {
		return surface
	}
	var raw struct {
		Swarm struct {
			LocalNodeState string `json:"LocalNodeState"`
		} `json:"Swarm"`
	}
	if json.Unmarshal(info, &raw) == nil && raw.Swarm.LocalNodeState != "" {
		surface.NodeState = raw.Swarm.LocalNodeState
	}
	return surface
}

func (s *Service) secretsListCLI(ctx context.Context, contextName string) (SecretsListResult, error) {
	args := withContext(contextName, "secret", "ls", "--format", "{{json .}}")
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
	if err != nil {
		return SecretsListResult{}, err
	}
	if result.timedOut {
		return SecretsListResult{}, opError("secrets_list_timeout",
			"Docker CLI secret listing timed out.", context.DeadlineExceeded,
			map[string]any{"context": contextName})
	}
	if result.exitCode != 0 {
		stderr := strings.TrimSpace(string(result.stderr))
		if notASwarmManager(stderr) {
			// Same reading as the Engine's 503: the surface is absent, the request is not
			// broken. The CLI has no `docker info` field to hand here without a second
			// process, so the node state stays honestly unknown.
			return SecretsListResult{
				Context: contextName, Source: "cli-json",
				Swarm:   SwarmSurface{Manager: false, NodeState: "unknown", Reason: stderr},
				Secrets: []SecretSummary{}, ObservedAt: nowUTC(),
				Limitations: []string{secretValueLimitation, secretCLILimitation},
			}, nil
		}
		return SecretsListResult{}, opError("secrets_list_failed",
			"Docker CLI rejected the secret list request.", nil, map[string]any{
				"context": contextName, "exitCode": result.exitCode, "stderr": stderr,
			})
	}
	secrets := []SecretSummary{}
	for lineNumber, line := range splitJSONLines(result.stdout) {
		var row struct {
			ID        string `json:"ID"`
			Name      string `json:"Name"`
			Driver    string `json:"Driver"`
			CreatedAt string `json:"CreatedAt"`
			UpdatedAt string `json:"UpdatedAt"`
			Labels    string `json:"Labels"`
		}
		if err := json.Unmarshal(line, &row); err != nil {
			return SecretsListResult{}, opError("secrets_list_invalid",
				"Docker CLI returned an invalid secret row.", err, map[string]any{
					"context": contextName, "line": lineNumber + 1,
				})
		}
		secrets = append(secrets, SecretSummary{
			ID: row.ID, Name: row.Name, Driver: row.Driver, Labels: map[string]string{},
			CreatedDisplay: row.CreatedAt, UpdatedDisplay: row.UpdatedAt, LabelsText: row.Labels,
		})
	}
	sortSecrets(secrets)
	return SecretsListResult{
		Context: contextName, Source: "cli-json",
		// A row came back, so the CLI reached a manager.
		Swarm:   SwarmSurface{Manager: true, NodeState: "active"},
		Secrets: secrets, ObservedAt: nowUTC(),
		Limitations: []string{secretValueLimitation, secretCLILimitation},
	}, nil
}
