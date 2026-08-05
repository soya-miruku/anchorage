package core

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

/**
 * Republishing ports destroys a container, so the ordering is the whole design.
 *
 * Docker fixes bindings at creation and `docker update` cannot change them, so the only route is
 * to create a replacement. Doing that as remove-then-create turns a rejected port — the single
 * most likely failure — into a destroyed container. The original is therefore parked under
 * another name and only removed once the replacement exists.
 */
type rebindEngine struct {
	mu       sync.Mutex
	calls    []string
	running  bool
	paused   bool
	createOK bool
	renames  []string
	// The body the replacement was created from, so the test can assert what survived.
	createBody map[string]any
}

func (e *rebindEngine) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		e.mu.Lock()
		defer e.mu.Unlock()
		path := request.URL.Path
		switch {
		case path == "/version":
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
		case strings.HasSuffix(path, "/json"):
			e.calls = append(e.calls, "inspect")
			body := map[string]any{
				"Name":  "/api",
				"State": map[string]any{"Running": e.running, "Paused": e.paused},
				"Config": map[string]any{
					"Image": "nginx:1.27",
					"Env":   []string{"KEY=value"},
					// A field no hand-written copy list would have thought of. It has to survive.
					"Healthcheck": map[string]any{"Test": []string{"CMD", "true"}},
				},
				"HostConfig": map[string]any{
					"Binds":         []string{"/srv:/data:ro"},
					"RestartPolicy": map[string]any{"Name": "unless-stopped"},
					"PortBindings":  map[string]any{"80/tcp": []map[string]string{{"HostPort": "8080"}}},
				},
			}
			encoded, _ := json.Marshal(body)
			_, _ = writer.Write(encoded)
		case strings.HasSuffix(path, "/rename"):
			e.calls = append(e.calls, "rename")
			e.renames = append(e.renames, request.URL.Query().Get("name"))
			writer.WriteHeader(http.StatusNoContent)
		case path == "/v1.55/containers/create":
			e.calls = append(e.calls, "create")
			var sent map[string]any
			_ = json.NewDecoder(request.Body).Decode(&sent)
			e.createBody = sent
			if !e.createOK {
				writer.WriteHeader(http.StatusConflict)
				_, _ = writer.Write([]byte(`{"message":"port is already allocated"}`))
				return
			}
			payload, _ := json.Marshal(map[string]any{"Id": "newcontainerid", "Warnings": []string{}})
			_, _ = writer.Write(payload)
		case request.Method == http.MethodDelete:
			e.calls = append(e.calls, "remove")
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	})
}

func newRebindService(t *testing.T, engine *rebindEngine) *Service {
	t.Helper()
	socketPath, closeServer := startCustomDomainEngine(t, engine.handler(t))
	t.Cleanup(closeServer)
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	return newTestService(t, fakeDocker)
}

