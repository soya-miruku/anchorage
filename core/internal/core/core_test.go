package core

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const fullContainerID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestConfiguredCWDRootKeepsDefaultHomeAndAllowsSiblingProjects(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home", "tester")
	project := filepath.Join(root, "srv", "compose-project")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("create default home: %v", err)
	}
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("create project: %v", err)
	}
	service := &Service{
		defaultCWD:  home,
		allowedCWDs: []string{root},
	}

	defaultCWD, err := service.resolveAllowedCWD("")
	if err != nil || defaultCWD != home {
		t.Fatalf("default cwd = %q, %v; want %q", defaultCWD, err, home)
	}
	projectCWD, err := service.resolveAllowedCWD(project)
	if err != nil || projectCWD != project {
		t.Fatalf("project cwd = %q, %v; want %q", projectCWD, err, project)
	}

	outside := t.TempDir()
	if _, err := service.resolveAllowedCWD(outside); AsOpError(err).Code != "cwd_not_allowed" {
		t.Fatalf("outside configured root should be rejected, got %v", err)
	}
}

func TestCapabilitiesFingerprintsAndRecursivelyInventoriesFakeCLI(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	result, err := service.capabilities(context.Background(), CapabilitiesParams{Context: "default"})
	if err != nil {
		t.Fatalf("capabilities: %v", err)
	}
	if result.Binary == nil || len(result.Binary.SHA256) != 64 {
		t.Fatalf("missing binary fingerprint: %#v", result.Binary)
	}
	if result.SelectedContext != "default" || result.CurrentContext != "default" {
		t.Fatalf("unexpected contexts: selected=%q current=%q", result.SelectedContext, result.CurrentContext)
	}
	if result.Versions.Client.Version != "29.6.2" || result.APIMax != "1.55" || result.APIMin != "1.40" {
		t.Fatalf("unexpected version projection: %#v min=%q max=%q", result.Versions, result.APIMin, result.APIMax)
	}
	if !result.CommandInventory.Complete {
		t.Fatalf("inventory incomplete: %#v", result.CommandInventory.Warnings)
	}
	if result.CommandInventory.NodeCount != 18 {
		t.Fatalf("expected root + 17 recursively discovered nodes, got %d", result.CommandInventory.NodeCount)
	}
	composeUp := findCommand(result.CommandInventory.Root, []string{"compose", "up"})
	if composeUp == nil || composeUp.Kind != "plugin-command" || composeUp.Evidence.Stdout == "" {
		t.Fatalf("compose plugin subtree or raw help evidence missing: %#v", composeUp)
	}
	scoutAttestationAdd := findCommand(result.CommandInventory.Root, []string{"scout", "attestation", "add"})
	if scoutAttestationAdd == nil || scoutAttestationAdd.Kind != "plugin-command" || scoutAttestationAdd.Evidence.Stdout == "" {
		t.Fatalf("Scout punctuation-free plugin subtree or raw help evidence missing: %#v", scoutAttestationAdd)
	}
	if got := findCommand(result.CommandInventory.Root, []string{"scout"}); got == nil || got.Usage != "Usage: docker scout [command]" {
		t.Fatalf("Scout punctuation-free Usage was not normalized: %#v", got)
	}
	stderrInspect := findCommand(result.CommandInventory.Root, []string{"stderrtool", "inspect"})
	if stderrInspect == nil || stderrInspect.Evidence.Stdout == "" {
		t.Fatalf("stderr-only parent help did not produce a recursively probed child: %#v", stderrInspect)
	}
	if got := findCommand(result.CommandInventory.Root, []string{"stderrtool"}); got == nil || !strings.Contains(got.Evidence.Stderr, "Subcommands") {
		t.Fatalf("stderr-only help evidence was not retained: %#v", got)
	}
	if got := result.Capabilities["compose"]; got.Status != "available" || got.Version != "5.3.1" {
		t.Fatalf("unexpected compose capability: %#v", got)
	}
	if got := result.Capabilities["scout"]; got.Status != "available" || got.Version != "v1.18.3" {
		t.Fatalf("unexpected Scout capability: %#v", got)
	}
	if got := result.Capabilities["buildx"]; got.Status != "unavailable" {
		t.Fatalf("buildx must be unavailable in fixture: %#v", got)
	}
	if got := result.Capabilities["checkpoint"]; got.Status != "unavailable" || !strings.Contains(got.Reason, "experimental") {
		t.Fatalf("checkpoint must explain daemon prerequisite: %#v", got)
	}
	if len(result.Plugins) != 2 || result.Plugins[0].Name != "compose" || result.Plugins[1].Name != "scout" {
		t.Fatalf("unexpected plugins: %#v", result.Plugins)
	}
	if !strings.Contains(result.Evidence.Version.Stdout, `"29.6.2"`) {
		t.Fatalf("raw version evidence missing: %#v", result.Evidence.Version)
	}
}

