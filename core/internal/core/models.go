package core

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

/*
Docker Model Runner, read through `docker model`.

Model Runner is the one AI capability Docker ships that a standalone Linux Engine can run in
full. The plugin is packaged (`docker-model-plugin`, and an AUR recipe on Arch), the runner is
an ordinary container on this engine, inference is local, and nothing here needs a Docker
account or a subscription. That is why this destination survived the removal of the other AI
screens: every instruction it can give an operator is one they can actually follow.

Three reads back one screen. `docker model ls --json`, `docker model status` and
`docker model df` answer different questions — what is on disk, whether the runner is up and
which backends it has, and what all of it costs — and a Models screen that showed any one
without the others would mislead. An empty model list means something quite different when the
runner is not running than when it is.

The list is JSON and is parsed strictly. Status and disk usage are column-aligned text with no
JSON option, so they are parsed best-effort and are allowed to come back empty: a table Docker
reformats must degrade to "not reported" rather than take the model list down with it. That
asymmetry is deliberate and is why they are separate fields rather than one.
*/

const (
	// `docker model ls` pulls the runner image on first use — observed here taking well over a
	// minute on a cold machine, printing pull progress before answering. The ordinary read
	// timeout would turn a first run into a failure the operator cannot distinguish from a
	// broken install.
	modelsReadTimeout = 5 * time.Minute
	// The model list is small — a handful of records with short string fields — but `ls` can
	// prefix it with runner-image pull progress, which is not small.
	modelsOutputLimit = 4 * 1024 * 1024
	// Search reaches Docker Hub and Hugging Face, so it is bounded separately and tightly:
	// a slow registry must not hold a request open for the list timeout.
	modelsSearchTimeout = 45 * time.Second
	// Docker Hub returns a page at a time; this is the ceiling the UI will ask for.
	modelsSearchLimit = 25
)

/*
The JSON `docker model ls --json` prints.

Bound to Docker's own `pkg/inference/models.Model` (id, tags, created, config) and its
`pkg/distribution/types.Config`, and cross-checked against live output from the installed
plugin — `docker model inspect` returns the same envelope minus tags. Every field is optional
in practice: `config` is only populated for formats that report one, and an empty `[]` is the
normal answer on a machine with no models pulled.
*/
type modelListEntry struct {
	ID      string   `json:"id"`
	Tags    []string `json:"tags"`
	Created int64    `json:"created"`
	Config  struct {
		Format       string `json:"format"`
		Quantization string `json:"quantization"`
		Parameters   string `json:"parameters"`
		Architecture string `json:"architecture"`
		Size         string `json:"size"`
		ContextSize  *int32 `json:"context_size"`
	} `json:"config"`
}

// modelsUnavailable recognises the one failure worth naming: the plugin is not installed. The
// operator's fix is to install it, not to retry, and Settings → Engine → Capabilities carries
// the command for this host.
func modelsUnavailable(stderr string) bool {
	return strings.Contains(stderr, "is not a docker command") ||
		strings.Contains(stderr, "unknown command")
}

func modelsPluginError(stderr string) *OpError {
	return opError("models_unavailable",
		"The Docker Model Runner plugin is not installed for this Docker CLI.", nil,
		map[string]any{"stderr": stderr})
}

/*
Runner state, parsed from `docker model status`.

The output is a sentence followed by a BACKEND/STATUS/DETAILS table:

	Docker Model Runner is running

	BACKEND    STATUS         DETAILS
	llama.cpp  Running        llama.cpp 72874f559
	mlx        Not Installed  only supported on Apple Silicon

`Running` is taken from the sentence rather than inferred from the table, because a backend row
saying "Running" is a claim about that backend, not about the runner. Columns are split on runs
of two or more spaces: a single space appears inside both STATUS ("Not Installed") and DETAILS.
*/
func parseModelRunnerStatus(stdout string) ModelRunnerStatus {
	status := ModelRunnerStatus{Backends: []ModelBackend{}}
	lines := strings.Split(stdout, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "docker model runner is ") {
			status.Reported = trimmed
			status.Running = strings.Contains(lower, "is running")
			continue
		}
		fields := splitColumns(trimmed)
		if len(fields) < 2 {
			continue
		}
		// The header names the columns; it is not a backend.
		if strings.EqualFold(fields[0], "BACKEND") {
			continue
		}
		backend := ModelBackend{Name: fields[0], Status: fields[1]}
		if len(fields) > 2 {
			backend.Detail = fields[2]
		}
		status.Backends = append(status.Backends, backend)
	}
	return status
}

