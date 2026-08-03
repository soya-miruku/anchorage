package core

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// Compose project names become an argv element and a label selector. Compose itself
// normalizes to this shape, so anything outside it could not have produced a project.
const maxComposeProjectLength = 255

var composeActions = map[string]bool{
	"up": true, "down": true, "start": true, "stop": true, "restart": true,
}

func validateComposeProject(name string) error {
	if name == "" || len(name) > maxComposeProjectLength {
		return opError("invalid_compose_project",
			"Compose project name must contain between 1 and 255 characters.", nil, nil)
	}
	for index, char := range name {
		lower := char >= 'a' && char <= 'z'
		digit := char >= '0' && char <= '9'
		// Compose lowercases project names; the leading character cannot be punctuation.
		if lower || digit || (index > 0 && (char == '_' || char == '-' || char == '.')) {
			continue
		}
		return opError("invalid_compose_project",
			"Compose project name contains unsupported characters.", nil,
			map[string]any{"project": name})
	}
	return nil
}

// validateComposeConfigFile checks a path that `up` passes to `-f`. The value normally comes
// straight back from `compose ls`, but it still crosses the RPC boundary, so it is checked
// here rather than trusted for having been ours once.
func validateComposeConfigFile(path string) error {
	if path == "" || len(path) > 4096 {
		return opError("invalid_compose_file",
			"Compose file path must contain between 1 and 4096 characters.", nil, nil)
	}
	if strings.HasPrefix(path, "-") {
		return opError("invalid_compose_file",
			"Compose file path must not begin with '-'.", nil, nil)
	}
	if strings.ContainsAny(path, "\x00\r\n") {
		return opError("invalid_compose_file",
			"Compose file path contains a control character.", nil, nil)
	}
	return nil
}

// parseComposeStatus turns Compose's own summary — "exited(3), running(19)" — into terms.
// The UI needs the counts to say anything useful about a project, and re-parsing a display
// string in the renderer would put the same fragile assumption in two places.
func parseComposeStatus(status string) []ComposeStateCount {
	terms := make([]ComposeStateCount, 0, 4)
	for _, part := range strings.Split(status, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		open := strings.LastIndex(part, "(")
		if open <= 0 || !strings.HasSuffix(part, ")") {
			// An unrecognized term is still reported, with an unknown count, rather than
			// dropped: a project whose status Compose words differently must not vanish.
			terms = append(terms, ComposeStateCount{State: part, Count: -1})
			continue
		}
		count, err := strconv.Atoi(part[open+1 : len(part)-1])
		if err != nil {
			count = -1
		}
		terms = append(terms, ComposeStateCount{State: part[:open], Count: count})
	}
	return terms
}

type composeProjectRecord struct {
	Name        string `json:"Name"`
	Status      string `json:"Status"`
	ConfigFiles string `json:"ConfigFiles"`
}

func (s *Service) composeList(parent context.Context, params ComposeListParams) (ComposeListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ComposeListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()

	args := withContext(contextName, "compose", "ls", "--format", "json")
	if params.All {
		args = append(args, "--all")
	}
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
	if err != nil {
		return ComposeListResult{}, err
	}
	if result.exitCode != 0 {
		stderr := strings.TrimSpace(string(result.stderr))
		// Compose is an optional CLI plugin. Saying so is more useful than a generic failure,
		// because the operator's fix is to install it, not to retry.
		if strings.Contains(stderr, "is not a docker command") ||
			strings.Contains(stderr, "unknown command") {
			return ComposeListResult{}, opError("compose_unavailable",
				"The Docker Compose plugin is not installed for this Docker CLI.", nil,
				map[string]any{"stderr": stderr})
		}
		return ComposeListResult{}, opError("compose_list_failed",
			"Docker CLI could not list Compose projects.", nil,
			map[string]any{"exitCode": result.exitCode, "stderr": stderr})
	}

	// `compose ls` frames its output as a single JSON array, unlike `compose ps`.
	trimmed := bytes.TrimSpace(result.stdout)
	records := []composeProjectRecord{}
	if len(trimmed) > 0 {
		if err := json.Unmarshal(trimmed, &records); err != nil {
			return ComposeListResult{}, opError("compose_list_invalid",
				"Docker Compose returned invalid project JSON.", err, nil)
		}
	}

	projects := make([]ComposeProject, 0, len(records))
	for _, record := range records {
		states := parseComposeStatus(record.Status)
		project := ComposeProject{
			Name:        record.Name,
			Status:      record.Status,
			States:      states,
			ConfigFiles: splitComposeConfigFiles(record.ConfigFiles),
		}
		for _, term := range states {
			if term.Count < 0 {
				continue
			}
			project.TotalCount += term.Count
			if term.State == "running" {
				project.RunningCount += term.Count
			}
		}
		projects = append(projects, project)
	}

	limitations := []string{}
	if !params.All {
		limitations = append(limitations,
			"Only projects with at least one existing container are listed; pass all to include fully stopped projects.")
	}
	return ComposeListResult{
		Context: contextName, Source: "cli-json", Projects: projects,
		ObservedAt: nowUTC(), Limitations: limitations,
	}, nil
}

