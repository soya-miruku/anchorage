package core

import (
	"context"
	"strings"
	"testing"
)

/*
A context name is the one caller-supplied string that becomes a bare positional argv element.

Everywhere else the name travels as the value of `--context`, where a leading dash is harmless
because docker's flag parser is already expecting a value. `docker context inspect <name>` is
the exception, and it was the one place this codebase did not apply its own rule — model
references, compose paths, MCP references, search terms and plugin names are all checked for a
leading dash before they are handed to a subprocess.

The guard has to run before the fork, so this asserts on a Service with no docker runner at
all: reaching the subprocess would nil-panic, which is exactly the failure this describes.
*/
func TestInspectEngineEndpointRefusesADashedContextName(t *testing.T) {
	service := &Service{}

	_, err := service.inspectEngineEndpoint(context.Background(), "--host=tcp://attacker:2375")

	if err == nil {
		t.Fatal("a context name beginning with a dash must be refused before it becomes argv")
	}
	if !strings.Contains(err.Error(), "cannot begin with a dash") {
		t.Fatalf("error should name the reason, got %q", err.Error())
	}
}
