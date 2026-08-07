package core

import (
	"bytes"
	"context"
	"encoding/json"
	"sort"
	"strings"
)

// `compose config` renders the whole resolved model, which is far larger than any screen can
// use. These structures name only the parts the projection carries, so a field that is never
// projected is never even decoded — the operator's environment above all, which Compose
// resolves into every service unless told not to.
type composeConfigDocument struct {
	Name     string                           `json:"name"`
	Services map[string]composeConfigService  `json:"services"`
	Volumes  map[string]composeConfigResource `json:"volumes"`
	Secrets  map[string]composeConfigResource `json:"secrets"`
}

type composeConfigResource struct {
	// Name is the Docker-side name, which for a non-external resource is the project prefix
	// plus the key: the volume `data` becomes `storefront_data`.
	Name     string `json:"name"`
	External bool   `json:"external"`
	Driver   string `json:"driver"`
}

type composeConfigService struct {
	Image    string   `json:"image"`
	Profiles []string `json:"profiles"`
	// User is the service's own; a hook without a user of its own inherits it.
	User      string                             `json:"user"`
	DependsOn map[string]composeConfigDependency `json:"depends_on"`
	Develop   *struct {
		Watch []composeConfigWatch `json:"watch"`
	} `json:"develop"`
	PostStart []composeConfigHook      `json:"post_start"`
	PreStop   []composeConfigHook      `json:"pre_stop"`
	Volumes   []composeConfigMount     `json:"volumes"`
	Secrets   []composeConfigSecretRef `json:"secrets"`
	// A service may reference a model by list or by map; Compose renders both as a map whose
	// values are null in the list form.
	Models   map[string]*composeConfigModelRef `json:"models"`
	Provider *composeConfigProvider            `json:"provider"`
}

type composeConfigDependency struct {
	Condition string `json:"condition"`
	Restart   bool   `json:"restart"`
	Required  bool   `json:"required"`
}

type composeConfigWatch struct {
	Path    string   `json:"path"`
	Action  string   `json:"action"`
	Target  string   `json:"target"`
	Ignore  []string `json:"ignore"`
	Include []string `json:"include"`
	Exec    *struct {
		Command []string `json:"command"`
	} `json:"exec"`
}

type composeConfigHook struct {
	Command    []string `json:"command"`
	User       string   `json:"user"`
	Privileged bool     `json:"privileged"`
	WorkingDir string   `json:"working_dir"`
}

type composeConfigMount struct {
	Type   string `json:"type"`
	Source string `json:"source"`
}

type composeConfigSecretRef struct {
	Source string `json:"source"`
}

type composeConfigModelRef struct {
	EndpointVar string `json:"endpoint_var"`
	ModelVar    string `json:"model_var"`
}

type composeConfigProvider struct {
	// Type names the provider Compose hands the service to instead of running a container.
	// Its options are deliberately not read: they are provider-defined and can carry
	// credentials, and the type is what identifies the dependency.
	Type string `json:"type"`
}

func validateComposeConfig(params ComposeConfigParams) error {
	if err := validateComposeProject(strings.TrimSpace(params.Project)); err != nil {
		return err
	}
	// Unlike `stop` or `down`, `config` cannot find a project by label: it renders files, and
	// with none it fails with "no configuration file provided".
	if len(params.ConfigFiles) == 0 {
		return opError("invalid_compose_file",
			"Resolving a Compose configuration requires the project's configuration files.", nil, nil)
	}
	if len(params.ConfigFiles) > 32 {
		return opError("invalid_compose_file",
			"Compose config accepts at most 32 configuration files.", nil, nil)
	}
	for _, file := range params.ConfigFiles {
		if err := validateComposeConfigFile(file); err != nil {
			return err
		}
	}
	return nil
}