func TestRebindPortsRefusesARunningContainer(t *testing.T) {
	engine := &rebindEngine{running: true, createOK: true}
	service := newRebindService(t, engine)

	_, err := service.containersRebindPorts(context.Background(), ContainersRebindPortsParams{
		Context: "default", ID: "abc", Ports: map[string]string{"9090": "80/tcp"}, Confirmed: true,
	}, nil)
	if err == nil {
		t.Fatal("a container that is still serving must not be replaced underneath its traffic")
	}
	if !strings.Contains(err.Error(), "stopped or paused") {
		t.Fatalf("the refusal must say what state is required, got %v", err)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	for _, call := range engine.calls {
		if call == "rename" || call == "create" || call == "remove" {
			t.Fatalf("nothing may be touched when the request is refused, saw %v", engine.calls)
		}
	}
}

func TestRebindPortsAllowsAPausedContainer(t *testing.T) {
	// Paused is Running=true with frozen processes. It answers nothing, so replacing it
	// interrupts nothing — which is why it is allowed where running is not.
	engine := &rebindEngine{running: true, paused: true, createOK: true}
	service := newRebindService(t, engine)

	result, err := service.containersRebindPorts(context.Background(), ContainersRebindPortsParams{
		Context: "default", ID: "abc", Ports: map[string]string{"9090": "80/tcp"}, Confirmed: true,
	}, nil)
	if err != nil {
		t.Fatalf("a paused container should be republishable: %v", err)
	}
	if result.ID != "newcontainerid" || result.PreviousID != "abc" {
		t.Fatalf("the result must name both containers: %#v", result)
	}
}

func TestRebindPortsRequiresConfirmation(t *testing.T) {
	engine := &rebindEngine{createOK: true}
	service := newRebindService(t, engine)

	if _, err := service.containersRebindPorts(context.Background(), ContainersRebindPortsParams{
		Context: "default", ID: "abc", Ports: map[string]string{"9090": "80/tcp"},
	}, nil); err == nil {
		t.Fatal("replacing a container must be confirmed")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.calls) != 0 {
		t.Fatalf("an unconfirmed request must not reach the daemon at all, saw %v", engine.calls)
	}
}

func TestRebindPortsKeepsTheOriginalWhenTheNewPortIsRejected(t *testing.T) {
	// The failure this ordering exists for. A port already in use is the common case, and it
	// must cost nothing.
	engine := &rebindEngine{createOK: false}
	service := newRebindService(t, engine)

	_, err := service.containersRebindPorts(context.Background(), ContainersRebindPortsParams{
		Context: "default", ID: "abc", Ports: map[string]string{"9090": "80/tcp"}, Confirmed: true,
	}, nil)
	if err == nil {
		t.Fatal("a rejected creation must surface as an error")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	for _, call := range engine.calls {
		if call == "remove" {
			t.Fatalf("the original must survive a failed replacement, saw %v", engine.calls)
		}
	}
	if len(engine.renames) != 2 || !strings.HasSuffix(engine.renames[0], rebindParkedSuffix) ||
		engine.renames[1] != "api" {
		t.Fatalf("the original must be renamed back to its own name, saw %v", engine.renames)
	}
}

func TestRebindPortsRemovesTheOriginalOnlyAfterTheReplacementExists(t *testing.T) {
	engine := &rebindEngine{createOK: true}
	service := newRebindService(t, engine)

	if _, err := service.containersRebindPorts(context.Background(), ContainersRebindPortsParams{
		Context: "default", ID: "abc", Ports: map[string]string{"9090": "80/tcp"}, Confirmed: true,
	}, nil); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	createAt, removeAt := -1, -1
	for index, call := range engine.calls {
		if call == "create" {
			createAt = index
		}
		if call == "remove" {
			removeAt = index
		}
	}
	if createAt == -1 || removeAt == -1 || removeAt < createAt {
		t.Fatalf("the replacement must exist before the original is removed, saw %v", engine.calls)
	}
}

func TestRebindPortsStatesWhatRecreatingLoses(t *testing.T) {
	// The operator is not told this is an edit, because it is not one.
	engine := &rebindEngine{createOK: true}
	service := newRebindService(t, engine)

	result, err := service.containersRebindPorts(context.Background(), ContainersRebindPortsParams{
		Context: "default", ID: "abc", Ports: map[string]string{"9090": "80/tcp"}, Confirmed: true,
	}, nil)
	if err != nil {
		t.Fatalf("rebind: %v", err)
	}
	joined := strings.ToLower(strings.Join(result.Discarded, " "))
	for _, expected := range []string{"id changed", "writable layer", "log"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("the result must state that %q is lost, got %v", expected, result.Discarded)
		}
	}
}

func TestRebindPortsCarriesEverythingItDidNotChange(t *testing.T) {
	// The reason the create body is assembled from the container's own Config and HostConfig
	// rather than from a list of fields worth copying: a health check, a bind and a restart
	// policy all have to survive, and so does whatever this test did not think to name.
	engine := &rebindEngine{createOK: true}
	service := newRebindService(t, engine)

	if _, err := service.containersRebindPorts(context.Background(), ContainersRebindPortsParams{
		Context: "default", ID: "abc", Ports: map[string]string{"9090": "80/tcp"}, Confirmed: true,
	}, nil); err != nil {
		t.Fatalf("rebind: %v", err)
	}

	engine.mu.Lock()
	defer engine.mu.Unlock()
	body := engine.createBody
	if body == nil {
		t.Fatal("no create body was captured")
	}
	if body["Image"] != "nginx:1.27" {
		t.Fatalf("the image must survive: %#v", body["Image"])
	}
	if body["Healthcheck"] == nil {
		t.Fatal("the health check must survive; it is exactly the field a copy list would forget")
	}
	hostConfig, _ := body["HostConfig"].(map[string]any)
	if hostConfig == nil {
		t.Fatalf("HostConfig must survive: %#v", body)
	}
	binds, _ := hostConfig["Binds"].([]any)
	if len(binds) != 1 || binds[0] != "/srv:/data:ro" {
		t.Fatalf("bind mounts must survive: %#v", hostConfig["Binds"])
	}
	if hostConfig["RestartPolicy"] == nil {
		t.Fatal("the restart policy must survive")
	}

	// And the one thing that must NOT survive is the old binding.
	encoded, _ := json.Marshal(hostConfig["PortBindings"])
	if strings.Contains(string(encoded), "8080") {
		t.Fatalf("the previous binding must be replaced, not merged: %s", encoded)
	}
	if !strings.Contains(string(encoded), "9090") {
		t.Fatalf("the requested binding must be present: %s", encoded)
	}
}
