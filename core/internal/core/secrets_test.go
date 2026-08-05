package core

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestSecretsListProjectsReferencesAndNeverAValue(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	result, err := service.secretsList(context.Background(), SecretsListParams{Context: "default"})
	if err != nil {
		t.Fatalf("secrets list: %v", err)
	}
	if !result.Swarm.Manager || result.Swarm.NodeState != "active" {
		t.Fatalf("a served list is proof of a manager: %#v", result.Swarm)
	}
	if result.Source != "engine-api" || len(result.Secrets) != 2 {
		t.Fatalf("unexpected result: %#v", result)
	}
	// Sorted by name, so the list does not reorder itself between refreshes.
	if result.Secrets[0].Name != "db-password" || result.Secrets[1].Name != "registry-token" {
		t.Fatalf("secrets were not sorted by name: %#v", result.Secrets)
	}
	token := result.Secrets[1]
	if token.ID != "aaaaaaaaaaaasecret1" || token.Version != 11 ||
		token.CreatedAt != "2026-01-01T00:00:00Z" || token.UpdatedAt != "2026-01-02T00:00:00Z" {
		t.Fatalf("metadata was not projected: %#v", token)
	}
	if token.Labels["app"] != "fixture" {
		t.Fatalf("labels were not projected: %#v", token.Labels)
	}
	// An external driver means the value never entered Swarm's own store, which changes
	// where an operator has to look for it.
	if result.Secrets[0].Driver != "vault" {
		t.Fatalf("secret driver was not projected: %#v", result.Secrets[0])
	}

	// The load-bearing guarantee of the whole surface. The fixture engine hands back a
	// Spec.Data the real Engine never sends; nothing may carry it across the boundary.
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	// The blob itself, and any field that could ever carry one. ("metadata" appears in the
	// limitation text, so the key form is matched rather than the bare word.)
	for _, forbidden := range []string{"c3VwZXItc2VjcmV0", `"data":`, `"Data":`, `"spec"`, `"Spec"`} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("a secret value reached the protocol boundary via %q: %s", forbidden, encoded)
		}
	}

	// Stated on every result, because it is a property of Docker rather than of this host.
	if len(result.Limitations) == 0 || !strings.Contains(result.Limitations[0], "never returns") {
		t.Fatalf("the result must say Docker does not return values: %#v", result.Limitations)
	}
}

func TestSecretsListReportsANonManagerAsAStateNotAnError(t *testing.T) {
	// The ordinary Linux desktop engine. Docker answers 503 on every Swarm endpoint here,
	// and an operator must be able to tell that apart from a manager holding no secrets.
	socketPath, closeServer := startCustomDomainEngine(t, http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			switch request.URL.Path {
			case "/version":
				_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
			case "/v1.55/secrets":
				writer.WriteHeader(http.StatusServiceUnavailable)
				_, _ = writer.Write([]byte(`{"message":"This node is not a swarm manager. Use \"docker swarm init\" or \"docker swarm join\" to connect this node to swarm and try again."}`))
			case "/v1.55/info":
				_, _ = writer.Write([]byte(`{"Swarm":{"LocalNodeState":"inactive"}}`))
			default:
				writer.WriteHeader(http.StatusNotFound)
			}
		}))
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	defer service.closeEngineClients()

	result, err := service.secretsList(context.Background(), SecretsListParams{Context: "default"})
	if err != nil {
		t.Fatalf("a non-manager engine is a state, not a failure: %v", err)
	}
	if result.Swarm.Manager {
		t.Fatalf("a refused endpoint must never read as a manager: %#v", result.Swarm)
	}
	// A worker and an unswarmed engine refuse identically but are fixed differently, so the
	// node state is fetched rather than guessed.
	if result.Swarm.NodeState != "inactive" {
		t.Fatalf("the node state must come from the engine: %#v", result.Swarm)
	}
	if !strings.Contains(result.Swarm.Reason, "not a swarm manager") {
		t.Fatalf("the refusal must be reported in the daemon's own words: %q", result.Swarm.Reason)
	}
	if result.Secrets == nil || len(result.Secrets) != 0 {
		t.Fatalf("an unavailable surface must be an empty list, never nil: %#v", result.Secrets)
	}
}

func TestSecretsListStillFailsLoudlyOnARealEngineError(t *testing.T) {
	// 503 is the only status that means "no secret store here". Everything else is a fault
	// and must not be dressed up as an absent capability.
	socketPath, closeServer := startCustomDomainEngine(t, http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			switch request.URL.Path {
			case "/version":
				_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
			case "/v1.55/secrets":
				writer.WriteHeader(http.StatusInternalServerError)
				_, _ = writer.Write([]byte(`{"message":"raft store unavailable"}`))
			default:
				writer.WriteHeader(http.StatusNotFound)
			}
		}))
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	defer service.closeEngineClients()

	_, err := service.secretsList(context.Background(), SecretsListParams{Context: "default"})
	if got := AsOpError(err).Code; got != "secrets_list_failed" {
		t.Fatalf("expected a reported failure, got %q (%v)", got, err)
	}
}

func TestSecretsListFallsBackToCLIJSONOnARemoteContext(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	result, err := service.secretsList(context.Background(), SecretsListParams{Context: "remote"})
	if err != nil {
		t.Fatalf("remote secrets list: %v", err)
	}
	if result.Source != "cli-json" || len(result.Secrets) != 1 {
		t.Fatalf("unexpected remote result: %#v", result)
	}
	row := result.Secrets[0]
	if row.Name != "remote-token" || row.ID != "ccccccccccccsecret3" {
		t.Fatalf("remote row was not projected: %#v", row)
	}
	// The CLI formats times relative to now and joins labels into one string, so those
	// arrive as display text and the exact fields stay empty rather than being invented.
	if row.CreatedDisplay != "2 hours ago" || row.CreatedAt != "" || row.Version != 0 {
		t.Fatalf("CLI display values must not be passed off as exact ones: %#v", row)
	}
	if row.LabelsText != "app=fixture" || len(row.Labels) != 0 {
		t.Fatalf("CLI labels are text, not a structured map: %#v", row)
	}
	if len(result.Limitations) != 2 {
		t.Fatalf("the CLI transport must state its own limitation too: %#v", result.Limitations)
	}
}

func TestNotASwarmManagerMatchesTheDaemonRefusal(t *testing.T) {
	// This decides whether the screen says "no secrets" or "no secret store", so the exact
	// wording the daemon uses is pinned rather than assumed.
	for _, refusal := range []string{
		`Error response from daemon: This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again.`,
		"error during connect: this node is not part of a swarm",
	} {
		if !notASwarmManager(refusal) {
			t.Fatalf("%q must be read as an absent Swarm surface", refusal)
		}
	}
	for _, failure := range []string{
		"", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
		"permission denied while trying to connect to the Docker daemon socket",
	} {
		if notASwarmManager(failure) {
			t.Fatalf("%q is a failure, not an absent Swarm surface", failure)
		}
	}
}
