package core

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	discoveryCommandTimeout = 5 * time.Second
	inventoryCommandTimeout = 4 * time.Second
	inventoryMaxDepth       = 8
	inventoryMaxNodes       = 2048
	inventoryConcurrency    = 8
)

var inventoryHelpEnvironment = map[string]string{
	"CLICOLOR":    "0",
	"FORCE_COLOR": "0",
	"LANG":        "C",
	"LC_ALL":      "C",
	"NO_COLOR":    "1",
	"TERM":        "dumb",
}

type helpChild struct {
	name        string
	description string
	plugin      bool
}

type inventoryTask struct {
	node  *CommandNode
	depth int
}

func (s *Service) capabilities(ctx context.Context, params CapabilitiesParams) (CapabilitiesResult, error) {
	observedAt := nowUTC()
	result := CapabilitiesResult{
		ProtocolVersion: ProtocolVersion,
		Contexts:        []DockerContext{},
		Plugins:         []Plugin{},
		Capabilities:    map[string]CapabilityStatus{},
		Warnings:        []string{},
		ObservedAt:      observedAt,
	}
	if s.docker == nil {
		result.BinaryError = AsOpError(s.dockerErr)
		result.CommandInventory = emptyInventory("Docker CLI is unavailable.")
		for _, name := range []string{"compose", "scout", "buildx", "checkpoint"} {
			result.Capabilities[name] = CapabilityStatus{
				Name:       name,
				Status:     "unavailable",
				Reason:     "Docker CLI is unavailable.",
				Transports: []string{"cli"},
			}
		}
		return result, nil
	}
	binary := s.docker.binary
	result.Binary = &binary

	resolved := s.resolveContexts(ctx, binary, params.Context)
	result.Evidence.ContextShow = resolved.showEvidence
	result.Evidence.ContextList = resolved.listEvidence
	result.Contexts = resolved.contexts
	result.CurrentContext = resolved.current
	result.Warnings = append(result.Warnings, resolved.warnings...)
	if resolved.err != nil {
		return CapabilitiesResult{}, resolved.err
	}
	selected := resolved.selected
	result.SelectedContext = selected

	versionArgs := withContext(selected, "version", "--format", "{{json .}}")
	infoArgs := withContext(selected, "info", "--format", "{{json .}}")
	var versionResult, infoResult commandResult
	var versionErr, infoErr error
	var inventory CommandInventory
	var wait sync.WaitGroup
	wait.Add(3)
	go func() {
		defer wait.Done()
		versionResult, versionErr = s.runDiscovery(ctx, nil, versionArgs...)
	}()
	go func() {
		defer wait.Done()
		infoResult, infoErr = s.runDiscovery(ctx, nil, infoArgs...)
	}()
	go func() {
		defer wait.Done()
		inventory = s.commandInventory(ctx, binary, selected)
	}()
	wait.Wait()

	result.Evidence.Version = commandEvidence(binary.RealPath, versionArgs, versionResult)
	result.Evidence.Info = commandEvidence(binary.RealPath, infoArgs, infoResult)
	result.CommandInventory = inventory

	if versionErr != nil {
		result.Warnings = append(result.Warnings, "Docker version discovery failed to start: "+versionErr.Error())
	} else if versionResult.exitCode != 0 || versionResult.timedOut {
		result.Warnings = append(result.Warnings, evidenceFailure("docker version", versionResult))
	} else if err := parseVersion(versionResult.stdout, &result.Versions); err != nil {
		result.Warnings = append(result.Warnings, "Docker version output was not valid JSON: "+err.Error())
	}

	var info dockerInfo
	if infoErr != nil {
		result.Warnings = append(result.Warnings, "Docker info discovery failed to start: "+infoErr.Error())
	} else if infoResult.exitCode != 0 || infoResult.timedOut {
		result.Warnings = append(result.Warnings, evidenceFailure("docker info", infoResult))
	} else if err := json.Unmarshal(infoResult.stdout, &info); err != nil {
		result.Warnings = append(result.Warnings, "Docker info output was not valid JSON: "+err.Error())
	} else {
		result.ServerExperimental = info.ExperimentalBuild
		result.Plugins = convertPlugins(info.ClientInfo.Plugins)
	}

	result.APIMin = result.Versions.Server.MinAPIVersion
	if result.Versions.Client.APIVersion != "" || result.Versions.Server.APIVersion != "" {
		result.APIMax = negotiatedAPIVersion(result.Versions.Client.APIVersion, result.Versions.Server.APIVersion)
	}
	result.Plugins = mergeHelpPlugins(result.Plugins, result.CommandInventory.Root)

	for _, name := range []string{"compose", "scout", "buildx"} {
		result.Capabilities[name] = s.probePluginCapability(ctx, selected, name, result.CommandInventory.Root)
	}
	result.Capabilities["checkpoint"] = checkpointCapability(result.CommandInventory.Root, result.ServerExperimental)

	sort.Slice(result.Contexts, func(i, j int) bool { return result.Contexts[i].Name < result.Contexts[j].Name })
	sort.Slice(result.Plugins, func(i, j int) bool { return result.Plugins[i].Name < result.Plugins[j].Name })
	return result, nil
}

