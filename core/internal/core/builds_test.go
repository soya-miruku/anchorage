package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestBuildRecordIDStripsTheBuilderPath(t *testing.T) {
	// `history ls` reports builder/node/id but `history inspect` rejects that outright. The
	// mismatch yields an empty detail pane rather than an error, so it is pinned here.
	for _, testCase := range []struct{ ref, id string }{
		{"default/default/00b5zi7celyy89egnd8922ps1", "00b5zi7celyy89egnd8922ps1"},
		{"00b5zi7celyy89egnd8922ps1", "00b5zi7celyy89egnd8922ps1"},
		{"a/b/c/d", "d"},
	} {
		if got := buildRecordID(testCase.ref); got != testCase.id {
			t.Fatalf("%q reduced to %q, want %q", testCase.ref, got, testCase.id)
		}
	}
}

func TestBuildRefValidationConstrainsArgv(t *testing.T) {
	if _, err := validateBuildRef("default/default/00b5zi7celyy89egnd8922ps1"); err != nil {
		t.Fatalf("a real reference should validate: %v", err)
	}
	// The identifier becomes an argv element.
	// A builder name may legitimately carry separators and case, so those are accepted inside
	// a segment; what must never be accepted is anything that could read as a flag or escape
	// the reference's own shape.
	if _, err := validateBuildRef("desktop-linux/node_1/00b5zi7celyy89egnd8922ps1"); err != nil {
		t.Fatalf("a builder name with separators should validate: %v", err)
	}
	for _, bad := range []string{
		"", "--format", "-o", "../../etc", "has space", "semi;colon", "a//b", "/leading",
	} {
		if _, err := validateBuildRef(bad); err == nil {
			t.Fatalf("build reference %q must be rejected", bad)
		}
	}
}

func TestBuildStatusesAreProjected(t *testing.T) {
	for raw, want := range map[string]string{
		"Completed": "success", "completed": "success",
		"Error": "failed", "Canceled": "cancelled", "running": "running",
		"something-new": "unknown",
	} {
		if got := normalizeBuildStatus(raw); got != want {
			t.Fatalf("%q projected to %q, want %q", raw, got, want)
		}
	}
}

func TestStreamedJSONAcceptsBothFramings(t *testing.T) {
	// buildx uses an array in some places and one object per line in others, exactly as
	// Compose does. Guessing wrong yields an empty list rather than an error.
	for _, payload := range []string{
		`[{"n":1},{"n":2}]`,
		"{\"n\":1}\n{\"n\":2}\n",
	} {
		count := 0
		if err := decodeStreamedJSON([]byte(payload), func(json.RawMessage) error {
			count++
			return nil
		}); err != nil {
			t.Fatalf("%q should decode: %v", payload, err)
		}
		if count != 2 {
			t.Fatalf("%q yielded %d items, want 2", payload, count)
		}
	}
	if err := decodeStreamedJSON([]byte("  \n"), func(json.RawMessage) error { return nil }); err != nil {
		t.Fatalf("blank output should decode to nothing: %v", err)
	}
}

/*
Acting on one builder.

The builders table reported an unreachable builder and offered nothing to do about it. These
cover the two verbs that changed that, and — as with the plugin repairs — the refusals carry
more weight than the successes: `buildx rm` discards a build cache, and `use` stays absent
because it rewrites configuration belonging to every tool on the machine, not just this one.
*/