func TestContainersListUsesNegotiatedUnixEngineProjection(t *testing.T) {
	socketPath, closeServer, requests := startFakeEngine(t)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	result, err := service.containersList(context.Background(), ContainersListParams{Context: "default"})
	if err != nil {
		t.Fatalf("containers list: %v", err)
	}
	if result.Source != "engine-api" || result.APIVersion != "1.55" || result.EndpointHash == "" {
		t.Fatalf("unexpected list metadata: %#v", result)
	}
	if len(result.Containers) != 1 {
		t.Fatalf("unexpected containers: %#v", result.Containers)
	}
	container := result.Containers[0]
	if container.ID != fullContainerID || container.Name != "web" || container.Health != "healthy" {
		t.Fatalf("unexpected container projection: %#v", container)
	}
	if len(container.Ports) != 1 || container.Ports[0].PublicPort != 8080 || container.Ports[0].PrivatePort != 80 {
		t.Fatalf("unexpected ports: %#v", container.Ports)
	}
	if !containsString(*requests, "GET /v1.55/containers/json?all=1") {
		t.Fatalf("negotiated list request not observed: %#v", *requests)
	}
}

func TestContainersListFallsBackOnlyForUnsupportedTransport(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	result, err := service.containersList(context.Background(), ContainersListParams{Context: "remote"})
	if err != nil {
		t.Fatalf("CLI fallback: %v", err)
	}
	if result.Source != "cli" || len(result.Containers) != 1 {
		t.Fatalf("unexpected fallback result: %#v", result)
	}
	container := result.Containers[0]
	if container.ID != fullContainerID || container.Health != "healthy" {
		t.Fatalf("unexpected fallback projection: %#v", container)
	}
	if len(container.Ports) != 2 {
		t.Fatalf("expected IPv4 and IPv6 CLI mappings, got %#v", container.Ports)
	}
}

func TestContainerActionRequiresImmutableIDAndSubmitsOnce(t *testing.T) {
	socketPath, closeServer, requests := startFakeEngine(t)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	var events []string

	receipt, err := service.containersAction(context.Background(), ContainersActionParams{
		Context: "default", ID: fullContainerID, Action: "restart",
		Options: ContainerActionOptions{TimeoutSeconds: 3},
	}, func(event string, _ any) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("container restart: %v", err)
	}
	if receipt.Outcome != "succeeded" || receipt.Source != "engine-api" || receipt.HTTPStatus != http.StatusNoContent {
		t.Fatalf("unexpected receipt: %#v", receipt)
	}
	expected := "POST /v1.55/containers/" + fullContainerID + "/restart?t=3"
	if countString(*requests, expected) != 1 {
		t.Fatalf("mutation was not submitted exactly once: %#v", *requests)
	}
	if fmt.Sprint(events) != "[operation.started operation.completed reconciliation.requested]" {
		t.Fatalf("unexpected events: %#v", events)
	}

	_, err = service.containersAction(context.Background(), ContainersActionParams{
		Context: "default", ID: "aaaaaaaaaaaa", Action: "start",
	}, nil)
	if got := AsOpError(err).Code; got != "invalid_container_id" {
		t.Fatalf("expected immutable ID rejection, got %q (%v)", got, err)
	}
	_, err = service.containersAction(context.Background(), ContainersActionParams{
		Context: "default", ID: fullContainerID, Action: "remove",
	}, nil)
	if got := AsOpError(err).Code; got != "confirmation_required" {
		t.Fatalf("expected destructive confirmation, got %q (%v)", got, err)
	}
}