// resolvedContexts is what both context-aware discovery verbs need: the installed contexts,
// which one Docker considers current, and which one this call will act on.
type resolvedContexts struct {
	contexts     []DockerContext
	current      string
	selected     string
	warnings     []string
	showEvidence CommandEvidence
	listEvidence CommandEvidence
	err          error
}

// resolveContexts runs the two cheap context queries.
//
// Extracted from capabilities so system.contexts can answer the launch question — which
// contexts exist and which is current — without the recursive help walk and plugin probes that
// make capabilities a multi-second call. Both verbs resolve the selected context identically,
// which is what lets them agree on the inventory cache key.
func (s *Service) resolveContexts(
	ctx context.Context,
	binary BinaryFingerprint,
	requested string,
) resolvedContexts {
	resolved := resolvedContexts{contexts: []DockerContext{}, warnings: []string{}}

	showResult, showErr := s.runDiscovery(ctx, nil, "context", "show")
	resolved.showEvidence = commandEvidence(binary.RealPath, []string{"context", "show"}, showResult)
	if showErr != nil {
		resolved.warnings = append(resolved.warnings, "Current Docker context could not be queried: "+showErr.Error())
	} else if showResult.exitCode == 0 && !showResult.timedOut {
		resolved.current = strings.TrimSpace(string(showResult.stdout))
	} else {
		resolved.warnings = append(resolved.warnings, evidenceFailure("docker context show", showResult))
	}

	listArgs := []string{"context", "ls", "--format", "{{json .}}"}
	listResult, listErr := s.runDiscovery(ctx, nil, listArgs...)
	resolved.listEvidence = commandEvidence(binary.RealPath, listArgs, listResult)
	if listErr != nil {
		resolved.warnings = append(resolved.warnings, "Docker contexts could not be queried: "+listErr.Error())
	} else if listResult.exitCode == 0 && !listResult.timedOut {
		contexts, warnings := parseContextList(listResult.stdout)
		resolved.contexts = contexts
		resolved.warnings = append(resolved.warnings, warnings...)
		if resolved.current == "" {
			for _, item := range contexts {
				if item.Current {
					resolved.current = item.Name
					break
				}
			}
		}
	} else {
		resolved.warnings = append(resolved.warnings, evidenceFailure("docker context ls", listResult))
	}

	selected := strings.TrimSpace(requested)
	if selected == "" {
		selected = resolved.current
	}
	if selected == "" {
		selected = "default"
		resolved.warnings = append(resolved.warnings, "No current context was reported; discovery used the explicit fallback context \"default\".")
	}
	if err := validateContextName(selected); err != nil {
		resolved.err = err
		return resolved
	}
	resolved.selected = selected
	return resolved
}

// contexts answers only what a launch needs.
//
// The renderer cannot show anything until it knows which context to read, and that is two
// sub-100ms Docker calls. It used to get there through system.capabilities, which also walks
// every advertised command and probes every plugin - work that belongs to the Command Center
// and is measured in seconds. Splitting them means a slow help surface can no longer delay the
// window coming alive. This deliberately reports no capability or inventory data rather than
// reporting it as unknown: it did not look.
func (s *Service) contexts(ctx context.Context, params ContextsParams) (ContextsResult, error) {
	result := ContextsResult{
		ProtocolVersion: ProtocolVersion,
		Contexts:        []DockerContext{},
		Warnings:        []string{},
		ObservedAt:      nowUTC(),
	}
	if s.docker == nil {
		result.BinaryError = AsOpError(s.dockerErr)
		return result, nil
	}
	binary := s.docker.binary
	result.Binary = &binary

	resolved := s.resolveContexts(ctx, binary, params.Context)
	if resolved.err != nil {
		return ContextsResult{}, resolved.err
	}
	result.Contexts = resolved.contexts
	result.CurrentContext = resolved.current
	result.SelectedContext = resolved.selected
	result.Warnings = append(result.Warnings, resolved.warnings...)
	sort.Slice(result.Contexts, func(i, j int) bool { return result.Contexts[i].Name < result.Contexts[j].Name })
	return result, nil
}