/*
Disk usage, parsed from `docker model df`:

	TYPE              SIZE
	Models            42.00B
	Inference engine  222.08MB

The sizes are already formatted for reading and are carried through as printed rather than
parsed into bytes. Re-deriving a number from "222.08MB" and reformatting it would introduce a
rounding difference between what Anchorage shows and what `docker model df` shows, for no gain:
nothing here does arithmetic on them.
*/
func parseModelDiskUsage(stdout string) []ModelDiskUsage {
	usage := []ModelDiskUsage{}
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		fields := splitColumns(trimmed)
		if len(fields) < 2 || strings.EqualFold(fields[0], "TYPE") {
			continue
		}
		usage = append(usage, ModelDiskUsage{Label: fields[0], Size: fields[1]})
	}
	return usage
}

// splitColumns splits a column-aligned row on runs of two or more spaces, which is what
// separates the columns in every table `docker model` prints. Splitting on single spaces would
// break "Not Installed" and "Inference engine" into separate fields.
func splitColumns(line string) []string {
	fields := []string{}
	current := strings.Builder{}
	spaces := 0
	flush := func() {
		if value := strings.TrimSpace(current.String()); value != "" {
			fields = append(fields, value)
		}
		current.Reset()
	}
	for _, r := range line {
		if r == ' ' {
			spaces++
			continue
		}
		if spaces >= 2 {
			flush()
		} else if spaces == 1 && current.Len() > 0 {
			current.WriteRune(' ')
		}
		spaces = 0
		current.WriteRune(r)
	}
	flush()
	return fields
}

// projectModel turns one `ls --json` record into the wire shape. The reference an operator
// acts on is a tag; the digest is what identifies the model when no tag points at it.
func projectModel(entry modelListEntry) DockerModel {
	model := DockerModel{
		ID:           entry.ID,
		Tags:         entry.Tags,
		Format:       entry.Config.Format,
		Quantization: entry.Config.Quantization,
		Parameters:   entry.Config.Parameters,
		Architecture: entry.Config.Architecture,
		Size:         entry.Config.Size,
	}
	if model.Tags == nil {
		model.Tags = []string{}
	}
	if entry.Config.ContextSize != nil {
		size := int(*entry.Config.ContextSize)
		model.ContextSize = &size
	}
	if entry.Created > 0 {
		model.Created = time.Unix(entry.Created, 0).UTC().Format(time.RFC3339)
	}
	// What `docker model run|rm` will accept. A tagged model is addressed by its first tag,
	// exactly as the CLI's own table does; an untagged one only by digest.
	if len(model.Tags) > 0 {
		model.Reference = model.Tags[0]
	} else {
		model.Reference = model.ID
	}
	return model
}

func (s *Service) modelsList(parent context.Context, params ModelsListParams) (ModelsListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ModelsListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, modelsReadTimeout)
	defer cancel()

	listed, err := s.runDockerValidated(ctx, contextName, []string{"model", "ls", "--json"}, modelsOutputLimit)
	if err != nil {
		return ModelsListResult{}, err
	}
	if listed.exitCode != 0 {
		stderr := strings.TrimSpace(string(listed.stderr))
		if modelsUnavailable(stderr) {
			return ModelsListResult{}, modelsPluginError(stderr)
		}
		return ModelsListResult{}, opError("models_list_failed",
			"Docker CLI could not list local models.", nil,
			map[string]any{"exitCode": listed.exitCode, "stderr": stderr})
	}

	// `ls` prints runner-image pull progress before the JSON on a cold machine, so the payload
	// is taken from the first `[` rather than from the start of stdout.
	payload := strings.TrimSpace(string(listed.stdout))
	if index := strings.IndexByte(payload, '['); index > 0 {
		payload = payload[index:]
	}
	entries := []modelListEntry{}
	if payload != "" {
		if err := json.Unmarshal([]byte(payload), &entries); err != nil {
			return ModelsListResult{}, opError("models_list_unreadable",
				"Docker CLI returned a model list this build could not parse.", err,
				map[string]any{"bytes": len(payload)})
		}
	}
	models := make([]DockerModel, 0, len(entries))
	for _, entry := range entries {
		models = append(models, projectModel(entry))
	}
	sort.SliceStable(models, func(left, right int) bool {
		return models[left].Reference < models[right].Reference
	})

	result := ModelsListResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Models:          models,
		Disk:            []ModelDiskUsage{},
		ObservedAt:      time.Now().UTC().Format(time.RFC3339Nano),
	}
	result.Runner = ModelRunnerStatus{Backends: []ModelBackend{}}

	// Status and disk usage are supplementary. A non-zero exit or an unrecognised table leaves
	// them empty rather than failing the read: the model list is the thing the screen cannot
	// do without, and losing it because `df` changed its columns would be the wrong trade.
	if status, statusErr := s.runDockerValidated(ctx, contextName, []string{"model", "status"}, modelsOutputLimit); statusErr == nil && status.exitCode == 0 {
		result.Runner = parseModelRunnerStatus(string(status.stdout))
	}
	if disk, diskErr := s.runDockerValidated(ctx, contextName, []string{"model", "df"}, modelsOutputLimit); diskErr == nil && disk.exitCode == 0 {
		result.Disk = parseModelDiskUsage(string(disk.stdout))
	}
	return result, nil
}