func TestContainerActionUsesExactCLIFallbackForRemoteContext(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	receipt, err := service.containersAction(context.Background(), ContainersActionParams{
		Context: "remote", ID: fullContainerID, Action: "start",
	}, nil)
	if err != nil {
		t.Fatalf("remote CLI action: %v", err)
	}
	if receipt.Source != "cli" || receipt.Outcome != "succeeded" || receipt.ExitCode == nil || *receipt.ExitCode != 0 {
		t.Fatalf("unexpected CLI receipt: %#v", receipt)
	}
	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read fake log: %v", err)
	}
	call := "--context remote container start " + fullContainerID
	if strings.Count(string(logData), call) != 1 {
		t.Fatalf("expected exactly one CLI mutation, log=%s", logData)
	}
}

func TestLocalEngineFailureIsNotHiddenByCLIFallback(t *testing.T) {
	missingSocket := filepath.Join("/tmp", "anchorage-core-missing-"+strconv.FormatInt(time.Now().UnixNano(), 10)+".sock")
	fakeDocker, logPath := writeFakeDocker(t, missingSocket)
	service := newTestService(t, fakeDocker)

	_, err := service.containersList(context.Background(), ContainersListParams{Context: "default"})
	if got := AsOpError(err).Code; got != "engine_unreachable" {
		t.Fatalf("expected typed local Engine failure, got %q (%v)", got, err)
	}
	logData, readErr := os.ReadFile(logPath)
	if readErr != nil {
		t.Fatalf("read fake log: %v", readErr)
	}
	if strings.Contains(string(logData), "--context default ps") {
		t.Fatalf("local Engine failure was silently hidden by CLI fallback: %s", logData)
	}
}

func TestCLIRunPinsContextBoundsOutputAndEnforcesSafety(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	result, err := service.cliRun(context.Background(), CLIRunParams{
		Context: "remote",
		Argv:    []string{"fixture-echo", "hello"},
		Cwd:     filepath.Dir(fakeDocker),
		Env:     map[string]string{"SAFE_TOKEN": "works"},
	}, nil)
	if err != nil {
		t.Fatalf("cli.run: %v", err)
	}
	if result.ExitCode != 0 || result.TargetMode != "pinned" ||
		!strings.Contains(result.Stdout.Data, "SAFE_TOKEN=works") {
		t.Fatalf("unexpected CLI result: %#v", result)
	}
	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read fake log: %v", err)
	}
	if !strings.Contains(string(logData), "--context remote fixture-echo hello") {
		t.Fatalf("context was not injected: %s", logData)
	}

	literal, err := service.cliRun(context.Background(), CLIRunParams{
		Context:    "default",
		TargetMode: "literal",
		Argv:       []string{"--context", "remote", "fixture-echo", "hello"},
		Cwd:        filepath.Dir(fakeDocker),
		Env: map[string]string{
			"DOCKER_CONFIG": "/tmp/anchorage-literal-config",
			"SAFE_TOKEN":    "literal",
		},
	}, nil)
	if err != nil {
		t.Fatalf("literal cli.run: %v", err)
	}
	if literal.TargetMode != "literal" {
		t.Fatalf("literal target mode was not explicit in the result: %#v", literal)
	}
	if got := strings.Join(literal.Argv, " "); got != "--context remote fixture-echo hello" {
		t.Fatalf("literal target mode injected an extra context: %q", got)
	}
	if !strings.Contains(literal.Stdout.Data, "SAFE_TOKEN=literal") {
		t.Fatalf("literal Docker target environment was not accepted: %#v", literal)
	}

	_, err = service.cliRun(context.Background(), CLIRunParams{
		Context: "remote", Argv: []string{"ps", "--context", "other"},
	}, nil)
	if got := AsOpError(err).Code; got != "context_override_rejected" {
		t.Fatalf("expected context override rejection, got %q", got)
	}
	_, err = service.cliRun(context.Background(), CLIRunParams{
		Context: "remote", Argv: []string{"ps"}, Env: map[string]string{"LD_PRELOAD": "/tmp/x"},
	}, nil)
	if got := AsOpError(err).Code; got != "unsafe_environment" {
		t.Fatalf("expected unsafe environment rejection, got %q", got)
	}
	_, err = service.cliRun(context.Background(), CLIRunParams{
		Context: "remote", Argv: []string{"ps"}, Env: map[string]string{"DOCKER_HOST": "unix:///tmp/docker.sock"},
	}, nil)
	if got := AsOpError(err).Code; got != "unsafe_environment" {
		t.Fatalf("expected pinned Docker target environment rejection, got %q", got)
	}
	_, err = service.cliRun(context.Background(), CLIRunParams{
		Context: "remote", TargetMode: "other", Argv: []string{"ps"},
	}, nil)
	if got := AsOpError(err).Code; got != "invalid_target_mode" {
		t.Fatalf("expected invalid target mode rejection, got %q", got)
	}
	_, err = service.cliRun(context.Background(), CLIRunParams{
		Context: "remote", Argv: []string{"ps"}, Cwd: "/",
	}, nil)
	if got := AsOpError(err).Code; got != "cwd_not_allowed" {
		t.Fatalf("expected cwd allowlist rejection, got %q", got)
	}
	_, err = service.cliRun(context.Background(), CLIRunParams{
		Context: "remote", Argv: []string{"ps"}, Interactive: true,
	}, nil)
	if got := AsOpError(err).Code; got != "unsupported_mode" {
		t.Fatalf("expected unsupported mode, got %q", got)
	}
}