func (s *Service) runDiscovery(parent context.Context, env map[string]string, args ...string) (commandResult, error) {
	ctx, cancel := context.WithTimeout(parent, discoveryCommandTimeout)
	defer cancel()
	return s.docker.run(ctx, args, s.defaultCWD, env, discoveryOutputLimit)
}

func (s *Service) discoverCommandInventory(ctx context.Context, selectedContext string) CommandInventory {
	inventory := CommandInventory{
		Complete:     true,
		MaxDepth:     inventoryMaxDepth,
		DiscoveredAt: nowUTC(),
		Warnings:     []string{},
	}
	root := &CommandNode{
		Path:        []string{},
		Name:        "docker",
		Kind:        "root",
		Transports:  []string{"cli"},
		Subcommands: []*CommandNode{},
	}
	inventory.Root = root
	current := []inventoryTask{{node: root, depth: 0}}
	inventory.NodeCount = 1

	for len(current) > 0 {
		results := make([][]helpChild, len(current))
		var wait sync.WaitGroup
		semaphore := make(chan struct{}, inventoryConcurrency)
		for index := range current {
			wait.Add(1)
			go func(index int) {
				defer wait.Done()
				semaphore <- struct{}{}
				results[index] = s.probeHelpNode(ctx, selectedContext, current[index].node)
				<-semaphore
			}(index)
		}
		wait.Wait()

		next := make([]inventoryTask, 0)
		for index, task := range current {
			if task.node.Status != "available" {
				inventory.Complete = false
				inventory.Warnings = append(inventory.Warnings, "Help probe failed for "+displayCommandPath(task.node.Path)+".")
				continue
			}
			if task.depth >= inventoryMaxDepth && len(results[index]) > 0 {
				inventory.Complete = false
				inventory.LimitReached = true
				inventory.Warnings = append(inventory.Warnings, "Command discovery reached the maximum depth at "+displayCommandPath(task.node.Path)+".")
				continue
			}
			for _, child := range results[index] {
				if inventory.NodeCount >= inventoryMaxNodes {
					inventory.Complete = false
					inventory.LimitReached = true
					break
				}
				path := append(append([]string{}, task.node.Path...), child.name)
				pluginRoot := task.node.PluginRoot
				kind := "builtin"
				if child.plugin && len(task.node.Path) == 0 {
					kind = "plugin"
					pluginRoot = child.name
				} else if pluginRoot != "" {
					kind = "plugin-command"
				}
				node := &CommandNode{
					Path:        path,
					Name:        child.name,
					Description: child.description,
					Kind:        kind,
					Transports:  transportsForCommand(path),
					PluginRoot:  pluginRoot,
					Subcommands: []*CommandNode{},
				}
				task.node.Subcommands = append(task.node.Subcommands, node)
				next = append(next, inventoryTask{node: node, depth: task.depth + 1})
				inventory.NodeCount++
			}
			sort.Slice(task.node.Subcommands, func(i, j int) bool {
				return task.node.Subcommands[i].Name < task.node.Subcommands[j].Name
			})
			if inventory.LimitReached {
				break
			}
		}
		if inventory.LimitReached {
			break
		}
		current = next
	}
	return inventory
}

func (s *Service) probeHelpNode(parent context.Context, selectedContext string, node *CommandNode) []helpChild {
	args := []string{"--context", selectedContext}
	args = append(args, node.Path...)
	args = append(args, "--help")
	ctx, cancel := context.WithTimeout(parent, inventoryCommandTimeout)
	defer cancel()
	result, err := s.docker.run(ctx, args, s.defaultCWD, inventoryHelpEnvironment, discoveryOutputLimit)
	if err != nil {
		node.Status = "unavailable"
		node.Reason = err.Error()
		node.Evidence = commandEvidence(s.docker.binary.RealPath, args, result)
		return nil
	}
	node.Evidence = commandEvidence(s.docker.binary.RealPath, args, result)
	return evaluateHelpResult(node, result)
}