/*
The JSON `docker model search --json` prints, verified against live output.

Search reaches Docker Hub's `ai/` namespace and, on request, Hugging Face. It is the one read
here that leaves the machine, which is why it is a separate verb with its own timeout rather
than folded into the list: an operator browsing a catalogue has consented to a network call in
a way that someone opening a screen has not.
*/
type modelSearchEntry struct {
	Name        string `json:"Name"`
	Description string `json:"Description"`
	Downloads   int64  `json:"Downloads"`
	Stars       int64  `json:"Stars"`
	Source      string `json:"Source"`
	Official    bool   `json:"Official"`
	UpdatedAt   string `json:"UpdatedAt"`
	Backend     string `json:"Backend"`
	Size        int64  `json:"Size"`
}

/*
modelPullReference turns a search hit into something `docker model pull` can actually resolve.

`docker model search --source=huggingface` returns Hugging Face repositories under their own
names — `HuggingFaceTB/SmolLM2-135M-Instruct` — and `docker model pull` resolves an unqualified
name against Docker Hub. Passing the hit's name straight through therefore fails on every
Hugging Face result, and fails in a way that reads like the model does not exist:

	failed to pull model "huggingfacetb/smollm2-135m-instruct:latest":
	resolving docker.io/huggingfacetb/smollm2-135m-instruct:latest:
	pull access denied, repository does not exist or may require authorization

It exists; it is on the other registry. `hf.co/` is the prefix the plugin routes to Hugging
Face, verified against the CLI: the same name with the prefix pulls, and lands in the list as
`huggingface.co/huggingfacetb/smollm2-135m-instruct`.

Done here rather than in the renderer because which registry a hit came from is a fact the
search already knows, and a UI assembling registry references is a UI that will eventually
assemble a wrong one. A name that is already qualified is left alone, so a plugin that starts
returning fully-qualified Hugging Face names does not end up with the prefix twice.
*/
func modelPullReference(name, source string) string {
	reference := strings.TrimSpace(name)
	if reference == "" {
		return ""
	}
	if !strings.EqualFold(strings.TrimSpace(source), "huggingface") {
		return boundScoutField(reference)
	}
	lower := strings.ToLower(reference)
	if strings.HasPrefix(lower, "hf.co/") || strings.HasPrefix(lower, "huggingface.co/") {
		return boundScoutField(reference)
	}
	return boundScoutField("hf.co/" + reference)
}