func TestBoundedCaptureTracksTotalBytesAndBinaryEncoding(t *testing.T) {
	writer := &prefixWriter{limit: 4}
	if _, err := writer.Write([]byte("abcdef")); err != nil {
		t.Fatalf("write: %v", err)
	}
	data, total, truncated := writer.snapshot()
	if string(data) != "abcd" || total != 6 || !truncated {
		t.Fatalf("unexpected bounded capture: data=%q total=%d truncated=%v", data, total, truncated)
	}
	captured := capturedOutput([]byte{0xff, 0x00}, 2, false)
	if captured.Encoding != "base64" || captured.Data != "/wA=" {
		t.Fatalf("unexpected binary encoding: %#v", captured)
	}
}

func TestHandleRejectsUnknownAndMissingRequiredParams(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	_, err := service.Handle(context.Background(), "containers.list", json.RawMessage(`{"all":true,"unknown":1}`), nil)
	if got := AsOpError(err).Code; got != "invalid_params" {
		t.Fatalf("expected strict unknown-field rejection, got %q", got)
	}
	_, err = service.Handle(context.Background(), "containers.list", json.RawMessage(`{"all":true}`), nil)
	if got := AsOpError(err).Code; got != "context_required" {
		t.Fatalf("expected missing required context rejection, got %q", got)
	}
	_, err = service.Handle(context.Background(), "cli.run", json.RawMessage(`{"context":"default"}`), nil)
	if got := AsOpError(err).Code; got != "argv_required" {
		t.Fatalf("expected missing required argv rejection, got %q", got)
	}
	_, err = service.Handle(context.Background(), "session.start", json.RawMessage(`{"context":"default","args":["ps"],"mode":"pipes"}`), nil)
	if got := AsOpError(err).Code; got != "invalid_params" {
		t.Fatalf("expected legacy session argv field rejection, got %q", got)
	}
	_, err = service.Handle(context.Background(), "session.start", json.RawMessage(`{"context":"default","argv":["ps"]}`), nil)
	if got := AsOpError(err).Code; got != "invalid_session_mode" {
		t.Fatalf("expected missing session mode rejection, got %q", got)
	}
}