func evaluateHelpResult(node *CommandNode, result commandResult) []helpChild {
	if result.timedOut {
		node.Status = "unavailable"
		node.Reason = "Help probe timed out."
		return nil
	}
	if result.stdoutTruncated || result.stderrTruncated {
		node.Status = "degraded"
		node.Reason = "Help output exceeded the evidence limit, so recursive discovery cannot be proven complete."
		return nil
	}
	if result.exitCode != 0 {
		node.Status = "unavailable"
		node.Reason = "Help probe exited with code " + strconv.Itoa(result.exitCode) + "."
		return nil
	}
	childrenByName := map[string]helpChild{}
	for _, helpOutput := range helpOutputCandidates(result) {
		if node.Usage == "" {
			node.Usage = parseUsage(helpOutput)
		}
		for _, child := range parseHelpChildren(helpOutput) {
			existing, found := childrenByName[child.name]
			if !found {
				childrenByName[child.name] = child
				continue
			}
			existing.plugin = existing.plugin || child.plugin
			if existing.description == "" {
				existing.description = child.description
			}
			childrenByName[child.name] = existing
		}
	}
	children := make([]helpChild, 0, len(childrenByName))
	for _, child := range childrenByName {
		children = append(children, child)
	}
	sort.Slice(children, func(i, j int) bool { return children[i].name < children[j].name })
	node.Status = "available"
	node.Reason = "Help probe succeeded for the exact fingerprinted Docker executable."
	return children
}

func combinedHelpOutput(result commandResult) []byte {
	stdout := string(result.stdout)
	stderr := string(result.stderr)
	switch {
	case strings.TrimSpace(stdout) == "":
		return stripANSISequences([]byte(stderr))
	case strings.TrimSpace(stderr) == "":
		return stripANSISequences([]byte(stdout))
	default:
		return joinHelpStreams(stdout, stderr)
	}
}

func helpOutputCandidates(result commandResult) [][]byte {
	primary := combinedHelpOutput(result)
	if strings.TrimSpace(string(result.stdout)) == "" || strings.TrimSpace(string(result.stderr)) == "" {
		return [][]byte{primary}
	}
	// Pipes are captured independently, so their original interleaving cannot
	// be reconstructed. Evaluate both stable stream orders and merge uniquely
	// named children; this covers a section heading and its rows being split
	// across either pipe without discarding the raw per-stream evidence.
	return [][]byte{
		primary,
		joinHelpStreams(string(result.stderr), string(result.stdout)),
	}
}

func joinHelpStreams(first string, second string) []byte {
	// Remove only separator line endings: trimming general whitespace here
	// would destroy the indentation that identifies Cobra command rows.
	joined := strings.TrimRight(first, "\r\n") + "\n" + strings.TrimLeft(second, "\r\n")
	return stripANSISequences([]byte(joined))
}

func stripANSISequences(input []byte) []byte {
	output := make([]byte, 0, len(input))
	for index := 0; index < len(input); {
		switch input[index] {
		case 0x1b:
			if index+1 >= len(input) {
				index++
				continue
			}
			switch input[index+1] {
			case '[':
				// Control Sequence Introducer: consume through its final byte.
				index += 2
				for index < len(input) && (input[index] < 0x40 || input[index] > 0x7e) {
					index++
				}
				if index < len(input) {
					index++
				}
			case ']':
				// Operating System Command: consume through BEL or ST.
				index += 2
				for index < len(input) {
					if input[index] == 0x07 {
						index++
						break
					}
					if input[index] == 0x1b && index+1 < len(input) && input[index+1] == '\\' {
						index += 2
						break
					}
					index++
				}
			default:
				// Other ANSI escape functions are two-byte sequences.
				index += 2
			}
		case 0x9b:
			// Single-byte CSI form.
			index++
			for index < len(input) && (input[index] < 0x40 || input[index] > 0x7e) {
				index++
			}
			if index < len(input) {
				index++
			}
		default:
			output = append(output, input[index])
			index++
		}
	}
	return output
}

