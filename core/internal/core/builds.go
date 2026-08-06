package core

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"time"
)

// Buildx is an optional CLI plugin with no Engine API, like Compose and Scout, so every
// method here is CLI-routed and an absent plugin is a reportable state rather than a failure.
//
// It also frames its JSON two ways again: `history ls` emits one record per line while
// `buildx ls` emits builders as a stream of objects. Both are decoded explicitly.

const (
	// History accumulates indefinitely; a screen shows the recent past, not an archive.
	maxBuildRecords = 200
	buildsTimeout   = 60 * time.Second
)

type buildRecordJSON struct {
	Ref            string `json:"ref"`
	Name           string `json:"name"`
	Status         string `json:"status"`
	CreatedAt      string `json:"created_at"`
	CompletedAt    string `json:"completed_at"`
	TotalSteps     int    `json:"total_steps"`
	CompletedSteps int    `json:"completed_steps"`
	CachedSteps    int    `json:"cached_steps"`
}

// buildRecordID reduces the reference `history ls` reports to the identifier `history
// inspect` accepts. They are not the same value: ls returns `builder/node/id` and inspect
// rejects it outright, which is the kind of mismatch that silently yields an empty detail
// pane rather than an error.
func buildRecordID(ref string) string {
	trimmed := strings.TrimSpace(ref)
	if index := strings.LastIndex(trimmed, "/"); index >= 0 {
		return trimmed[index+1:]
	}
	return trimmed
}

// validateBuildRef constrains the identifier before it becomes an argv element. Buildx record
// ids are lowercase alphanumeric; accepting the full slash-separated reference too means the
// renderer can pass back exactly what it was given.
func validateBuildRef(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 256 {
		return "", opError("invalid_build_ref",
			"Build reference must contain between 1 and 256 characters.", nil, nil)
	}
	// Every segment is checked, not just the one that survives reduction. Validating only the
	// extracted id would quietly turn "../../etc" into "etc" and accept it — a different value
	// than the caller asked for, which is worse than a rejection.
	for _, segment := range strings.Split(value, "/") {
		if segment == "" {
			return "", opError("invalid_build_ref",
				"Build reference contains an empty segment.", nil, map[string]any{"ref": raw})
		}
		for index, char := range segment {
			alphanumeric := char >= 'a' && char <= 'z' ||
				char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
			// Separators are permitted inside a segment, because builder names use them —
			// but never first. A leading '-' is what turns the value into a flag.
			separator := index > 0 && (char == '-' || char == '_' || char == '.')
			if !alphanumeric && !separator {
				return "", opError("invalid_build_ref",
					"Build reference contains unsupported characters.", nil,
					map[string]any{"ref": raw})
			}
		}
	}
	return buildRecordID(value), nil
}

func normalizeBuildStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed":
		return "success"
	case "error", "failed":
		return "failed"
	case "canceled", "cancelled":
		return "cancelled"
	case "running":
		return "running"
	default:
		return "unknown"
	}
}

// decodeStreamedJSON reads either a JSON array or one object per line into out.
//
// Buildx uses both framings depending on the subcommand, exactly as Compose does. Guessing
// wrong yields an empty list rather than an error, so a Builds screen would simply look as
// though nothing had ever been built.
func decodeStreamedJSON(stdout []byte, decode func(json.RawMessage) error) error {
	trimmed := bytes.TrimSpace(stdout)
	if len(trimmed) == 0 {
		return nil
	}
	if trimmed[0] == '[' {
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return err
		}
		for _, item := range items {
			if err := decode(item); err != nil {
				return err
			}
		}
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	for {
		var item json.RawMessage
		if err := decoder.Decode(&item); err != nil {
			if err.Error() == "EOF" {
				return nil
			}
			return err
		}
		if err := decode(item); err != nil {
			return err
		}
	}
}

func buildxUnavailable(stderr string) bool {
	return strings.Contains(stderr, "is not a docker command") ||
		strings.Contains(stderr, "unknown command")
}