func (s *Service) modelsSearch(parent context.Context, params ModelsSearchParams) (ModelsSearchResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ModelsSearchResult{}, err
	}
	query := strings.TrimSpace(params.Query)
	if len(query) > 128 {
		return ModelsSearchResult{}, opError("invalid_query",
			"A model search term must be 128 characters or fewer.", nil, nil)
	}
	// A leading dash would be read as a flag by the plugin rather than as a search term.
	if strings.HasPrefix(query, "-") {
		return ModelsSearchResult{}, opError("invalid_query",
			"A model search term cannot begin with a dash.", nil, nil)
	}
	source := strings.TrimSpace(params.Source)
	switch source {
	case "", "docker-hub":
		source = ""
	case "huggingface", "all":
		// Both reach a second registry, which the caller has asked for explicitly.
	default:
		return ModelsSearchResult{}, opError("invalid_source",
			"A model search source must be docker-hub, huggingface, or all.", nil,
			map[string]any{"source": params.Source})
	}

	ctx, cancel := context.WithTimeout(parent, modelsSearchTimeout)
	defer cancel()

	argv := []string{"model", "search", "--json", "--limit", itoa(modelsSearchLimit)}
	if source != "" {
		argv = append(argv, "--source="+source)
	}
	if query != "" {
		// After `--`, so a term that survives the checks above still cannot be read as a flag.
		argv = append(argv, "--", query)
	}
	found, err := s.runDockerValidated(ctx, contextName, argv, modelsOutputLimit)
	if err != nil {
		return ModelsSearchResult{}, err
	}
	if found.exitCode != 0 {
		stderr := strings.TrimSpace(string(found.stderr))
		if modelsUnavailable(stderr) {
			return ModelsSearchResult{}, modelsPluginError(stderr)
		}
		return ModelsSearchResult{}, opError("models_search_failed",
			"Docker CLI could not search for models.", nil,
			map[string]any{"exitCode": found.exitCode, "stderr": stderr})
	}

	payload := strings.TrimSpace(string(found.stdout))
	if index := strings.IndexByte(payload, '['); index > 0 {
		payload = payload[index:]
	}
	entries := []modelSearchEntry{}
	if payload != "" {
		if err := json.Unmarshal([]byte(payload), &entries); err != nil {
			return ModelsSearchResult{}, opError("models_search_unreadable",
				"Docker CLI returned search results this build could not parse.", err,
				map[string]any{"bytes": len(payload)})
		}
	}
	results := make([]ModelSearchResult, 0, len(entries))
	for _, entry := range entries {
		results = append(results, ModelSearchResult{
			Name:        boundScoutField(entry.Name),
			Reference:   modelPullReference(entry.Name, entry.Source),
			Description: boundScoutField(entry.Description),
			Downloads:   entry.Downloads,
			Stars:       entry.Stars,
			Source:      boundScoutField(entry.Source),
			Official:    entry.Official,
			UpdatedAt:   entry.UpdatedAt,
			Backend:     boundScoutField(entry.Backend),
			SizeBytes:   entry.Size,
		})
	}
	return ModelsSearchResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Query:           query,
		Results:         results,
		ObservedAt:      time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

// itoa avoids importing strconv for one call site in a file that otherwise needs none.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

/*
Acting on one model.

Three verbs, split by how long they take and therefore by how they report.

`pull` streams. A model is gigabytes and the download outlives the request that started it, so
it runs through the session manager exactly as an image pull does — the caller gets a session
id back immediately and follows progress through session events. Inheriting the request
context would kill the download the moment `models.action` returned.

`remove` and `unload` are bounded and answer inline. Unloading evicts a model from memory
without touching the disk copy, which is the one action here that is not destructive; removing
deletes the weights.
*/
func (s *Service) modelsAction(parent context.Context, params ModelsActionParams, emit EventEmitter) (ModelsActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ModelsActionResult{}, err
	}
	params.Context = contextName
	reference := strings.TrimSpace(params.Reference)

	switch params.Action {
	case "pull", "remove":
		if reference == "" {
			return ModelsActionResult{}, opError("reference_required",
				"A model reference is required for this action.", nil,
				map[string]any{"action": params.Action})
		}
	case "unload":
		// Unload with no reference evicts everything, which is a legitimate ask.
	default:
		return ModelsActionResult{}, opError("invalid_action",
			"A model action must be pull, remove, or unload.", nil,
			map[string]any{"action": params.Action})
	}
	// A reference reaches argv, so it may not be mistaken for a flag. The plugin accepts
	// registry references and digests, neither of which begins with a dash.
	if strings.HasPrefix(reference, "-") {
		return ModelsActionResult{}, opError("invalid_reference",
			"A model reference cannot begin with a dash.", nil, nil)
	}
	if len(reference) > 512 {
		return ModelsActionResult{}, opError("invalid_reference",
			"A model reference must be 512 characters or fewer.", nil, nil)
	}

	if params.Action == "pull" {
		return s.modelPull(parent, params, emit)
	}

	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()

	argv := []string{"model"}
	switch params.Action {
	case "remove":
		argv = append(argv, "rm", "--", reference)
	case "unload":
		if reference == "" {
			argv = append(argv, "unload", "--all")
		} else {
			argv = append(argv, "unload", "--", reference)
		}
	}

	started := time.Now().UTC()
	run, err := s.runDockerValidated(ctx, contextName, argv, modelsOutputLimit)
	completed := time.Now().UTC()
	receipt := DomainOperationReceipt{
		Context: contextName, Domain: "model", ResourceID: reference,
		Action: params.Action, Source: "cli", Outcome: "failed",
		StartedAt:   started.Format(time.RFC3339Nano),
		CompletedAt: completed.Format(time.RFC3339Nano),
		DurationMs:  completed.Sub(started).Milliseconds(),
	}
	if err != nil {
		emitDomainCompleted(emit, receipt, err)
		return ModelsActionResult{}, err
	}
	exitCode := run.exitCode
	receipt.ExitCode = &exitCode
	receipt.Stdout = strings.TrimSpace(string(run.stdout))
	receipt.Stderr = strings.TrimSpace(string(run.stderr))
	if run.exitCode != 0 {
		if modelsUnavailable(receipt.Stderr) {
			pluginErr := modelsPluginError(receipt.Stderr)
			emitDomainCompleted(emit, receipt, pluginErr)
			return ModelsActionResult{}, pluginErr
		}
		actionErr := opError("models_action_failed",
			"Docker CLI could not complete the model action.", nil,
			map[string]any{"action": params.Action, "exitCode": run.exitCode, "stderr": receipt.Stderr})
		emitDomainCompleted(emit, receipt, actionErr)
		return ModelsActionResult{}, actionErr
	}
	receipt.Outcome = "succeeded"
	emitDomainCompleted(emit, receipt, nil)
	return ModelsActionResult{Action: params.Action, Receipt: receipt}, nil
}

