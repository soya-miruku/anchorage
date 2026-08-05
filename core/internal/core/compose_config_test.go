package core

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The shape Compose 5.3.1 renders for a project exercising every feature this projection
// reads. Staged rather than produced live: the resolved model is the contract, and a test that
// needed a working daemon and a project on disk would only prove this machine has one.
const composeConfigFixture = `{
  "name": "storefront",
  "services": {
    "ai": {
      "command": null,
      "provider": {"type": "model", "options": {"model": ["ai/llama3.2"]}}
    },
    "api": {
      "image": "alpine:3.20",
      "user": "app",
      "depends_on": {
        "cache": {"condition": "service_started", "required": false},
        "db": {"condition": "service_healthy", "restart": true, "required": true},
        "absent": {"condition": "service_started", "required": true}
      },
      "develop": {
        "watch": [
          {"path": "/srv/app/src", "action": "sync", "target": "/app/src",
           "exec": {"command": null}, "ignore": ["node_modules/"]},
          {"path": "/srv/app/bin", "action": "sync+exec", "target": "/app/bin",
           "exec": {"command": ["/app/reload.sh"]}}
        ]
      },
      "models": {"llama": {"endpoint_var": "LLM_URL", "model_var": "LLM_MODEL"}},
      "secrets": [{"source": "api_token", "target": "/run/secrets/api_token"}],
      "volumes": [
        {"type": "volume", "source": "data", "target": "/data", "volume": {}},
        {"type": "volume", "source": "data", "target": "/backup", "volume": {}},
        {"type": "bind", "source": "/etc/localtime", "target": "/etc/localtime"}
      ],
      "post_start": [
        {"command": ["/bin/sh", "-c", "echo warm"], "user": "root", "privileged": true},
        {"command": ["chown", "-R", "app", "/data"], "working_dir": "/data"}
      ],
      "pre_stop": [{"command": ["/bin/sh", "-c", "echo bye"], "user": "0:0"}]
    },
    "cache": {
      "image": "redis:7",
      "depends_on": {"db": {"condition": "service_started", "required": true}},
      "profiles": ["full"]
    },
    "db": {
      "image": "postgres:16",
      "volumes": [{"type": "volume", "source": "data", "target": "/var/lib/postgresql/data"}]
    }
  },
  "volumes": {
    "data": {"name": "storefront_data", "driver": "local"},
    "external_vol": {"name": "shared", "external": true}
  },
  "secrets": {"api_token": {"name": "storefront_api_token", "file": "/srv/app/token.txt"}}
}`

func TestComposeConfigRequiresTheProjectFilesItRenders(t *testing.T) {
	realFile := filepath.Join(t.TempDir(), "compose.yaml")
	if err := os.WriteFile(realFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatalf("seed compose file: %v", err)
	}

	// `config` renders files. Unlike stop or down it cannot find a project by label, so an
	// empty file list is a request Compose could only answer with an error.
	if err := validateComposeConfig(ComposeConfigParams{Project: "storefront"}); err == nil {
		t.Fatal("config must require the project's configuration files")
	}
	if err := validateComposeConfig(ComposeConfigParams{
		Project: "Upper", ConfigFiles: []string{realFile},
	}); err == nil {
		t.Fatal("an invalid project name must be rejected")
	}
	// The same paths `up` refuses: a flag, a stream, a relative path, one that is not there.
	for _, refused := range []string{"-rf", "/dev/stdin", "/proc/self/fd/0", "compose.yaml",
		filepath.Join(t.TempDir(), "absent.yaml")} {
		if err := validateComposeConfig(ComposeConfigParams{
			Project: "storefront", ConfigFiles: []string{refused},
		}); err == nil {
			t.Fatalf("configuration file %q must be rejected", refused)
		}
	}
	many := make([]string, 33)
	for index := range many {
		many[index] = realFile
	}
	if err := validateComposeConfig(ComposeConfigParams{
		Project: "storefront", ConfigFiles: many,
	}); err == nil {
		t.Fatal("an unbounded file list must be rejected")
	}
	if err := validateComposeConfig(ComposeConfigParams{
		Project: "storefront", ConfigFiles: []string{realFile},
	}); err != nil {
		t.Fatalf("a well-formed request should validate: %v", err)
	}
}