func (s *Service) buildsList(parent context.Context, params BuildsListParams) (BuildsListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return BuildsListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, buildsTimeout)
	defer cancel()

	result, err := s.runDockerValidated(ctx, contextName,
		[]string{"buildx", "history", "ls", "--format", "json", "--no-trunc"},
		domainCLIOutputLimit)
	if err != nil {
		return BuildsListResult{}, err
	}
	if result.exitCode != 0 {
		stderr := strings.TrimSpace(string(result.stderr))
		if buildxUnavailable(stderr) {
			return BuildsListResult{}, opError("buildx_unavailable",
				"The Docker Buildx plugin is not installed for this Docker CLI.", nil,
				map[string]any{"stderr": stderr})
		}
		return BuildsListResult{}, opError("builds_list_failed",
			"Docker Buildx could not list build records.", nil,
			map[string]any{"exitCode": result.exitCode, "stderr": stderr})
	}

	records := []BuildRecord{}
	truncated := false
	decodeErr := decodeStreamedJSON(result.stdout, func(raw json.RawMessage) error {
		if len(records) >= maxBuildRecords {
			truncated = true
			return nil
		}
		var item buildRecordJSON
		if err := json.Unmarshal(raw, &item); err != nil {
			return err
		}
		record := BuildRecord{
			ID: buildRecordID(item.Ref), Ref: item.Ref, Name: item.Name,
			Status: normalizeBuildStatus(item.Status), CreatedAt: item.CreatedAt,
			CompletedAt: item.CompletedAt, TotalSteps: item.TotalSteps,
			CompletedSteps: item.CompletedSteps, CachedSteps: item.CachedSteps,
		}
		if started, startErr := time.Parse(time.RFC3339Nano, item.CreatedAt); startErr == nil {
			if done, doneErr := time.Parse(time.RFC3339Nano, item.CompletedAt); doneErr == nil {
				record.DurationMs = done.Sub(started).Milliseconds()
			}
		}
		records = append(records, record)
		return nil
	})
	if decodeErr != nil {
		return BuildsListResult{}, opError("builds_list_invalid",
			"Docker Buildx returned invalid build record JSON.", decodeErr, nil)
	}

	builders, builderErr := s.buildxBuilders(ctx, contextName)
	if builders == nil {
		builders = []BuildBuilder{}
	}
	limitations := []string{}
	if builderErr != nil {
		// A missing builder inventory must not hide the build history, which is the part an
		// operator came for.
		limitations = append(limitations, "Builder inventory unavailable: "+builderErr.Error())
	}
	if truncated {
		limitations = append(limitations,
			"Showing the most recent build records; the history holds more.")
	}
	return BuildsListResult{
		Context: contextName, Source: "cli-json", Builders: builders, Records: records,
		ObservedAt: nowUTC(), Limitations: limitations,
	}, nil
}

type builderJSON struct {
	Name    string `json:"Name"`
	Driver  string `json:"Driver"`
	Current bool   `json:"Current"`
	Err     string `json:"Err"`
	Nodes   []struct {
		Name string `json:"Name"`
		// Platforms is a list, not the comma-joined string the table output suggests. It
		// decoded as a string in the first cut and silently failed the whole builder
		// inventory, which the list then reported as merely unavailable.
		Platforms []string `json:"Platforms"`
		Status    string   `json:"Status"`
		Version   string   `json:"Version"`
	} `json:"Nodes"`
}

func (s *Service) buildxBuilders(ctx context.Context, contextName string) ([]BuildBuilder, error) {
	result, err := s.runDockerValidated(ctx, contextName,
		[]string{"buildx", "ls", "--format", "json"}, domainCLIOutputLimit)
	if err != nil {
		return nil, err
	}
	if result.exitCode != 0 {
		return nil, opError("builders_list_failed",
			"Docker Buildx could not list builders.", nil,
			map[string]any{"stderr": strings.TrimSpace(string(result.stderr))})
	}
	builders := []BuildBuilder{}
	decodeErr := decodeStreamedJSON(result.stdout, func(raw json.RawMessage) error {
		var item builderJSON
		if err := json.Unmarshal(raw, &item); err != nil {
			return err
		}
		// Initialized rather than left nil: a nil slice marshals to null, and every caller
		// would then have to guard a field that is conceptually always a list.
		builder := BuildBuilder{
			Name: item.Name, Driver: item.Driver, Current: item.Current,
			Error: item.Err, Nodes: []BuildBuilderNode{},
		}
		for _, node := range item.Nodes {
			platforms := node.Platforms
			if platforms == nil {
				platforms = []string{}
			}
			builder.Nodes = append(builder.Nodes, BuildBuilderNode{
				Name: node.Name, Status: node.Status,
				Version: node.Version, Platforms: platforms,
			})
		}
		builders = append(builders, builder)
		return nil
	})
	if decodeErr != nil {
		return nil, opError("builders_list_invalid",
			"Docker Buildx returned invalid builder JSON.", decodeErr, nil)
	}
	return builders, nil
}

// The builder verbs this exposes. `use` is absent on purpose: it rewrites the CLI's own
// configuration for every tool on the machine, which the builders pane says out loud rather
// than offering. These three only reach what an operator needs for a builder buildx reports as
// unreachable — start it, or delete it by whichever route actually deletes it.
var builderActions = map[string]bool{"remove": true, "bootstrap": true, "remove-context": true}