func TestParseHelpChildrenIsConservative(t *testing.T) {
	output := []byte(`Available Commands:
  alpha       A real command with a description that
              wraps onto another line
  beta*       A plugin command

Options:
  -h, --help  help
`)
	children := parseHelpChildren(output)
	if len(children) != 2 || children[0].name != "alpha" || children[1].name != "beta" || !children[1].plugin {
		t.Fatalf("unexpected parsed children: %#v", children)
	}
}

func TestParseHelpChildrenAcceptsPunctuationFreeScoutSections(t *testing.T) {
	output := []byte(strings.ReplaceAll(`Usage
  docker scout [command]

Available Commands
  attestation   Manage attestations on images
  quickview     Quick overview of an image
  version

Learn More
  Read docker scout cli reference at https://docs.docker.com/
`, "\n", "\r\n"))
	children := parseHelpChildren(output)
	if len(children) != 3 || children[0].name != "attestation" || children[1].name != "quickview" || children[2].name != "version" {
		t.Fatalf("unexpected punctuation-free Scout children: %#v", children)
	}
	if got := parseUsage(output); got != "Usage: docker scout [command]" {
		t.Fatalf("unexpected punctuation-free Scout usage: %q", got)
	}
}

func TestEvaluateHelpResultPreservesMixedStreamRowsAndStripsANSI(t *testing.T) {
	tests := []struct {
		name   string
		stdout []byte
		stderr []byte
	}{
		{
			name:   "heading on stdout",
			stdout: []byte("\x1b[0mUsage: docker mixed COMMAND\n\nAvailable Commands:\n"),
			stderr: []byte("  \x1b[32minspect\x1b[0m   Inspect split-stream help\n"),
		},
		{
			name:   "heading on stderr",
			stdout: []byte("  \x1b[32minspect\x1b[0m   Inspect split-stream help\n"),
			stderr: []byte("\x1b[0mUsage: docker mixed COMMAND\n\nAvailable Commands:\n"),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := &CommandNode{Name: "mixed"}
			children := evaluateHelpResult(node, commandResult{
				stdout:   test.stdout,
				stderr:   test.stderr,
				exitCode: 0,
			})
			if node.Status != "available" || node.Usage != "Usage: docker mixed COMMAND" {
				t.Fatalf("mixed-stream help was not accepted: %#v", node)
			}
			if len(children) != 1 || children[0].name != "inspect" || children[0].description != "Inspect split-stream help" {
				t.Fatalf("mixed-stream command indentation was not preserved: %#v", children)
			}
		})
	}
	if strings.Contains(string(combinedHelpOutput(commandResult{
		stdout: []byte("\x1b[0mAvailable Commands:\n"),
		stderr: []byte("  inspect   Inspect split-stream help\n"),
	})), "\x1b") {
		t.Fatal("ANSI control sequence survived help normalization")
	}
}

func TestEvaluateHelpResultFailsClosedForEitherTruncatedStream(t *testing.T) {
	tests := []struct {
		name   string
		result commandResult
	}{
		{
			name: "stdout",
			result: commandResult{
				stdout:          []byte("Available Commands:\n  inspect   Inspect\n"),
				stdoutTruncated: true,
			},
		},
		{
			name: "stderr",
			result: commandResult{
				stderr:          []byte("Available Commands:\n  inspect   Inspect\n"),
				stderrTruncated: true,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			node := &CommandNode{Name: "truncated"}
			children := evaluateHelpResult(node, test.result)
			if children != nil || node.Status != "degraded" {
				t.Fatalf("truncated %s help did not fail closed: node=%#v children=%#v", test.name, node, children)
			}
			if node.Usage != "" || !strings.Contains(node.Reason, "exceeded the evidence limit") {
				t.Fatalf("truncated %s help retained unproven metadata: %#v", test.name, node)
			}
		})
	}
}

func TestInventoryHelpEnvironmentDisablesColorAndPinsLocale(t *testing.T) {
	expected := map[string]string{
		"CLICOLOR":    "0",
		"FORCE_COLOR": "0",
		"LANG":        "C",
		"LC_ALL":      "C",
		"NO_COLOR":    "1",
		"TERM":        "dumb",
	}
	if len(inventoryHelpEnvironment) != len(expected) {
		t.Fatalf("unexpected discovery environment: %#v", inventoryHelpEnvironment)
	}
	for key, value := range expected {
		if got := inventoryHelpEnvironment[key]; got != value {
			t.Fatalf("discovery environment %s=%q, want %q", key, got, value)
		}
	}
}