func parseHelpChildren(output []byte) []helpChild {
	lines := strings.Split(strings.ReplaceAll(string(output), "\r\n", "\n"), "\n")
	inCommands := false
	seen := map[string]bool{}
	children := make([]helpChild, 0)
	for _, line := range lines {
		if line != "" && line[0] != ' ' && line[0] != '\t' {
			trimmed := strings.TrimSpace(line)
			inCommands = isCommandSection(trimmed)
			continue
		}
		if !inCommands || strings.TrimSpace(line) == "" {
			continue
		}
		// Docker/Cobra command rows use exactly two leading spaces. Wrapped
		// descriptions are more deeply indented and must not become phantom
		// subcommands.
		if !(strings.HasPrefix(line, "  ") && (len(line) == 2 || line[2] != ' ' && line[2] != '\t')) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		rawName := fields[0]
		plugin := strings.HasSuffix(rawName, "*")
		name := strings.TrimSuffix(rawName, "*")
		if !validCommandName(name) || seen[name] {
			continue
		}
		seen[name] = true
		description := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), rawName))
		children = append(children, helpChild{name: name, description: description, plugin: plugin})
	}
	sort.Slice(children, func(i, j int) bool { return children[i].name < children[j].name })
	return children
}

func isCommandSection(line string) bool {
	normalized := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line), ":"))
	switch normalized {
	case "Commands", "Subcommands", "Available Commands", "Common Commands", "Management Commands", "Swarm Commands":
		return true
	default:
		return false
	}
}

func validCommandName(value string) bool {
	if value == "" {
		return false
	}
	for index, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' {
			continue
		}
		if index > 0 && (char == '-' || char == '_' || char == '.' || char == '+') {
			continue
		}
		return false
	}
	return true
}

func parseUsage(output []byte) string {
	lines := strings.Split(strings.ReplaceAll(string(output), "\r\n", "\n"), "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Usage:") {
			usage := trimmed
			for next := index + 1; next < len(lines); next++ {
				if strings.TrimSpace(lines[next]) == "" || (len(lines[next]) > 0 && lines[next][0] != ' ' && lines[next][0] != '\t') {
					break
				}
				usage += " " + strings.TrimSpace(lines[next])
			}
			return usage
		}
		if trimmed == "Usage" {
			parts := make([]string, 0, 2)
			for next := index + 1; next < len(lines); next++ {
				if strings.TrimSpace(lines[next]) == "" {
					if len(parts) > 0 {
						break
					}
					continue
				}
				if len(lines[next]) > 0 && lines[next][0] != ' ' && lines[next][0] != '\t' {
					break
				}
				parts = append(parts, strings.TrimSpace(lines[next]))
			}
			if len(parts) > 0 {
				return "Usage: " + strings.Join(parts, " ")
			}
		}
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, `Use "`) {
			continue
		}
		quoted := strings.TrimPrefix(trimmed, `Use "`)
		command, suffix, found := strings.Cut(quoted, `"`)
		if !found || !strings.HasPrefix(strings.TrimSpace(suffix), "for more information") {
			continue
		}
		command = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(command), "--help"))
		if strings.Contains(command, "[command]") || strings.Contains(command, "COMMAND") {
			return "Usage: " + command
		}
	}
	return ""
}

func transportsForCommand(path []string) []string {
	joined := strings.Join(path, " ")
	switch joined {
	case "ps", "container ls":
		return []string{"engine-api-unix", "cli"}
	case "start", "stop", "restart", "rm",
		"container start", "container stop", "container restart", "container rm":
		return []string{"engine-api-unix", "cli"}
	default:
		return []string{"cli"}
	}
}

func parseContextList(output []byte) ([]DockerContext, []string) {
	contexts := make([]DockerContext, 0)
	warnings := make([]string, 0)
	for index, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var raw struct {
			Name           string `json:"Name"`
			Description    string `json:"Description"`
			DockerEndpoint string `json:"DockerEndpoint"`
			Current        bool   `json:"Current"`
			Error          string `json:"Error"`
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			warnings = append(warnings, fmt.Sprintf("Docker context row %d was not valid JSON: %v", index+1, err))
			continue
		}
		contexts = append(contexts, DockerContext{
			Name:           raw.Name,
			Description:    raw.Description,
			DockerEndpoint: raw.DockerEndpoint,
			Current:        raw.Current,
			Error:          raw.Error,
		})
	}
	return contexts, warnings
}