// splitComposeConfigFiles unpacks the comma-joined list Compose reports. A path containing a
// comma cannot be recovered from this format; Compose provides no alternative, so such a
// project simply cannot be brought up from here and says so rather than guessing.
func splitComposeConfigFiles(joined string) []string {
	files := []string{}
	for _, part := range strings.Split(joined, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			files = append(files, part)
		}
	}
	return files
}

type composeServiceRecord struct {
	Name     string `json:"Name"`
	Service  string `json:"Service"`
	ID       string `json:"ID"`
	Image    string `json:"Image"`
	State    string `json:"State"`
	Status   string `json:"Status"`
	Health   string `json:"Health"`
	ExitCode int    `json:"ExitCode"`
	Ports    string `json:"Ports"`
}

func (s *Service) composePs(parent context.Context, params ComposePsParams) (ComposePsResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ComposePsResult{}, err
	}
	project := strings.TrimSpace(params.Project)
	if err := validateComposeProject(project); err != nil {
		return ComposePsResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()

	args := withContext(contextName, "compose", "--project-name", project, "ps",
		"--all", "--format", "json")
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
	if err != nil {
		return ComposePsResult{}, err
	}
	if result.exitCode != 0 {
		return ComposePsResult{}, opError("compose_ps_failed",
			"Docker CLI could not list Compose services.", nil,
			map[string]any{"exitCode": result.exitCode, "project": project,
				"stderr": strings.TrimSpace(string(result.stderr))})
	}

	// Unlike `compose ls`, `compose ps` emits one JSON object per line. Older plugin builds
	// emit a single array instead, so both framings are accepted.
	services, err := decodeComposeServices(result.stdout)
	if err != nil {
		return ComposePsResult{}, err
	}
	return ComposePsResult{
		Context: contextName, Project: project, Source: "cli-json",
		Services: services, ObservedAt: nowUTC(), Limitations: []string{},
	}, nil
}

func decodeComposeServices(stdout []byte) ([]ComposeService, error) {
	trimmed := bytes.TrimSpace(stdout)
	services := []ComposeService{}
	if len(trimmed) == 0 {
		return services, nil
	}
	records := []composeServiceRecord{}
	if trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &records); err != nil {
			return nil, opError("compose_ps_invalid",
				"Docker Compose returned invalid service JSON.", err, nil)
		}
	} else {
		scanner := bufio.NewScanner(bytes.NewReader(trimmed))
		scanner.Buffer(make([]byte, 0, 64*1024), domainCLIOutputLimit)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 {
				continue
			}
			var record composeServiceRecord
			if err := json.Unmarshal(line, &record); err != nil {
				return nil, opError("compose_ps_invalid",
					"Docker Compose returned invalid service JSON.", err, nil)
			}
			records = append(records, record)
		}
		if err := scanner.Err(); err != nil {
			return nil, opError("compose_ps_invalid",
				"Docker Compose service output could not be read.", err, nil)
		}
	}
	for _, record := range records {
		services = append(services, ComposeService{
			Name: record.Name, Service: record.Service, ContainerID: record.ID,
			Image: record.Image, State: record.State, Status: record.Status,
			Health: record.Health, ExitCode: record.ExitCode, Ports: record.Ports,
		})
	}
	return services, nil
}