// builderRemovals are the two verbs that destroy something and therefore need agreement.
var builderRemovals = map[string]bool{"remove": true, "remove-context": true}

// validateBuilderName constrains the name before it becomes an argv element. Deliberately the
// same shape as validateBuildRef, minus the slash segments a builder name never has.
func validateBuilderName(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 256 {
		return "", opError("invalid_builder_name",
			"Builder name must contain between 1 and 256 characters.", nil, nil)
	}
	for index, char := range value {
		alphanumeric := char >= 'a' && char <= 'z' ||
			char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
		// Separators belong inside a builder name — `desktop-linux` is Docker's own — but
		// never first: a leading '-' is what turns the value into a flag.
		separator := index > 0 && (char == '-' || char == '_' || char == '.')
		if !alphanumeric && !separator {
			return "", opError("invalid_builder_name",
				"Builder name contains unsupported characters.", nil, map[string]any{"name": raw})
		}
	}
	return value, nil
}

/*
builderFailureMessage names the verb that failed in the operator's terms.

Written out rather than interpolating the action, because "Docker Buildx could not remove-context
that builder" is not a sentence, and the context removal is not buildx's doing at all.
*/
func builderFailureMessage(action string) string {
	switch action {
	case "bootstrap":
		return "Docker Buildx could not start that builder."
	case "remove-context":
		return "Docker could not remove that context."
	default:
		return "Docker Buildx could not remove that builder."
	}
}

/*
stderrSummary puts Docker's own first line into the message.

The detail map already carries the whole of stderr, and every surface that shows one of these
errors shows the message. Leaving the reason only in the details is how "Docker Buildx could not
remove that builder" reached an operator whose actual problem — that buildx refuses to remove a
context builder and names the command that does — was sitting one field away, unread.

The first line only: buildx follows a specific failure with a generic "ERROR: failed to remove one
or more builders", and appending that to the sentence adds nothing.
*/
func stderrSummary(stderr string) string {
	line := strings.TrimSpace(stderr)
	if index := strings.IndexByte(line, '\n'); index >= 0 {
		line = strings.TrimSpace(line[:index])
	}
	if line == "" {
		return ""
	}
	return strings.TrimPrefix(line, "ERROR: ")
}

/*
Acting on one builder.

The builders table could report an unreachable builder and do nothing about it, which left the
operator reading buildx's own error message beside a note telling them to go and run buildx by
hand. Both verbs here are that same buildx command, run through the fingerprinted binary.

`bootstrap` is `inspect --bootstrap`, which is how buildx starts a builder's node; it is the
repair for the ordinary "cannot reach" case, where the builder's container was removed or the
machine rebooted. `remove` is `buildx rm`, which clears a builder buildx owns.

`remove-context` is `docker context rm`, and it exists because `remove` cannot do this job.
Buildx synthesises a builder for every Docker context, and refuses to delete those:

	failed to remove desktop-linux: context builder cannot be removed,
	run `docker context rm desktop-linux` to remove this context

So the two entries a removed Docker Desktop leaves behind — `desktop-linux`, and `podman` from
a podman socket that is not running — could be listed, could be reported as unreachable, and
could not be removed by the one button offered, whatever the operator did. Buildx names the
remedy in its own error; this is that remedy, run through the same fingerprinted binary.

It removes a connection definition, not a machine: no container, image or volume is touched,
and recreating the context restores it. Docker refuses to remove the current context on its
own, so nothing here needs to guard the connection Anchorage is using.

Neither is given the operation-receipt machinery: they change buildx's own state rather than a
Docker resource the reconciler tracks, and the fresh inventory in the result is what the surface
needs to redraw.
*/
func (s *Service) builderAction(parent context.Context, params BuilderActionParams) (BuilderActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return BuilderActionResult{}, err
	}
	action := strings.TrimSpace(params.Action)
	if !builderActions[action] {
		return BuilderActionResult{}, opError("unsupported_builder_action",
			"Builder action is not in the mutation allowlist.", nil,
			map[string]any{"action": params.Action})
	}
	name, err := validateBuilderName(params.Name)
	if err != nil {
		return BuilderActionResult{}, err
	}
	// Removing a builder discards its build cache; removing a context discards the endpoint
	// definition. Neither is restored by anything, so both are agreed to first.
	if builderRemovals[action] && !params.Confirmed {
		return BuilderActionResult{}, confirmationRequired("builder", name, action)
	}
	// Confirmation belongs to the removals; accepting it for bootstrap would let a caller
	// believe they had agreed to something about a verb that destroys nothing.
	if !builderRemovals[action] && params.Confirmed {
		return BuilderActionResult{}, opError("invalid_action_options",
			"Confirmation is only valid for builder removal.", nil,
			map[string]any{"action": action})
	}

	var argv []string
	var outcome string
	switch action {
	case "bootstrap":
		// `--bootstrap` before the name: buildx takes the builder as a positional argument.
		argv, outcome = []string{"buildx", "inspect", "--bootstrap", name}, "bootstrapped"
	case "remove-context":
		argv, outcome = []string{"context", "rm", name}, "context-removed"
	default:
		argv, outcome = []string{"buildx", "rm", name}, "removed"
	}

	// Bootstrapping pulls and starts a BuildKit container on a cold machine, so this shares
	// the mutation budget rather than the read one.
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	result, err := s.runDockerValidated(ctx, contextName, argv, domainCLIOutputLimit)
	if err != nil {
		return BuilderActionResult{}, err
	}
	// Docker explains itself better than any wording here could — "cannot remove the default
	// builder", "failed to find driver", "context builder cannot be removed, run `docker
	// context rm ...`" — so its own output is carried rather than replaced. That last one is
	// how the missing verb above was found in the first place.
	output := strings.TrimSpace(string(result.stdout))
	stderr := strings.TrimSpace(string(result.stderr))
	if result.exitCode != 0 {
		return BuilderActionResult{}, opError("builder_action_failed",
			builderFailureMessage(action)+" "+stderrSummary(stderr), nil,
			map[string]any{"builder": name, "action": action,
				"exitCode": result.exitCode, "stderr": stderr})
	}
	if output == "" {
		output = stderr
	}

	// The inventory is re-read even when the action succeeded: removing the current builder
	// promotes another one, which the caller has no way to derive.
	builders, listErr := s.buildxBuilders(ctx, contextName)
	if listErr != nil {
		builders = []BuildBuilder{}
	}
	return BuilderActionResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Name:            name,
		Action:          action,
		Outcome:         outcome,
		Output:          output,
		Builders:        builders,
		ObservedAt:      nowUTC(),
	}, nil
}