func TestComposeConfigProjectsStartOrderConditionsWatchAndHooks(t *testing.T) {
	document, err := decodeComposeConfig([]byte(composeConfigFixture))
	if err != nil {
		t.Fatalf("fixture should decode: %v", err)
	}
	services, cyclic := projectComposeServices(document.Services)
	if cyclic {
		t.Fatal("the fixture declares no cycle")
	}
	if len(services) != 4 {
		t.Fatalf("expected 4 services, got %d", len(services))
	}
	// Sorted by the order Compose starts them in, so the projection reads as the sequence.
	order := map[string]int{}
	for _, service := range services {
		order[service.Name] = service.StartOrder
	}
	if order["db"] != 0 || order["ai"] != 0 || order["cache"] != 1 || order["api"] != 2 {
		t.Fatalf("start order wrong: %+v", order)
	}
	if services[len(services)-1].Name != "api" {
		t.Fatalf("the deepest service must sort last: %+v", services)
	}

	var api ComposeConfigService
	for _, service := range services {
		if service.Name == "api" {
			api = service
		}
		if service.Name == "cache" && (len(service.Profiles) != 1 || service.Profiles[0] != "full") {
			t.Fatalf("profiles must survive: %+v", service)
		}
	}
	// depends_on carries the condition, not just the edge: waiting for healthy is a different
	// project from waiting for started.
	if len(api.DependsOn) != 3 {
		t.Fatalf("api should declare three dependencies: %+v", api.DependsOn)
	}
	if api.DependsOn[0].Service != "absent" || api.DependsOn[1].Service != "cache" ||
		api.DependsOn[2].Service != "db" {
		t.Fatalf("dependencies must be ordered: %+v", api.DependsOn)
	}
	if api.DependsOn[1].Required || api.DependsOn[1].Condition != "service_started" {
		t.Fatalf("an optional dependency must stay optional: %+v", api.DependsOn[1])
	}
	if api.DependsOn[2].Condition != "service_healthy" || !api.DependsOn[2].Restart ||
		!api.DependsOn[2].Required {
		t.Fatalf("a health-gated dependency lost its terms: %+v", api.DependsOn[2])
	}

	if len(api.Watch) != 2 || api.Watch[0].Action != "sync" ||
		api.Watch[0].Target != "/app/src" || len(api.Watch[0].Ignore) != 1 {
		t.Fatalf("watch rules projected wrong: %+v", api.Watch)
	}
	if len(api.Watch[1].Command) != 1 || api.Watch[1].Command[0] != "/app/reload.sh" {
		t.Fatalf("an exec rule must carry the command it runs: %+v", api.Watch[1])
	}

	if len(api.Hooks) != 3 {
		t.Fatalf("expected three lifecycle hooks: %+v", api.Hooks)
	}
	if api.Hooks[0].Phase != "post_start" || !api.Hooks[0].RunsAsRoot || !api.Hooks[0].Privileged {
		t.Fatalf("a root, privileged hook must say so: %+v", api.Hooks[0])
	}
	// The second hook names no user, so it runs as the service's — which is not root, and the
	// projection must not upgrade it.
	if api.Hooks[1].User != "app" || api.Hooks[1].RunsAsRoot || api.Hooks[1].WorkingDir != "/data" {
		t.Fatalf("a hook must inherit the service's user: %+v", api.Hooks[1])
	}
	if api.Hooks[2].Phase != "pre_stop" || !api.Hooks[2].RunsAsRoot {
		t.Fatalf("a numeric root uid is still root: %+v", api.Hooks[2])
	}
}

func TestComposeConfigProjectsDeclaredDependenciesByKind(t *testing.T) {
	document, err := decodeComposeConfig([]byte(composeConfigFixture))
	if err != nil {
		t.Fatalf("fixture should decode: %v", err)
	}
	dependencies := projectComposeDependencies(document)
	byKey := map[string]ComposeDeclaredDependency{}
	kinds := []string{}
	for _, dependency := range dependencies {
		byKey[dependency.Kind+"/"+dependency.Name] = dependency
		kinds = append(kinds, dependency.Kind)
	}
	if len(dependencies) != 5 {
		t.Fatalf("expected model, provider, secret and two volumes: %+v", dependencies)
	}
	if kinds[0] != "model" || kinds[1] != "provider" || kinds[2] != "secret" {
		t.Fatalf("dependencies must be grouped by kind: %+v", kinds)
	}
	model := byKey["model/llama"]
	if len(model.Services) != 1 || model.Services[0] != "api" {
		t.Fatalf("a model must name the services that declare it: %+v", model)
	}
	provider := byKey["provider/ai"]
	if provider.Resource != "model" {
		t.Fatalf("a provider must carry its type: %+v", provider)
	}
	secret := byKey["secret/api_token"]
	if secret.Resource != "storefront_api_token" || len(secret.Services) != 1 {
		t.Fatalf("a secret must carry its resolved name: %+v", secret)
	}
	// A service mounting the same volume twice is one edge, and the bind mount is not a
	// declared dependency at all.
	data := byKey["volume/data"]
	if data.Resource != "storefront_data" || len(data.Services) != 2 ||
		data.Services[0] != "api" || data.Services[1] != "db" {
		t.Fatalf("volume edges projected wrong: %+v", data)
	}
	external := byKey["volume/external_vol"]
	if !external.External || external.Resource != "shared" || len(external.Services) != 0 {
		t.Fatalf("an external volume nothing mounts must still be declared: %+v", external)
	}
}