func validateComposeAction(params ComposeActionParams) error {
	if !composeActions[params.Action] {
		return opError("invalid_compose_action", "Compose action is not supported.", nil,
			map[string]any{"action": params.Action})
	}
	if err := validateComposeProject(strings.TrimSpace(params.Project)); err != nil {
		return err
	}
	switch params.Action {
	case "up":
		// Compose locates existing containers by label, but recreating them needs the file
		// that defines them. Without it `up` fails with "no configuration file provided".
		if len(params.ConfigFiles) == 0 {
			return opError("invalid_action_options",
				"Compose up requires the project's configuration files.", nil, nil)
		}
		if len(params.ConfigFiles) > 32 {
			return opError("invalid_action_options",
				"Compose up accepts at most 32 configuration files.", nil, nil)
		}
		for _, file := range params.ConfigFiles {
			if err := validateComposeConfigFile(file); err != nil {
				return err
			}
		}
		if params.Confirmed || params.RemoveVolumes {
			return opError("invalid_action_options",
				"Compose up received options for another action.", nil, nil)
		}
	case "down":
		if !params.Confirmed {
			return confirmationRequired("compose", params.Project, params.Action)
		}
		if len(params.ConfigFiles) > 0 {
			return opError("invalid_action_options",
				"Compose down finds the project by label and takes no configuration files.", nil, nil)
		}
	default:
		if params.Confirmed || params.RemoveVolumes || params.RemoveOrphans ||
			len(params.ConfigFiles) > 0 {
			return opError("invalid_action_options",
				"Compose "+params.Action+" received options for another action.", nil, nil)
		}
	}
	return nil
}

// composeAction runs a Compose lifecycle verb as a cancellable session. `up` and `down` pull
// images and wait on health checks, so they routinely run for minutes and must stream rather
// than block a request.
func (s *Service) composeAction(parent context.Context, params ComposeActionParams, emit EventEmitter) (ComposeActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ComposeActionResult{}, err
	}
	params.Context = contextName
	params.Project = strings.TrimSpace(params.Project)
	if err := validateComposeAction(params); err != nil {
		return ComposeActionResult{}, err
	}

	argv := []string{"compose", "--project-name", params.Project}
	for _, file := range params.ConfigFiles {
		argv = append(argv, "--file", file)
	}
	argv = append(argv, params.Action)
	switch params.Action {
	case "up":
		// Detached: the session follows Compose's own progress output, and an attached run
		// would never exit, leaving the operation permanently "running".
		argv = append(argv, "--detach")
		if params.RemoveOrphans {
			argv = append(argv, "--remove-orphans")
		}
	case "down":
		if params.RemoveVolumes {
			argv = append(argv, "--volumes")
		}
		if params.RemoveOrphans {
			argv = append(argv, "--remove-orphans")
		}
	}

	cwd := s.defaultCWD
	if cwd == "" && len(s.allowedCWDs) > 0 {
		cwd = s.allowedCWDs[0]
	}
	session, err := s.sessions.start(context.WithoutCancel(parent), SessionStartParams{
		Context: contextName, Argv: argv, Cwd: cwd, Mode: "pipes",
		TimeoutSeconds:    params.TimeoutSeconds,
		OutputWindowBytes: params.OutputWindowBytes,
	}, emit)
	if err != nil {
		return ComposeActionResult{}, err
	}
	receipt := DomainOperationReceipt{
		OperationID: session.SessionID, Context: contextName, Domain: "compose",
		ResourceID: params.Project, Action: params.Action, Source: "cli-session",
		Outcome: "running", StartedAt: session.StartedAt,
	}
	return ComposeActionResult{
		Action: params.Action, Project: params.Project, Receipt: receipt, Session: &session,
	}, nil
}