func parseVersion(output []byte, versions *DockerVersions) error {
	var raw struct {
		Client struct {
			Version       string `json:"Version"`
			APIVersion    string `json:"ApiVersion"`
			MinAPIVersion string `json:"MinAPIVersion"`
			GoVersion     string `json:"GoVersion"`
			GitCommit     string `json:"GitCommit"`
			OS            string `json:"Os"`
			Arch          string `json:"Arch"`
		} `json:"Client"`
		Server struct {
			Version       string `json:"Version"`
			APIVersion    string `json:"ApiVersion"`
			MinAPIVersion string `json:"MinAPIVersion"`
			GoVersion     string `json:"GoVersion"`
			GitCommit     string `json:"GitCommit"`
			OS            string `json:"Os"`
			Arch          string `json:"Arch"`
		} `json:"Server"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return err
	}
	versions.Client = VersionSide{
		Version: raw.Client.Version, APIVersion: raw.Client.APIVersion, MinAPIVersion: raw.Client.MinAPIVersion,
		GoVersion: raw.Client.GoVersion, GitCommit: raw.Client.GitCommit, OS: raw.Client.OS, Arch: raw.Client.Arch,
	}
	versions.Server = VersionSide{
		Version: raw.Server.Version, APIVersion: raw.Server.APIVersion, MinAPIVersion: raw.Server.MinAPIVersion,
		GoVersion: raw.Server.GoVersion, GitCommit: raw.Server.GitCommit, OS: raw.Server.OS, Arch: raw.Server.Arch,
	}
	return nil
}

type dockerInfo struct {
	ExperimentalBuild bool `json:"ExperimentalBuild"`
	ClientInfo        struct {
		Plugins []struct {
			SchemaVersion    string   `json:"SchemaVersion"`
			Vendor           string   `json:"Vendor"`
			Version          string   `json:"Version"`
			ShortDescription string   `json:"ShortDescription"`
			Name             string   `json:"Name"`
			Path             string   `json:"Path"`
			ShadowedPaths    []string `json:"ShadowedPaths"`
		} `json:"Plugins"`
	} `json:"ClientInfo"`
}

func convertPlugins(raw []struct {
	SchemaVersion    string   `json:"SchemaVersion"`
	Vendor           string   `json:"Vendor"`
	Version          string   `json:"Version"`
	ShortDescription string   `json:"ShortDescription"`
	Name             string   `json:"Name"`
	Path             string   `json:"Path"`
	ShadowedPaths    []string `json:"ShadowedPaths"`
}) []Plugin {
	plugins := make([]Plugin, 0, len(raw))
	for _, item := range raw {
		plugins = append(plugins, Plugin{
			Name:             item.Name,
			Version:          item.Version,
			Vendor:           item.Vendor,
			Description:      item.ShortDescription,
			Path:             item.Path,
			SchemaVersion:    item.SchemaVersion,
			Status:           "available",
			DiscoverySource:  "docker-info",
			AvailabilityNote: "Reported by the exact fingerprinted Docker CLI.",
		})
	}
	return plugins
}

func mergeHelpPlugins(plugins []Plugin, root *CommandNode) []Plugin {
	index := make(map[string]int, len(plugins))
	for position := range plugins {
		index[plugins[position].Name] = position
	}
	if root == nil {
		return plugins
	}
	for _, node := range root.Subcommands {
		if node.Kind != "plugin" {
			continue
		}
		if position, exists := index[node.Name]; exists {
			if node.Status != "available" {
				plugins[position].Status = "degraded"
				plugins[position].AvailabilityNote = node.Reason
			}
			continue
		}
		status := node.Status
		if status == "" {
			status = "unknown"
		}
		plugins = append(plugins, Plugin{
			Name:             node.Name,
			Description:      node.Description,
			Status:           status,
			DiscoverySource:  "docker-help",
			AvailabilityNote: node.Reason,
		})
	}
	return plugins
}

func (s *Service) probePluginCapability(ctx context.Context, selectedContext, name string, root *CommandNode) CapabilityStatus {
	node := findCommand(root, []string{name})
	if node == nil {
		return CapabilityStatus{
			Name: name, Status: "unavailable", Reason: "Command is absent from Docker root help.",
			Transports: []string{"cli"},
		}
	}
	if node.Status != "available" {
		evidence := node.Evidence
		return CapabilityStatus{
			Name: name, Status: "degraded", Reason: node.Reason,
			Transports: []string{"cli"}, Evidence: &evidence,
		}
	}
	args := withContext(selectedContext, name, "version")
	if name == "compose" {
		args = append(args, "--format", "json")
	}
	result, err := s.runDiscovery(ctx, nil, args...)
	evidence := commandEvidence(s.docker.binary.RealPath, args, result)
	status := CapabilityStatus{
		Name: name, Status: "available", Reason: node.Reason, Transports: []string{"cli"}, Evidence: &evidence,
	}
	if err != nil {
		status.Status = "degraded"
		status.Reason = "Version probe could not start: " + err.Error()
		return status
	}
	if result.timedOut {
		status.Status = "degraded"
		status.Reason = "Version probe timed out."
		return status
	}
	if result.stdoutTruncated || result.stderrTruncated {
		status.Status = "degraded"
		status.Reason = "Version probe output exceeded the evidence limit."
		return status
	}
	if result.exitCode != 0 {
		status.Status = "degraded"
		status.Reason = "Command is listed, but its version probe exited with code " + strconv.Itoa(result.exitCode) + "."
		return status
	}
	status.Version = extractVersionString(result.stdout)
	return status
}

func checkpointCapability(root *CommandNode, experimental bool) CapabilityStatus {
	node := findCommand(root, []string{"checkpoint"})
	if node == nil {
		return CapabilityStatus{
			Name: "checkpoint", Status: "unavailable", Reason: "Command is absent from Docker root help.",
			Transports: []string{"cli"},
		}
	}
	evidence := node.Evidence
	if node.Status != "available" {
		return CapabilityStatus{
			Name: "checkpoint", Status: "unavailable", Reason: node.Reason,
			Transports: []string{"cli"}, Evidence: &evidence,
		}
	}
	if !experimental {
		return CapabilityStatus{
			Name: "checkpoint", Status: "unavailable",
			Reason:     "The command is installed, but daemon experimental mode is disabled.",
			Transports: []string{"cli"}, Evidence: &evidence,
		}
	}
	return CapabilityStatus{
		Name: "checkpoint", Status: "available",
		Reason:     "The command is installed and daemon experimental mode is enabled.",
		Transports: []string{"cli"}, Evidence: &evidence,
	}
}

func findCommand(root *CommandNode, path []string) *CommandNode {
	current := root
	for _, part := range path {
		if current == nil {
			return nil
		}
		var next *CommandNode
		for _, child := range current.Subcommands {
			if child.Name == part {
				next = child
				break
			}
		}
		current = next
	}
	return current
}

func emptyInventory(reason string) CommandInventory {
	return CommandInventory{
		Root: &CommandNode{
			Path: []string{}, Name: "docker", Kind: "root", Status: "unavailable", Reason: reason,
			Transports: []string{"cli"}, Subcommands: []*CommandNode{},
		},
		NodeCount: 1, Complete: false, MaxDepth: inventoryMaxDepth, DiscoveredAt: nowUTC(),
		Warnings: []string{reason},
	}
}

func extractVersionString(output []byte) string {
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return ""
	}
	var object map[string]any
	if json.Unmarshal(output, &object) == nil {
		for _, key := range []string{"version", "Version"} {
			if value, ok := object[key].(string); ok {
				return value
			}
		}
	}
	for _, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "version:") {
			return strings.TrimSpace(line[len("version:"):])
		}
	}
	line, _, _ := strings.Cut(trimmed, "\n")
	return line
}

func evidenceFailure(command string, result commandResult) string {
	switch {
	case result.timedOut:
		return command + " timed out."
	case result.exitCode != 0:
		return command + " exited with code " + strconv.Itoa(result.exitCode) + "."
	default:
		return command + " failed."
	}
}

func withContext(contextName string, args ...string) []string {
	result := make([]string, 0, len(args)+2)
	result = append(result, "--context", contextName)
	return append(result, args...)
}

func negotiatedAPIVersion(client, server string) string {
	if client == "" {
		client = coreMaxAPIVersion
	}
	if server == "" {
		server = client
	}
	if compareAPIVersions(client, server) <= 0 {
		return client
	}
	return server
}

func displayCommandPath(path []string) string {
	if len(path) == 0 {
		return "docker"
	}
	return "docker " + strings.Join(path, " ")
}
