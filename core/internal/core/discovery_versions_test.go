package core

import (
	"strings"
	"testing"
)

/*
Both sides of `docker version`, on the path the launch already takes.

The Engine API cannot answer this. `/version` describes the daemon, so the CLI's own version —
and therefore any skew between the two — is invisible to every read the app makes over the
socket. A newer CLI against an older daemon is the ordinary way a Linux install drifts: the
package manager upgrades `docker-ce-cli` while the daemon keeps running the binary it started
with. The operator sees flags that do nothing and errors that name neither version.

These pin that the cheap contexts read carries both, and that losing it degrades to a warning
rather than failing the launch.
*/

func TestContextsReportsBothSidesOfDockerVersion(t *testing.T) {
	socketPath, cleanup, _ := startFakeEngine(t)
	defer cleanup()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	result, err := service.contexts(t.Context(), ContextsParams{Context: "default"})
	if err != nil {
		t.Fatalf("contexts: %v", err)
	}
	if result.Versions.Client.Version == "" {
		t.Fatalf("the client version is the half the Engine API cannot supply: %+v", result.Versions)
	}
	if result.Versions.Server.Version == "" {
		t.Fatalf("the server version must be carried too: %+v", result.Versions)
	}
	// The daemon's floor is what decides whether an older CLI can talk to it at all.
	if result.Versions.Server.MinAPIVersion == "" {
		t.Fatalf("the server's minimum API version must survive the parse: %+v", result.Versions)
	}
}

func TestContextsDegradesToAWarningWhenVersionCannotBeRead(t *testing.T) {
	// The contexts are what the launch needs. A version read that fails must not take the
	// window down with it.
	script := `#!/bin/sh
case "$*" in
  "context show") printf '%s\n' 'default' ;;
  "context ls --format {{json .}}")
    printf '%s\n' '{"Current":true,"Description":"local","DockerEndpoint":"unix:///var/run/docker.sock","Error":"","Name":"default"}' ;;
  *"version --format"*) exit 3 ;;
  *) exit 0 ;;
esac
`
	service := newTestService(t, writeFakeDockerScript(t, script))

	result, err := service.contexts(t.Context(), ContextsParams{Context: "default"})
	if err != nil {
		t.Fatalf("a failed version read must not fail the contexts call: %v", err)
	}
	if len(result.Contexts) == 0 {
		t.Fatalf("the contexts themselves must still be reported: %+v", result)
	}
	if result.Versions.Client.Version != "" || result.Versions.Server.Version != "" {
		t.Fatalf("no version may be invented when the read failed: %+v", result.Versions)
	}
	joined := strings.Join(result.Warnings, " | ")
	if !strings.Contains(joined, "docker version") {
		t.Fatalf("the failure must be reported as a warning, got %q", joined)
	}
}