func TestParseUsageFallsBackToCobraCommandHint(t *testing.T) {
	output := []byte(`Usage

Subcommands
  add  Add an item

Use "docker scout attestation [command] --help" for more information about a command.
`)
	children := parseHelpChildren(output)
	if len(children) != 1 || children[0].name != "add" {
		t.Fatalf("unexpected Subcommands children: %#v", children)
	}
	if got := parseUsage(output); got != "Usage: docker scout attestation [command]" {
		t.Fatalf("unexpected fallback Usage: %q", got)
	}
}

func TestExtractVersionStringSkipsPluginBanner(t *testing.T) {
	output := []byte("\n  decorative banner\n\nversion: v1.18.3 (go1.24.6 - linux/amd64)\ngit commit: abc\n")
	if got := extractVersionString(output); got != "v1.18.3 (go1.24.6 - linux/amd64)" {
		t.Fatalf("unexpected version extraction: %q", got)
	}
}

func newTestService(t *testing.T, fakeDocker string) *Service {
	t.Helper()
	service, err := NewService(Config{
		DockerExecutable: fakeDocker,
		AllowedCWDRoots:  []string{filepath.Dir(fakeDocker)},
	})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	return service
}

func startFakeEngine(t *testing.T) (string, func(), *[]string) {
	t.Helper()
	socketDirectory, err := os.MkdirTemp("/tmp", "anchorage-core-test-")
	if err != nil {
		t.Fatalf("create short unix socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDirectory) })
	socketPath := filepath.Join(socketDirectory, "docker.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	var lock sync.Mutex
	requests := make([]string, 0)
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		lock.Lock()
		requests = append(requests, request.Method+" "+request.URL.RequestURI())
		lock.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.URL.Path == "/version":
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
		case request.URL.Path == "/v1.55/containers/json":
			_, _ = writer.Write([]byte(`[{
				"Id":"` + fullContainerID + `",
				"Names":["/web"],
				"Image":"nginx:latest",
				"ImageID":"sha256:bbbb",
				"Created":123,
				"State":"running",
				"Status":"Up 2 minutes (healthy)",
				"Labels":{"app":"web"},
				"Ports":[{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":8080,"Type":"tcp"}]
			}]`))
		case strings.HasSuffix(request.URL.Path, "/restart"):
			writer.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(request.URL.Path, "/start"):
			writer.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(request.URL.Path, "/stop"):
			writer.WriteHeader(http.StatusNoContent)
		case strings.Contains(request.URL.Path, "/containers/") && request.Method == http.MethodDelete:
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"message":"not found"}`))
		}
	})
	server := &http.Server{Handler: handler}
	go func() {
		_ = server.Serve(listener)
	}()
	closeServer := func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = listener.Close()
	}
	return socketPath, closeServer, &requests
}

func writeFakeDocker(t *testing.T, socketPath string) (string, string) {
	t.Helper()
	directory := t.TempDir()
	executable := filepath.Join(directory, "docker")
	logPath := filepath.Join(directory, "calls.log")
	template := `#!/bin/sh
printf '%s\n' "$*" >> __LOG__
case "$*" in
  "context show")
    printf '%s\n' 'default'
    ;;
  "context ls --format {{json .}}")
    printf '%s\n' '{"Current":true,"Description":"Local fixture","DockerEndpoint":__ENDPOINT__,"Error":"","Name":"default"}'
    printf '%s\n' '{"Current":false,"Description":"Remote fixture","DockerEndpoint":"ssh://fixture","Error":"","Name":"remote"}'
    ;;
  "context inspect default")
    printf '%s\n' '[{"Name":"default","Endpoints":{"docker":{"Host":__ENDPOINT__}}}]'
    ;;
  "context inspect remote")
    printf '%s\n' '[{"Name":"remote","Endpoints":{"docker":{"Host":"ssh://fixture"}}}]'
    ;;
  "--context default version --format {{json .}}")
    printf '%s\n' '{"Client":{"Version":"29.6.2","ApiVersion":"1.55","GoVersion":"go1.26","GitCommit":"client","Os":"linux","Arch":"amd64"},"Server":{"Version":"29.6.2","ApiVersion":"1.55","MinAPIVersion":"1.40","GoVersion":"go1.26","GitCommit":"server","Os":"linux","Arch":"amd64"}}'
    ;;
  "--context default info --format {{json .}}")
    printf '%s\n' '{"ExperimentalBuild":false,"ClientInfo":{"Plugins":[{"SchemaVersion":"0.1.0","Vendor":"Docker Inc.","Version":"5.3.1","ShortDescription":"Docker Compose","Name":"compose","Path":"/fixture/docker-compose"},{"SchemaVersion":"0.1.0","Vendor":"Docker Inc.","Version":"v1.18.3","ShortDescription":"Docker Scout","Name":"scout","Path":"/fixture/docker-scout"}]}}'
    ;;
  "--context default --help")
    printf '%s\n' 'Usage: docker [OPTIONS] COMMAND' '' 'Management Commands:' '  compose*    Docker Compose' '  scout*      Docker Scout' '  container   Manage containers' '' 'Commands:' '  checkpoint  Manage checkpoints' '  ps          List containers' '  stderrtool  Help is emitted on stderr'
    ;;
  "--context default compose --help")
    printf '%s\n' 'Usage: docker compose COMMAND' '' 'Available Commands:' '  up       Create and start' '  version  Show version'
    ;;
  "--context default scout --help")
    printf '%s\n' 'Usage' '  docker scout [command]' '' 'Available Commands' '  attestation  Manage attestations on images' '  quickview    Quick overview of an image'
    ;;
  "--context default scout attestation --help")
    printf '%s\n' 'Usage' '' 'Available Commands' '  add       Add attestation to image' '  list      List attestations for image' '' 'Use "docker scout attestation [command] --help" for more information about a command.'
    ;;
  "--context default stderrtool --help")
    printf '%s\n' 'Usage: docker stderrtool COMMAND' '' 'Subcommands' '  inspect   Inspect stderr help' >&2
    ;;
  "--context default container --help")
    printf '%s\n' 'Usage: docker container COMMAND' '' 'Commands:' '  ls       List containers' '  restart  Restart a container' '  start    Start a container' '  stop     Stop a container'
    ;;
  "--context default compose up --help"|"--context default compose version --help"|"--context default scout attestation add --help"|"--context default scout attestation list --help"|"--context default scout quickview --help"|"--context default stderrtool inspect --help"|"--context default container ls --help"|"--context default container restart --help"|"--context default container start --help"|"--context default container stop --help"|"--context default checkpoint --help"|"--context default ps --help")
    printf '%s\n' "Usage: docker $*"
    ;;
  "--context default compose version --format json")
    printf '%s\n' '{"version":"5.3.1"}'
    ;;
  "--context default scout version")
    printf '%s\n' 'version: v1.18.3'
    ;;
  "--context remote info --format {{json .}}")
    printf '%s\n' '{"ID":"remote-engine","Name":"remote-fixture","ServerVersion":"29.6.2","OSType":"linux","OperatingSystem":"Remote Linux","Architecture":"x86_64","KernelVersion":"6.0","NCPU":4,"MemTotal":8000000000,"Containers":2,"ContainersRunning":1,"ContainersPaused":0,"ContainersStopped":1,"Images":3,"Driver":"overlay2","DockerRootDir":"/var/lib/docker","ExperimentalBuild":false,"LiveRestoreEnabled":false}'
    ;;
  "--context remote ps --all --no-trunc --format {{json .}}")
    printf '%s\n' '{"ID":"` + fullContainerID + `","Names":"remote-web","Image":"nginx:latest","State":"running","Status":"Up 1 minute (healthy)","HealthStatus":"healthy","Ports":"0.0.0.0:8080->80/tcp, [::]:8080->80/tcp"}'
    ;;
  "--context remote fixture-echo hello")
    printf 'ARGS=%s SAFE_TOKEN=%s' "$*" "$SAFE_TOKEN"
    ;;
  "--context remote container start ` + fullContainerID + `")
    printf '%s\n' '` + fullContainerID + `'
    ;;
  "--context remote container inspect --format {{json .}} ` + fullContainerID + `")
    printf '%s\n' '{"Id":"` + fullContainerID + `","Name":"/remote-web","Image":"` + fullImageID + `","State":{"Status":"running","Running":true},"Config":{"Image":"fixture:latest"},"NetworkSettings":{"Ports":{},"Networks":{}}}'
    ;;
  "--context remote image ls --no-trunc --digests --all --format {{json .}}")
    printf '%s\n' '{"ID":"` + fullImageID + `","Repository":"fixture","Tag":"latest","Digest":"sha256:cccc","CreatedAt":"2026-01-01","Size":"500B","Containers":"2"}'
    ;;
  "--context remote volume ls --format {{json .}}")
    printf '%s\n' '{"Name":"remote-data","Driver":"local","Scope":"local","Mountpoint":"/remote-data","Labels":"app=fixture","Size":"321B"}'
    ;;
  "--context remote image inspect --format {{.Id}} fixture:latest")
    printf '%s\n' '` + fullImageID + `'
    ;;
  "--context remote image rm fixture:latest")
    printf '%s\n' 'Untagged: fixture:latest'
    ;;
  "--context remote image prune --force")
    printf '%s\n' 'Total reclaimed space: 0B'
    ;;
  "--context remote volume create --driver local remote-created")
    printf '%s\n' 'remote-created'
    ;;
  "--context remote volume prune --force --all")
    printf '%s\n' 'Total reclaimed space: 0B'
    ;;
  "--context default image pull alpine:3.20")
    printf '%s\n' '3.20: Pulling from library/alpine' 'Status: Downloaded newer image for alpine:3.20'
    ;;
  *)
    printf '%s\n' "unexpected fake docker argv: $*" >&2
    exit 64
    ;;