// composeConfig resolves a project's configuration and projects the parts a screen can act
// on: what waits for what, what Compose watches, what it runs around a container's life, and
// what the project declares but does not run.
//
// It is a read, so it runs like `compose ls` rather than like `up`: one bounded CLI call
// against the pinned context, no session and no receipt.
func (s *Service) composeConfig(parent context.Context, params ComposeConfigParams) (ComposeConfigResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ComposeConfigResult{}, err
	}
	params.Project = strings.TrimSpace(params.Project)
	if err := validateComposeConfig(params); err != nil {
		return ComposeConfigResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()

	argv := []string{"compose", "--project-name", params.Project}
	for _, file := range params.ConfigFiles {
		argv = append(argv, "--file", file)
	}
	// --no-env-resolution: this projection carries no environment, and resolving env_file
	// would pull the operator's secrets through the core for nothing. Interpolation stays on,
	// because it decides the values the projection does carry.
	argv = append(argv, "config", "--format", "json", "--no-env-resolution")

	result, err := s.runDockerValidated(ctx, contextName, argv, domainCLIOutputLimit)
	if err != nil {
		return ComposeConfigResult{}, err
	}
	stderr := strings.TrimSpace(string(result.stderr))
	if result.exitCode != 0 {
		// Compose is an optional CLI plugin. Saying so is more useful than a generic failure,
		// because the operator's fix is to install it, not to retry.
		if dockerPluginMissing(stderr) {
			return ComposeConfigResult{}, opError("compose_unavailable",
				"The Docker Compose plugin is not installed for this Docker CLI.", nil,
				map[string]any{"stderr": stderr})
		}
		return ComposeConfigResult{}, opError("compose_config_failed",
			"Docker Compose could not resolve the project configuration.", nil,
			map[string]any{"exitCode": result.exitCode, "project": params.Project, "stderr": stderr})
	}

	document, err := decodeComposeConfig(result.stdout)
	if err != nil {
		return ComposeConfigResult{}, err
	}
	services, cyclic := projectComposeServices(document.Services)
	projected := ComposeConfigResult{
		Context: contextName, Project: params.Project, Source: "cli-json",
		ConfigFiles:  append([]string(nil), params.ConfigFiles...),
		Services:     services,
		Dependencies: projectComposeDependencies(document),
		ObservedAt:   nowUTC(),
		// Compose resolves `include` before it renders anything: the included services are
		// merged into the list above and the include entries are dropped from the model, so
		// this projection reports them as the services they became rather than inventing them.
		Limitations: []string{
			"Compose merges included files before rendering, so services from an include appear inline and the include entries themselves are not reported.",
		},
	}
	if cyclic {
		projected.Limitations = append(projected.Limitations,
			"Declared dependencies contain a cycle, so the start order shown is not one Compose could follow.")
	}
	for _, dependency := range projected.Dependencies {
		if dependency.Kind == "model" {
			// Compose renders the top-level models section into YAML but not into JSON, so a
			// model's own configuration cannot be read back from this call.
			projected.Limitations = append(projected.Limitations,
				"Compose omits the top-level models section from its JSON rendering, so only the services that declare a model are reported, not the model's own configuration.")
			break
		}
	}
	projected.Limitations = append(projected.Limitations, composeConfigWarnings(stderr)...)
	return projected, nil
}

func decodeComposeConfig(stdout []byte) (composeConfigDocument, error) {
	trimmed := bytes.TrimSpace(stdout)
	if len(trimmed) == 0 {
		return composeConfigDocument{}, opError("compose_config_invalid",
			"Docker Compose returned no configuration.", nil, nil)
	}
	var document composeConfigDocument
	if err := json.Unmarshal(trimmed, &document); err != nil {
		return composeConfigDocument{}, opError("compose_config_invalid",
			"Docker Compose returned invalid configuration JSON.", err, nil)
	}
	return document, nil
}

// composeConfigWarnings carries Compose's own warnings through as limitations. They are the
// difference between a value the file states and one Compose substituted — an unset variable
// defaulting to a blank string changes the image a service will run.
func composeConfigWarnings(stderr string) []string {
	if stderr == "" {
		return nil
	}
	warnings := make([]string, 0, 4)
	seen := map[string]bool{}
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || seen[line] {
			continue
		}
		seen[line] = true
		warnings = append(warnings, line)
		if len(warnings) == 8 {
			break
		}
	}
	return warnings
}

func projectComposeServices(services map[string]composeConfigService) ([]ComposeConfigService, bool) {
	order, cyclic := composeStartOrder(services)
	projected := make([]ComposeConfigService, 0, len(services))
	for name, service := range services {
		entry := ComposeConfigService{
			Name: name, Image: service.Image, Profiles: service.Profiles,
			StartOrder: order[name],
			DependsOn:  make([]ComposeDependsOn, 0, len(service.DependsOn)),
			Watch:      []ComposeWatchRule{},
			Hooks:      []ComposeLifecycleHook{},
		}
		for dependency, terms := range service.DependsOn {
			entry.DependsOn = append(entry.DependsOn, ComposeDependsOn{
				Service: dependency, Condition: terms.Condition,
				Restart: terms.Restart, Required: terms.Required,
			})
		}
		sort.Slice(entry.DependsOn, func(i, j int) bool {
			return entry.DependsOn[i].Service < entry.DependsOn[j].Service
		})
		if service.Develop != nil {
			for _, rule := range service.Develop.Watch {
				projectedRule := ComposeWatchRule{
					Path: rule.Path, Action: rule.Action, Target: rule.Target,
					Ignore: rule.Ignore, Include: rule.Include,
				}
				if rule.Exec != nil {
					projectedRule.Command = rule.Exec.Command
				}
				entry.Watch = append(entry.Watch, projectedRule)
			}
		}
		entry.Hooks = append(entry.Hooks, projectComposeHooks("post_start", service.User, service.PostStart)...)
		entry.Hooks = append(entry.Hooks, projectComposeHooks("pre_stop", service.User, service.PreStop)...)
		projected = append(projected, entry)
	}
	// Compose renders services as a map, so an unsorted projection would reorder itself
	// between two reads of the same project. Start order first, because that is the sequence
	// the screen exists to show.
	sort.Slice(projected, func(i, j int) bool {
		if projected[i].StartOrder != projected[j].StartOrder {
			return projected[i].StartOrder < projected[j].StartOrder
		}
		return projected[i].Name < projected[j].Name
	})
	return projected, cyclic
}