func (s *Service) modelPull(parent context.Context, params ModelsActionParams, emit EventEmitter) (ModelsActionResult, error) {
	if params.Cwd == "" && len(s.allowedCWDs) > 0 {
		params.Cwd = s.allowedCWDs[0]
	}
	var operationID string
	wrappedEmit := func(event string, payload any) {
		if event == "session.started" {
			if typed, ok := payload.(SessionStartedEvent); ok {
				operationID = typed.SessionID
				emitDomainStarted(emit, "models.action", DomainOperationReceipt{
					OperationID: operationID, Context: params.Context, Domain: "model",
					ResourceID: params.Reference, Action: "pull", Source: "cli-session",
					Outcome: "running", StartedAt: typed.StartedAt,
				})
			}
		}
		if event == "session.exited" {
			if typed, ok := payload.(SessionExitedEvent); ok {
				receipt := DomainOperationReceipt{
					OperationID: operationID, Context: params.Context, Domain: "model",
					ResourceID: params.Reference, Action: "pull", Source: "cli-session",
					Outcome: "failed", ExitCode: &typed.ExitCode,
					StartedAt: typed.StartedAt, CompletedAt: typed.ExitedAt, DurationMs: typed.DurationMs,
				}
				var pullErr error
				reconciliationRequired := false
				if typed.ExitCode == 0 && !typed.Canceled && !typed.TimedOut {
					receipt.Outcome = "succeeded"
				} else if typed.Canceled || typed.TimedOut {
					// A cancelled model pull can leave a partial blob behind, so the outcome is
					// genuinely unknown rather than a clean failure.
					receipt.Outcome = "unknown"
					pullErr = opError("mutation_outcome_unknown",
						"The model pull session ended before a successful Docker exit; reconciliation is required.",
						nil, map[string]any{"receipt": receipt})
					reconciliationRequired = true
				} else {
					pullErr = opError("model_pull_failed", "Docker CLI model pull failed.", nil,
						map[string]any{"receipt": receipt})
				}
				emitDomainCompleted(emit, receipt, pullErr)
				emitReconciliation(emit, receipt, reconciliationRequired)
			}
		}
		if emit != nil {
			emit(event, payload)
		}
	}
	// Same rule as an image pull: the download outlives the request that began it and is
	// controlled through session.cancel and its own timeout.
	session, err := s.sessions.start(context.WithoutCancel(parent), SessionStartParams{
		Context: params.Context, Argv: []string{"model", "pull", "--", params.Reference},
		Cwd: params.Cwd, Mode: "pipes", TimeoutSeconds: params.TimeoutSeconds,
		OutputWindowBytes: params.OutputWindowBytes, MaxOutputBytes: params.MaxOutputBytes,
	}, wrappedEmit)
	if err != nil {
		return ModelsActionResult{}, err
	}
	if operationID == "" {
		operationID = session.SessionID
	}
	receipt := DomainOperationReceipt{
		OperationID: operationID, Context: params.Context, Domain: "model",
		ResourceID: params.Reference, Action: "pull", Source: "cli-session",
		Outcome: "running", StartedAt: session.StartedAt,
	}
	return ModelsActionResult{Action: "pull", Receipt: receipt, Session: &session}, nil
}