func TestComposeStartOrderTerminatesOnACycle(t *testing.T) {
	// Compose refuses a cyclic depends_on, but the walk must not depend on that: a cycle here
	// would otherwise recurse until the core died.
	services := map[string]composeConfigService{
		"a": {DependsOn: map[string]composeConfigDependency{"b": {}}},
		"b": {DependsOn: map[string]composeConfigDependency{"a": {}}},
		"c": {},
	}
	order, cyclic := composeStartOrder(services)
	if !cyclic {
		t.Fatal("a cycle must be reported rather than presented as a start order")
	}
	if order["c"] != 0 {
		t.Fatalf("an unrelated service must still rank: %+v", order)
	}
}

func TestComposeConfigDecodeRejectsNonsense(t *testing.T) {
	if _, err := decodeComposeConfig([]byte("  ")); err == nil {
		t.Fatal("empty output must error rather than project an empty project")
	}
	if _, err := decodeComposeConfig([]byte("{not json}")); err == nil {
		t.Fatal("malformed output must error")
	}
}

func TestComposeConfigWarningsSurviveAsLimitations(t *testing.T) {
	// An unset variable changes the values this projection carries, so Compose's own warning
	// is worth more than the exit code it does not affect.
	warnings := composeConfigWarnings("WARN[0000] The \"TAG\" variable is not set.\n" +
		"WARN[0000] The \"TAG\" variable is not set.\n\nWARN[0000] obsolete `version`")
	if len(warnings) != 2 || !strings.Contains(warnings[1], "obsolete") {
		t.Fatalf("warnings should be deduplicated and carried: %+v", warnings)
	}
	if got := composeConfigWarnings(""); got != nil {
		t.Fatalf("a quiet run has no limitations to add: %+v", got)
	}
}

func TestComposeConfigRunsAPinnedRenderOfTheGivenFiles(t *testing.T) {
	directory := t.TempDir()
	composeFile := filepath.Join(directory, "compose.yaml")
	if err := os.WriteFile(composeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatalf("seed compose file: %v", err)
	}
	fakeDocker, logPath := writeFakeComposeConfigDocker(t, composeConfigFixture)
	service := newTestService(t, fakeDocker)

	result, err := service.composeConfig(context.Background(), ComposeConfigParams{
		Context: "default", Project: "storefront", ConfigFiles: []string{composeFile},
	})
	if err != nil {
		t.Fatalf("compose config: %v", err)
	}
	if result.Source != "cli-json" || result.Project != "storefront" || len(result.Services) != 4 {
		t.Fatalf("unexpected projection: %+v", result)
	}
	// Compose renders `include` away, so the projection says so rather than reporting an empty
	// include list as if the project had none.
	joined := strings.Join(result.Limitations, " | ")
	if !strings.Contains(joined, "include") {
		t.Fatalf("the include limitation must be reported: %+v", result.Limitations)
	}
	if !strings.Contains(joined, "models section") {
		t.Fatalf("the models limitation must be reported when a service declares one: %+v", result.Limitations)
	}
	if !strings.Contains(joined, "variable is not set") {
		t.Fatalf("Compose's own warning must survive: %+v", result.Limitations)
	}

	logged, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read fake docker log: %v", err)
	}
	argv := strings.TrimSpace(string(logged))
	// Pinned to the selected context, targeted by project name and by the files the caller
	// named, and rendered without resolving env files the projection does not carry.
	for _, expected := range []string{
		"--context default", "compose --project-name storefront",
		"--file " + composeFile, "config --format json --no-env-resolution",
	} {
		if !strings.Contains(argv, expected) {
			t.Fatalf("argv %q is missing %q", argv, expected)
		}
	}
}

func TestComposeConfigReportsAMissingPlugin(t *testing.T) {
	directory := t.TempDir()
	composeFile := filepath.Join(directory, "compose.yaml")
	if err := os.WriteFile(composeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatalf("seed compose file: %v", err)
	}
	fakeDocker := writeFakeDockerScript(t, `#!/bin/sh
printf '%s\n' "docker: 'compose' is not a docker command." >&2
exit 1
`)
	service := newTestService(t, fakeDocker)

	_, err := service.composeConfig(context.Background(), ComposeConfigParams{
		Context: "default", Project: "storefront", ConfigFiles: []string{composeFile},
	})
	// The operator's fix is to install the plugin, which a generic failure would not say.
	if got := AsOpError(err).Code; got != "compose_unavailable" {
		t.Fatalf("expected compose_unavailable, got %q (%v)", got, err)
	}
}

func writeFakeComposeConfigDocker(t *testing.T, document string) (string, string) {
	t.Helper()
	directory := t.TempDir()
	documentPath := filepath.Join(directory, "config.json")
	if err := os.WriteFile(documentPath, []byte(document), 0o600); err != nil {
		t.Fatalf("write staged compose config: %v", err)
	}
	logPath := filepath.Join(directory, "calls.log")
	script := `#!/bin/sh
printf '%s\n' "$*" >> ` + shellQuote(logPath) + `
printf '%s\n' 'WARN[0000] The "TAG" variable is not set. Defaulting to a blank string.' >&2
cat ` + shellQuote(documentPath) + `
`
	return writeFakeDockerScript(t, script), logPath
}

func writeFakeDockerScript(t *testing.T, script string) string {
	t.Helper()
	executable := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	return executable
}