func projectComposeHooks(phase, serviceUser string, hooks []composeConfigHook) []ComposeLifecycleHook {
	projected := make([]ComposeLifecycleHook, 0, len(hooks))
	for _, hook := range hooks {
		user := hook.User
		if user == "" {
			user = serviceUser
		}
		projected = append(projected, ComposeLifecycleHook{
			Phase: phase, Command: hook.Command, User: user,
			RunsAsRoot: composeUserIsRoot(user), Privileged: hook.Privileged,
			WorkingDir: hook.WorkingDir,
		})
	}
	return projected
}

// composeUserIsRoot answers only for a user the file actually states. Docker accepts a name
// or a numeric uid, optionally with a group, so all three spellings of root are recognised;
// an unstated user is not root here, because what it resolves to lives in the image.
func composeUserIsRoot(user string) bool {
	if user == "" {
		return false
	}
	if identity, _, found := strings.Cut(user, ":"); found {
		user = identity
	}
	return user == "root" || user == "0"
}

// composeStartOrder ranks each service by the depth of the dependencies it declares: Compose
// brings a service up only once everything it depends on is up, so the rank is the order an
// operator watches the project start in. Compose rejects a cyclic depends_on, but the walk
// detects one rather than trusting that, because a cycle here would not terminate.
func composeStartOrder(services map[string]composeConfigService) (map[string]int, bool) {
	order := make(map[string]int, len(services))
	visited := make(map[string]bool, len(services))
	active := make(map[string]bool, len(services))
	cyclic := false
	var rank func(name string) int
	rank = func(name string) int {
		if active[name] {
			cyclic = true
			return 0
		}
		if visited[name] {
			return order[name]
		}
		active[name] = true
		depth := 0
		for dependency := range services[name].DependsOn {
			if _, declared := services[dependency]; !declared {
				// depends_on may name a service this project does not define; Compose refuses
				// to start it, but it cannot be ranked either way.
				continue
			}
			if candidate := rank(dependency) + 1; candidate > depth {
				depth = candidate
			}
		}
		active[name] = false
		visited[name] = true
		order[name] = depth
		return depth
	}
	for name := range services {
		rank(name)
	}
	return order, cyclic
}

// projectComposeDependencies collects what the project declares but does not run, keyed by
// kind, with the services that reference each one so the UI can draw the edge.
func projectComposeDependencies(document composeConfigDocument) []ComposeDeclaredDependency {
	index := map[string]*ComposeDeclaredDependency{}
	key := func(kind, name string) string { return kind + "\x00" + name }
	declare := func(kind, name, resource string, external bool) *ComposeDeclaredDependency {
		existing, found := index[key(kind, name)]
		if found {
			return existing
		}
		entry := &ComposeDeclaredDependency{
			Kind: kind, Name: name, Resource: resource, External: external,
			Services: []string{},
		}
		index[key(kind, name)] = entry
		return entry
	}
	// A service can mount the same volume at two targets, so an edge is recorded once.
	referenced := map[string]bool{}
	reference := func(kind, name, resource string, external bool, service string) {
		entry := declare(kind, name, resource, external)
		if edge := key(kind, name) + "\x00" + service; !referenced[edge] {
			referenced[edge] = true
			entry.Services = append(entry.Services, service)
		}
	}

	for name, volume := range document.Volumes {
		declare("volume", name, volume.Name, volume.External)
	}
	for name, secret := range document.Secrets {
		declare("secret", name, secret.Name, secret.External)
	}
	for serviceName, service := range document.Services {
		for _, mount := range service.Volumes {
			// A bind or tmpfs mount is not a declared dependency; only a named volume is.
			if mount.Type == "volume" && mount.Source != "" {
				reference("volume", mount.Source, "", false, serviceName)
			}
		}
		for _, secret := range service.Secrets {
			if secret.Source != "" {
				reference("secret", secret.Source, "", false, serviceName)
			}
		}
		for model := range service.Models {
			reference("model", model, "", false, serviceName)
		}
		if service.Provider != nil {
			reference("provider", serviceName, service.Provider.Type, false, serviceName)
		}
	}

	dependencies := make([]ComposeDeclaredDependency, 0, len(index))
	for _, entry := range index {
		sort.Strings(entry.Services)
		dependencies = append(dependencies, *entry)
	}
	sort.Slice(dependencies, func(i, j int) bool {
		if dependencies[i].Kind != dependencies[j].Kind {
			return dependencies[i].Kind < dependencies[j].Kind
		}
		return dependencies[i].Name < dependencies[j].Name
	})
	return dependencies
}