esac
`
	endpointJSON := strconv.Quote("unix://" + socketPath)
	script := strings.ReplaceAll(template, "__ENDPOINT__", endpointJSON)
	script = strings.ReplaceAll(script, "__LOG__", shellQuote(logPath))
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	return executable, logPath
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func containsString(values []string, wanted string) bool {
	return countString(values, wanted) > 0
}

func countString(values []string, wanted string) int {
	count := 0
	for _, value := range values {
		if value == wanted {
			count++
		}
	}
	return count
}

// Command discovery spawns roughly one `docker ... --help` subprocess per advertised node --
// 244 processes and ~2.7s against a real Docker 29.6 install. It used to run on every
// system.capabilities call, which sits on the first-paint path and is re-issued on every core
// restart and Command Center open.
func TestCommandInventoryIsDiscoveredOncePerBinary(t *testing.T) {
	socketPath, closeServer, _ := startDomainEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	defer service.closeEngineClients()

	countHelpCalls := func() int {
		data, err := os.ReadFile(logPath)
		if err != nil {
			return 0
		}
		count := 0
		for _, line := range strings.Split(string(data), "\n") {
			if strings.Contains(line, "--help") {
				count++
			}
		}
		return count
	}

	if _, err := service.capabilities(context.Background(), CapabilitiesParams{Context: "default"}); err != nil {
		t.Fatalf("first capabilities: %v", err)
	}
	afterFirst := countHelpCalls()
	if afterFirst == 0 {
		t.Fatal("expected the first capabilities call to walk the command tree")
	}

	for range 3 {
		if _, err := service.capabilities(context.Background(), CapabilitiesParams{Context: "default"}); err != nil {
			t.Fatalf("repeat capabilities: %v", err)
		}
	}
	if got := countHelpCalls(); got != afterFirst {
		t.Fatalf("expected the command inventory to be cached; help calls went %d -> %d", afterFirst, got)
	}
}