// builderActionService stands up a service over a fake buildx that records its argv, so a test
// can assert the exact command rather than only that something succeeded.
func builderActionService(t *testing.T, exitCode int, stderr string) (*Service, func() []string) {
	t.Helper()
	directory := t.TempDir()
	executable := filepath.Join(directory, "docker")
	logPath := filepath.Join(directory, "calls.log")
	script := `#!/bin/sh
printf '%s\n' "$*" >> ` + logPath + `
case "$*" in
  *"buildx ls --format json"*)
    printf '%s\n' '{"Name":"default","Driver":"docker","Current":true,"Nodes":[{"Name":"default","Status":"running","Platforms":["linux/amd64"]}]}'
    ;;
  *"buildx rm"*|*"buildx inspect"*)
    printf '%s\n' '` + stderr + `' >&2
    printf '%s\n' 'buildx said something'
    exit ` + strconv.Itoa(exitCode) + `
    ;;
esac
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}
	readCalls := func() []string {
		contents, err := os.ReadFile(logPath)
		if err != nil {
			return nil
		}
		return strings.Split(strings.TrimSpace(string(contents)), "\n")
	}
	return newTestService(t, executable), readCalls
}

func TestBuilderNameIsConstrainedBeforeItBecomesAnArgument(t *testing.T) {
	// Separators belong inside a builder name — `desktop-linux` is Docker's own — but a leading
	// '-' is what turns the value into a flag.
	for _, name := range []string{"desktop-linux", "podman_2", "builder.one", "a"} {
		if _, err := validateBuilderName(name); err != nil {
			t.Fatalf("%q is a legitimate builder name: %v", name, err)
		}
	}
	for _, name := range []string{"-rm", "", "a b", "a/b", "a;rm -rf /", "--all-inactive"} {
		if _, err := validateBuilderName(name); err == nil {
			t.Fatalf("%q must be refused before it reaches argv", name)
		}
	}
}

func TestBuilderActionRefusesAnActionOutsideTheAllowlist(t *testing.T) {
	service, _ := builderActionService(t, 0, "")
	// `use` in particular: it is absent by decision, not by oversight.
	for _, action := range []string{"use", "create", "prune", "stop"} {
		_, err := service.builderAction(t.Context(), BuilderActionParams{
			Context: "default", Name: "podman", Action: action, Confirmed: true,
		})
		if code := AsOpError(err).Code; code != "unsupported_builder_action" {
			t.Fatalf("%q must be refused by name, got %q", action, code)
		}
	}
}

func TestBuilderRemoveRequiresConfirmation(t *testing.T) {
	service, calls := builderActionService(t, 0, "")

	_, err := service.builderAction(t.Context(), BuilderActionParams{
		Context: "default", Name: "podman", Action: "remove",
	})
	if code := AsOpError(err).Code; code != "confirmation_required" {
		t.Fatalf("removing a builder discards its cache and must be confirmed, got %q", code)
	}
	for _, call := range calls() {
		if strings.Contains(call, "buildx rm") {
			t.Fatalf("an unconfirmed remove must not reach buildx: %q", call)
		}
	}
}

func TestBuilderBootstrapRefusesAConfirmationItDoesNotNeed(t *testing.T) {
	// Accepting `confirmed` here would let a caller believe they had agreed to something about
	// a verb that destroys nothing.
	service, _ := builderActionService(t, 0, "")

	_, err := service.builderAction(t.Context(), BuilderActionParams{
		Context: "default", Name: "podman", Action: "bootstrap", Confirmed: true,
	})
	if code := AsOpError(err).Code; code != "invalid_action_options" {
		t.Fatalf("confirmation belongs to remove alone, got %q", code)
	}
}

func TestBuilderActionRunsBuildxsOwnVerbs(t *testing.T) {
	for _, testCase := range []struct {
		action, want, outcome string
	}{
		{"remove", "buildx rm podman", "removed"},
		{"bootstrap", "buildx inspect --bootstrap podman", "bootstrapped"},
	} {
		service, calls := builderActionService(t, 0, "")
		result, err := service.builderAction(t.Context(), BuilderActionParams{
			Context:   "default",
			Name:      "podman",
			Action:    testCase.action,
			Confirmed: testCase.action == "remove",
		})
		if err != nil {
			t.Fatalf("%s: %v", testCase.action, err)
		}
		if result.Outcome != testCase.outcome {
			t.Fatalf("%s: outcome %q, want %q", testCase.action, result.Outcome, testCase.outcome)
		}
		found := false
		for _, call := range calls() {
			if strings.Contains(call, testCase.want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s did not run %q; calls were %v", testCase.action, testCase.want, calls())
		}
		// The inventory is re-read, because removing the current builder promotes another one
		// and the caller cannot derive which.
		if len(result.Builders) == 0 {
			t.Fatalf("%s must report the builders that remain", testCase.action)
		}
	}
}

func TestBuilderActionCarriesBuildxsOwnRefusal(t *testing.T) {
	// buildx explains this better than any wording here could, so its words are what surface.
	service, _ := builderActionService(t, 1, "ERROR: cannot remove the default builder")
	_, err := service.builderAction(t.Context(), BuilderActionParams{
		Context: "default", Name: "default", Action: "remove", Confirmed: true,
	})
	failure := AsOpError(err)
	if failure.Code != "builder_action_failed" {
		t.Fatalf("a non-zero buildx exit must fail the action, got %q", failure.Code)
	}
	if stderr, _ := failure.Details["stderr"].(string); !strings.Contains(stderr, "cannot remove the default builder") {
		t.Fatalf("buildx's own reason must be carried, got %q", stderr)
	}
}
