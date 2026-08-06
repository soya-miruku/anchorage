package core

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
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

/*
Creating and removing a Swarm secret.

Read-only was the honest state until now — Docker exposes both verbs and Anchorage did not — but
a secret is the one resource where the *value* has to cross the RPC boundary, so how it travels
matters more than that it travels at all.

It goes over the Engine API, not the CLI. `docker secret create NAME -` would work, but it means
either putting the value in argv, where it is world-readable in /proc for the life of the process
and lands in this codebase's own command receipts, or teaching the CLI runner to write stdin,
which nothing else needs. `POST /secrets/create` takes the value base64-encoded in a JSON body
that is never logged and never echoed. There is no CLI fallback for the same reason: falling back
would silently downgrade to the argv route on exactly the engines where the operator cannot see
that it happened.

The value is never returned, never included in a receipt, and never written to an error detail.
Docker does not return it either — `GET /secrets` gives metadata only — so a created secret is
write-once from Anchorage's point of view, which is the property the operator should expect.
*/

const maxSecretBytes = 500 * 1024 // Docker's own documented ceiling for a secret payload.

func (s *Service) secretsAction(parent context.Context, params SecretsActionParams) (SecretsActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return SecretsActionResult{}, err
	}
	name := strings.TrimSpace(params.Name)

	switch params.Action {
	case "create":
		// Docker's own constraint: 64 characters, alphanumerics plus dot, dash and underscore.
		if name == "" || len(name) > 64 || !secretNamePattern.MatchString(name) {
			return SecretsActionResult{}, opError("invalid_secret_name",
				"A secret name must be 1-64 characters of letters, digits, dot, dash or underscore.",
				nil, map[string]any{"name": name})
		}
		if len(params.Value) == 0 {
			return SecretsActionResult{}, opError("secret_value_required",
				"A secret needs a value.", nil, nil)
		}
		if len(params.Value) > maxSecretBytes {
			return SecretsActionResult{}, opError("secret_too_large",
				"A secret value must be 500 KB or smaller.", nil,
				map[string]any{"limit": maxSecretBytes})
		}
	case "remove":
		if params.ID == "" {
			return SecretsActionResult{}, opError("secret_id_required",
				"Removing a secret needs its immutable ID.", nil, nil)
		}
		if !params.Confirmed {
			return SecretsActionResult{}, opError("confirmation_required",
				"Removing a secret is irreversible and its value cannot be read back, so it must be confirmed.",
				nil, map[string]any{"id": params.ID})
		}
	default:
		return SecretsActionResult{}, opError("invalid_action",
			"A secret action must be create or remove.", nil,
			map[string]any{"action": params.Action})
	}

	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		return SecretsActionResult{}, secretsTransportRefusal(err)
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		return SecretsActionResult{}, secretsTransportRefusal(err)
	}

	started := time.Now().UTC()
	receipt := DomainOperationReceipt{
		Context: contextName, Domain: "secret", Action: params.Action,
		Source: "engine-api", Outcome: "failed", StartedAt: started.Format(time.RFC3339Nano),
		EndpointHash: endpoint.endpointHash,
	}
	// The name identifies a create; the ID identifies a remove. Neither is the value, so both
	// are safe to record.
	if params.Action == "create" {
		receipt.ResourceID = name
	} else {
		receipt.ResourceID = params.ID
	}

	var status int
	var body []byte
	if params.Action == "create" {
		payload, marshalErr := json.Marshal(map[string]any{
			"Name": name,
			"Data": base64.StdEncoding.EncodeToString(params.Value),
			"Labels": map[string]string{
				// Recorded so an operator can tell later which secrets this app created; it
				// carries no value and nothing depends on reading it back.
				"com.anchorage.created-by": "anchorage",
			},
		})
		if marshalErr != nil {
			return SecretsActionResult{}, opError("secret_encode_failed",
				"The secret could not be encoded for the engine.", marshalErr, nil)
		}
		status, body, err = client.request(ctx, http.MethodPost,
			"/v"+client.apiVersion+"/secrets/create", bytes.NewReader(payload))
	} else {
		status, body, err = client.request(ctx, http.MethodDelete,
			"/v"+client.apiVersion+"/secrets/"+url.PathEscape(params.ID), nil)
	}
	if err != nil {
		return SecretsActionResult{}, err
	}

	completed := time.Now().UTC()
	receipt.HTTPStatus = status
	receipt.CompletedAt = completed.Format(time.RFC3339Nano)
	receipt.DurationMs = completed.Sub(started).Milliseconds()

	if status == http.StatusServiceUnavailable {
		return SecretsActionResult{}, opError("swarm_unavailable",
			"This engine has no Swarm secret store, so secrets cannot be created or removed here.",
			nil, map[string]any{"httpStatus": status})
	}
	if status < 200 || status >= 300 {
		// The body may name the secret but never carries its value, so it is safe to surface.
		return SecretsActionResult{}, engineHTTPError("secret_action_failed",
			"The engine refused the secret action.", status, body)
	}

	result := SecretsActionResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Action:          params.Action,
		ObservedAt:      completed.Format(time.RFC3339Nano),
	}
	if params.Action == "create" {
		var created struct {
			ID string `json:"ID"`
		}
		// The engine answers with the new ID. A body it cannot parse is not a failure — the
		// secret exists either way, and the caller re-reads the list.
		_ = json.Unmarshal(body, &created)
		result.ID = created.ID
		result.Name = name
		receipt.ResourceID = created.ID
	} else {
		result.ID = params.ID
	}
	receipt.Outcome = "succeeded"
	result.Receipt = receipt
	return result, nil
}

// secretsTransportRefusal keeps the one honest message for an engine this verb cannot reach.
// Unlike the list, there is deliberately no CLI fallback: see the note above.
func secretsTransportRefusal(err error) error {
	if errors.Is(err, errTransportUnsupported) {
		return opError("native_transport_required",
			"Creating or removing a secret needs the Engine API over a local socket, so the value never becomes a command argument.",
			nil, nil)
	}
	return err
}

var secretNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
