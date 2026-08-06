package core

import (
	"encoding/json"
	"strings"
	"testing"
)

/*
The two text parsers are the fragile half of the Models read.

`docker model ls` has a `--json` flag and is bound to Docker's own struct. `status` and `df` do
not, so they are scraped from column-aligned tables that Docker may reformat at any release.
These fix the two properties that actually decide whether the scrape is right — where a column
boundary is, and where the runner's own verdict comes from — against output captured verbatim
from docker/model-runner v1.2.6.
*/

// Captured from `docker model status` on the reference host, spacing preserved exactly.
const liveStatusOutput = `Docker Model Runner is running

BACKEND    STATUS         DETAILS
llama.cpp  Running        llama.cpp 72874f559
diffusers  Not Installed
mlx        Not Installed  only supported on Apple Silicon
sglang     Not Installed  package not installed
vllm       Not Installed  binary not found
`

// Captured from `docker model df` on the same host.
const liveDiskOutput = `TYPE              SIZE
Models            42.00B
Inference engine  222.08MB
`

func TestParseModelRunnerStatusReadsLiveOutput(t *testing.T) {
	status := parseModelRunnerStatus(liveStatusOutput)

	if !status.Running {
		t.Fatalf("runner should be running, got %+v", status)
	}
	if status.Reported != "Docker Model Runner is running" {
		t.Fatalf("reported = %q", status.Reported)
	}
	if len(status.Backends) != 5 {
		t.Fatalf("expected 5 backends, got %d: %+v", len(status.Backends), status.Backends)
	}

	// The column split is the whole point. A naive split on single spaces would turn
	// "Not Installed" into two fields and shift every detail one column left, so a backend
	// would report its status as "Not" and its detail as "Installed".
	if got := status.Backends[1]; got.Name != "diffusers" || got.Status != "Not Installed" || got.Detail != "" {
		t.Fatalf("diffusers row parsed wrong: %+v", got)
	}
	// A detail containing single spaces has to survive intact.
	if got := status.Backends[2]; got.Detail != "only supported on Apple Silicon" {
		t.Fatalf("mlx detail parsed wrong: %q", got.Detail)
	}
	if got := status.Backends[0]; got.Name != "llama.cpp" || got.Status != "Running" {
		t.Fatalf("llama.cpp row parsed wrong: %+v", got)
	}
}

func TestParseModelRunnerStatusTakesRunningFromTheSentenceNotTheTable(t *testing.T) {
	// A backend row saying "Running" is a claim about that backend. If the runner itself is
	// down, no row may talk the parser into reporting it up — that would show an operator a
	// healthy runner while every inference request fails.
	stopped := `Docker Model Runner is not running

BACKEND    STATUS   DETAILS
llama.cpp  Running  llama.cpp 72874f559
`
	status := parseModelRunnerStatus(stopped)
	if status.Running {
		t.Fatalf("a stopped runner must not report running: %+v", status)
	}
	if status.Reported != "Docker Model Runner is not running" {
		t.Fatalf("reported = %q", status.Reported)
	}
	// The backend is still listed; only the verdict changed.
	if len(status.Backends) != 1 || status.Backends[0].Status != "Running" {
		t.Fatalf("backends = %+v", status.Backends)
	}
}

func TestParseModelRunnerStatusDegradesRatherThanGuessing(t *testing.T) {
	// The contract this file exists to protect: an unrecognised table yields nothing, and the
	// caller keeps the model list. Header-only, empty, and prose-only inputs must all be safe.
	for name, input := range map[string]string{
		"empty":       "",
		"header only": "BACKEND  STATUS  DETAILS\n",
		"prose only":  "Docker Model Runner is running\n",
	} {
		status := parseModelRunnerStatus(input)
		if len(status.Backends) != 0 {
			t.Fatalf("%s: invented %d backends: %+v", name, len(status.Backends), status.Backends)
		}
		if status.Backends == nil {
			t.Fatalf("%s: backends must marshal as [] rather than null", name)
		}
	}
}

func TestParseModelDiskUsageKeepsMultiWordLabels(t *testing.T) {
	usage := parseModelDiskUsage(liveDiskOutput)

	if len(usage) != 2 {
		t.Fatalf("expected 2 rows, got %d: %+v", len(usage), usage)
	}
	if usage[0] != (ModelDiskUsage{Label: "Models", Size: "42.00B"}) {
		t.Fatalf("first row = %+v", usage[0])
	}
	// "Inference engine" is one label with a space in it, in a table whose columns are
	// separated by two or more.
	if usage[1] != (ModelDiskUsage{Label: "Inference engine", Size: "222.08MB"}) {
		t.Fatalf("second row = %+v", usage[1])
	}
}