type buildInspectJSON struct {
	Name              string `json:"Name"`
	Ref               string `json:"Ref"`
	Context           string `json:"Context"`
	Dockerfile        string `json:"Dockerfile"`
	VCSRepository     string `json:"VCSRepository"`
	VCSRevision       string `json:"VCSRevision"`
	StartedAt         string `json:"StartedAt"`
	CompletedAt       string `json:"CompletedAt"`
	Duration          int64  `json:"Duration"`
	Status            string `json:"Status"`
	NumTotalSteps     int    `json:"NumTotalSteps"`
	NumCachedSteps    int    `json:"NumCachedSteps"`
	NumCompletedSteps int    `json:"NumCompletedSteps"`
	Materials         []struct {
		URI string `json:"URI"`
	} `json:"Materials"`
}

func (s *Service) buildsInspect(parent context.Context, params BuildsInspectParams) (BuildsInspectResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return BuildsInspectResult{}, err
	}
	// `history ls` reports builder/node/id but `history inspect` accepts only the id.
	id, err := validateBuildRef(params.Ref)
	if err != nil {
		return BuildsInspectResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, buildsTimeout)
	defer cancel()

	result, err := s.runDockerValidated(ctx, contextName,
		[]string{"buildx", "history", "inspect", id, "--format", "json"},
		domainCLIOutputLimit)
	if err != nil {
		return BuildsInspectResult{}, err
	}
	if result.exitCode != 0 {
		return BuildsInspectResult{}, opError("build_inspect_failed",
			"Docker Buildx could not read that build record.", nil,
			map[string]any{"ref": id, "stderr": strings.TrimSpace(string(result.stderr))})
	}
	var raw buildInspectJSON
	if err := json.Unmarshal(bytes.TrimSpace(result.stdout), &raw); err != nil {
		return BuildsInspectResult{}, opError("build_inspect_invalid",
			"Docker Buildx returned invalid build detail JSON.", err, nil)
	}
	materials := []string{}
	for _, material := range raw.Materials {
		materials = append(materials, material.URI)
	}
	return BuildsInspectResult{
		Context: contextName, ID: id, Name: raw.Name,
		BuildContext: raw.Context, Dockerfile: raw.Dockerfile,
		VCSRepository: raw.VCSRepository, VCSRevision: raw.VCSRevision,
		StartedAt: raw.StartedAt, CompletedAt: raw.CompletedAt,
		DurationMs: raw.Duration / int64(time.Millisecond),
		Status:     normalizeBuildStatus(raw.Status),
		TotalSteps: raw.NumTotalSteps, CachedSteps: raw.NumCachedSteps,
		CompletedSteps: raw.NumCompletedSteps,
		Materials:      materials, ObservedAt: nowUTC(),
	}, nil
}