func TestParseModelDiskUsageSkipsTheHeader(t *testing.T) {
	usage := parseModelDiskUsage("TYPE  SIZE\n")
	if len(usage) != 0 {
		t.Fatalf("header was read as data: %+v", usage)
	}
}

func TestSplitColumnsSeparatesOnTwoSpacesOnly(t *testing.T) {
	got := splitColumns("Inference engine  222.08MB  ")
	if len(got) != 2 || got[0] != "Inference engine" || got[1] != "222.08MB" {
		t.Fatalf("splitColumns = %q", got)
	}
	// One space is inside a field, never between them.
	if got := splitColumns("a b c"); len(got) != 1 || got[0] != "a b c" {
		t.Fatalf("single spaces should not split: %q", got)
	}
}

func TestProjectModelPrefersATagOverTheDigest(t *testing.T) {
	// The reference is what `docker model rm` will be handed, so it has to be something the
	// CLI accepts. A tagged model is addressed by tag; an untagged one only by digest.
	contextSize := int32(4096)
	entry := modelListEntry{ID: "sha256:abc", Tags: []string{"ai/smollm2:latest", "ai/smollm2:360M"}, Created: 1742816981}
	entry.Config.Size = "256.35 MiB"
	entry.Config.ContextSize = &contextSize

	model := projectModel(entry)
	if model.Reference != "ai/smollm2:latest" {
		t.Fatalf("reference = %q, want the first tag", model.Reference)
	}
	if model.ContextSize == nil || *model.ContextSize != 4096 {
		t.Fatalf("contextSize = %v", model.ContextSize)
	}
	if model.Created != "2025-03-24T11:49:41Z" {
		t.Fatalf("created = %q", model.Created)
	}

	untagged := projectModel(modelListEntry{ID: "sha256:def"})
	if untagged.Reference != "sha256:def" {
		t.Fatalf("an untagged model must fall back to its digest, got %q", untagged.Reference)
	}
	// Marshals as [] rather than null, so the renderer never has to guard the field.
	encoded, err := json.Marshal(untagged)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"tags":[]`) {
		t.Fatalf("tags should marshal as an empty array: %s", encoded)
	}
	// A model with no creation timestamp must not claim the Unix epoch.
	if untagged.Created != "" {
		t.Fatalf("created = %q, want empty for an absent timestamp", untagged.Created)
	}
}

func TestModelListEntryDecodesDockersOwnShape(t *testing.T) {
	// Bound to `pkg/inference/models.Model` in docker/model-runner, and cross-checked against
	// live `docker model inspect` output, which prints the same envelope without tags.
	const payload = `[{
	  "id": "sha256:354bf30d0aa3af413d2aa5ae4f23c66d78980072d1e07a5b0d776e9606a2f0b9",
	  "tags": ["ai/smollm2:latest"],
	  "created": 1742816981,
	  "config": {
	    "format": "gguf",
	    "quantization": "IQ2_XXS/Q4_K_M",
	    "parameters": "361.82 M",
	    "architecture": "llama",
	    "size": "256.35 MiB"
	  }
	}]`
	var entries []modelListEntry
	if err := json.Unmarshal([]byte(payload), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	model := projectModel(entries[0])
	if model.Format != "gguf" || model.Architecture != "llama" || model.Parameters != "361.82 M" {
		t.Fatalf("config not projected: %+v", model)
	}
	if model.Quantization != "IQ2_XXS/Q4_K_M" {
		t.Fatalf("quantization = %q", model.Quantization)
	}
}

func TestModelsUnavailableRecognisesAnAbsentPlugin(t *testing.T) {
	// The one failure worth naming: the fix is to install the plugin, not to retry.
	for _, stderr := range []string{
		"docker: 'model' is not a docker command.",
		"unknown command \"model\" for \"docker\"",
	} {
		if !modelsUnavailable(stderr) {
			t.Fatalf("should be recognised as an absent plugin: %q", stderr)
		}
	}
	if modelsUnavailable("Error response from daemon: no such model") {
		t.Fatal("an ordinary failure must not be reported as a missing plugin")
	}
}
