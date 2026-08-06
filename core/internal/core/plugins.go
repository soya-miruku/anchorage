package core

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

/*
Plugin installation health.

`docker info` reports the plugins the CLI successfully loaded and says nothing at all about
the ones it skipped. That silence is the problem this answers: a file named `docker-mcp` sits
in the plugin directory, `ls` shows it, and `docker mcp` prints the root help as though the
command had been misspelled. Nothing anywhere explains that the plugin is a symlink whose
target was removed.

The most common cause on Linux is an uninstalled Docker Desktop: its installer writes links
into `~/.docker/cli-plugins` pointing at `/usr/lib/docker/cli-plugins`, and removing the
package leaves the links behind. Nine such links can sit in a directory for months.

This walks the same directories the CLI walks, in the same order, and reports every entry the
CLI would skip together with the reason. It is a stat of a few directories, so it stays off
the expensive capability walk and answers on demand.
*/

// The CLI's own search order (cli/cli-plugins/manager). The user directory is consulted
// first, so a plugin there shadows the same name in a system directory.
func systemPluginDirs() []string {
	if runtime.GOOS != "linux" {
		return nil
	}
	return []string{
		"/usr/local/lib/docker/cli-plugins",
		"/usr/local/libexec/docker/cli-plugins",
		"/usr/lib/docker/cli-plugins",
		"/usr/libexec/docker/cli-plugins",
	}
}

// dockerConfigDir is the directory the CLI keeps config.json in, honouring DOCKER_CONFIG the
// same way the CLI does.
func dockerConfigDir() string {
	if configured := strings.TrimSpace(os.Getenv("DOCKER_CONFIG")); configured != "" {
		return configured
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".docker")
}

func userPluginDir() string {
	root := dockerConfigDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "cli-plugins")
}

// extraPluginDirs reads the operator's own `cliPluginsExtraDirs`, which the CLI honours and this
// did not — so a plugin installed anywhere but the two conventional trees was invisible here
// while `docker` ran it perfectly well. The field is documented on the CLI's ConfigFile as
// `cliPluginsExtraDirs`, and cli-plugins/manager places these ahead of the user directory, so a
// plugin found here shadows one of the same name below it.
//
// Unreadable or malformed config is not an error. The CLI treats a broken config.json as no
// extra directories rather than refusing to run, and a plugin report that failed because a
// stray file could not be parsed would be worse than one that lists the conventional trees.
func extraPluginDirs() []string {
	root := dockerConfigDir()
	if root == "" {
		return nil
	}
	contents, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil {
		return nil
	}
	var config struct {
		CLIPluginsExtraDirs []string `json:"cliPluginsExtraDirs"`
	}
	if err := json.Unmarshal(contents, &config); err != nil {
		return nil
	}
	dirs := make([]string, 0, len(config.CLIPluginsExtraDirs))
	for _, dir := range config.CLIPluginsExtraDirs {
		dir = strings.TrimSpace(dir)
		// Absolute only. A relative entry would resolve against whatever working directory the
		// core happens to hold, which is not what the operator wrote it against.
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		dirs = append(dirs, filepath.Clean(dir))
	}
	return dirs
}

// pluginSearchDirs is the CLI's own search order: configured extra directories, then the user
// directory, then the system trees. Order is load-bearing — an entry in an earlier directory
// shadows the same name later, and the CLI applies that even when the winner is faulty.
func pluginSearchDirs() []string {
	dirs := make([]string, 0, 6)
	dirs = append(dirs, extraPluginDirs()...)
	if user := userPluginDir(); user != "" {
		dirs = append(dirs, user)
	}
	dirs = append(dirs, systemPluginDirs()...)
	// A directory named twice would report every plugin in it twice.
	seen := make(map[string]bool, len(dirs))
	unique := dirs[:0]
	for _, dir := range dirs {
		if seen[dir] {
			continue
		}
		seen[dir] = true
		unique = append(unique, dir)
	}
	return unique
}

// inspectPluginInstallation reports entries in `dirs` that the CLI did not load. `loaded` is
// what `docker info` returned, which is the authority on what works.
//
// The directories are a parameter rather than read from the environment so this can be tested
// against a staged tree; reading the real search path would make every assertion depend on
// whatever Docker plugins happen to be installed on the build machine.
func inspectPluginInstallation(dirs []string, loaded []Plugin) []Plugin {
	working := make(map[string]bool, len(loaded))
	// A path the CLI reported as shadowed is a duplicate it deliberately ignored, not a
	// fault, so it must not be reported as one.
	accountedPaths := make(map[string]bool, len(loaded))
	for _, plugin := range loaded {
		working[plugin.Name] = true
		if plugin.Path != "" {
			accountedPaths[resolvedPath(plugin.Path)] = true
			accountedPaths[plugin.Path] = true
		}
	}

	issues := make([]Plugin, 0)
	seen := make(map[string]bool)

	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			// Most of these directories are absent on any given machine, which is the
			// normal case and not a finding. An unreadable one is also not reported: this
			// answers what the CLI would skip, and the CLI cannot read it either.
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasPrefix(name, "docker-") {
				continue
			}
			command := strings.TrimPrefix(name, "docker-")
			// Windows-style suffixes never appear on Linux, but trimming keeps the
			// command name honest if this ever runs elsewhere.
			command = strings.TrimSuffix(command, filepath.Ext(command))
			path := filepath.Join(dir, name)
			if accountedPaths[path] || accountedPaths[resolvedPath(path)] {
				continue
			}
			key := dir + "\x00" + name
			if seen[key] {
				continue
			}
			seen[key] = true

			status, fault, note := classifyPluginEntry(path, command, working[command])
			if status == "" {
				continue
			}
			issues = append(issues, Plugin{
				Name:             command,
				Path:             path,
				Status:           status,
				Fault:            fault,
				DiscoverySource:  "cli-plugins-dir",
				AvailabilityNote: note,
			})
		}
	}

	sort.Slice(issues, func(i, j int) bool {
		if issues[i].Name != issues[j].Name {
			return issues[i].Name < issues[j].Name
		}
		return issues[i].Path < issues[j].Path
	})
	return issues
}

func resolvedPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return path
}

// classifyPluginEntry names why the CLI skipped this file, as (status, fault, note). An empty
// status means the entry is fine and simply lost a shadowing contest, which is not worth
// reporting.
//
// The fault is returned alongside the note because they serve different readers. The note is for
// the operator and is free to be reworded; the fault decides which repair a surface may offer,
// and matching that decision against English prose would break the moment the wording improved.
func classifyPluginEntry(path, command string, nameAlreadyWorks bool) (string, string, string) {
	target, linkErr := os.Readlink(path)
	info, statErr := os.Stat(path)

	if statErr != nil {
		if linkErr == nil {
			// A symlink whose target is gone. `ls` lists it, `docker info` ignores it,
			// and `docker <name>` falls through to the root help with no explanation.
			return "broken", "dangling-link", "A symbolic link pointing at " + target + ", which does not exist. Usually left behind when Docker Desktop was removed. Deleting the link is safe; the plugin is already gone."
		}
		return "broken", "unreadable", "Present in the plugin directory but cannot be read: " + statErr.Error()
	}

	if info.IsDir() {
		return "", "", ""
	}

	if info.Mode().Perm()&0o111 == 0 {
		return "broken", "not-executable", "Present but not executable, so the Docker CLI does not load it. `chmod +x` makes it available."
	}

	if nameAlreadyWorks {
		// Another copy of the same plugin won; the CLI reports the winner's path under
		// ShadowedPaths, so this is documented behaviour rather than a fault.
		return "", "", ""
	}

	// Executable, resolvable, unshadowed, and still absent from `docker info`: the CLI
	// loaded it and rejected it, which its metadata handshake does on a version mismatch.
	return "degraded", "handshake", "Executable but not loaded by the Docker CLI. It is usually a plugin built against a different CLI version, so its metadata handshake fails."
}

// pluginInstallation answers the health question on its own, without the recursive help walk
// and per-plugin probes that `system.capabilities` performs.
func (s *Service) pluginInstallation(ctx context.Context, params PluginsParams) (PluginsResult, error) {
	result := PluginsResult{
		ProtocolVersion: ProtocolVersion,
		Plugins:         []Plugin{},
		SearchPath:      pluginSearchDirs(),
		PackageManager:  detectHostPackageManager(),
		ObservedAt:      nowUTC(),
	}
	if s.docker == nil {
		result.BinaryError = AsOpError(s.dockerErr)
		return result, nil
	}
	binary := s.docker.binary
	result.Binary = &binary

	loaded, warnings := s.loadedPlugins(ctx, params.Context)
	result.Warnings = warnings
	result.Plugins = append(result.Plugins, loaded...)
	result.Plugins = append(result.Plugins, inspectPluginInstallation(result.SearchPath, loaded)...)
	return result, nil
}

// loadedPlugins asks the CLI what it actually loaded. That answer is authoritative: a plugin
// the CLI reports here works, and anything in the directories it does not report is what the
// directory scan then has to explain.
//
// The read path degrades to a warning because a report missing the loaded half is still worth
// showing — the faulty entries are the part the CLI never mentions. A mutation cannot degrade
// the same way; see loadedPluginsStrict.
func (s *Service) loadedPlugins(ctx context.Context, selectedContext string) ([]Plugin, []string) {
	loaded, err := s.loadedPluginsStrict(ctx, selectedContext)
	if err != nil {
		return nil, []string{AsOpError(err).Message}
	}
	return loaded, []string{}
}

// loadedPluginsStrict is the same read with the failure surfaced as an error.
//
// A repair verb may not treat "the CLI could not be asked" as "the CLI loaded nothing": the
// classification below marks an executable, unshadowed plugin absent from `docker info` as
// degraded, so an unanswered query would render every working plugin on the machine removable.
func (s *Service) loadedPluginsStrict(ctx context.Context, selectedContext string) ([]Plugin, error) {
	args := withContext(selectedContext, "info", "--format", "{{json .}}")
	result, err := s.runDiscovery(ctx, nil, args...)
	if err != nil {
		return nil, opError("plugin_state_unknown",
			"Docker info failed to start: "+err.Error(), err, nil)
	}
	if result.exitCode != 0 || result.timedOut {
		return nil, opError("plugin_state_unknown", evidenceFailure("docker info", result), nil,
			map[string]any{"exitCode": result.exitCode, "timedOut": result.timedOut})
	}
	var info dockerInfo
	if err := json.Unmarshal(result.stdout, &info); err != nil {
		return nil, opError("plugin_state_unknown",
			"Docker info output was not valid JSON: "+err.Error(), err, nil)
	}
	return convertPlugins(info.ClientInfo.Plugins), nil
}

// The repairs this verb performs on a faulty plugin entry. Neither installs anything.
var pluginActions = map[string]bool{"remove": true, "enable": true}

/*
Repairing a faulty plugin entry.

`classifyPluginEntry` above already names the remedy for each fault it reports — "Deleting the
link is safe; the plugin is already gone", "`chmod +x` makes it available" — and until now the
operator had to leave the application to carry it out. These two verbs do exactly what those
notes say and nothing more.

The guardrail that matters is not the path shape, it is *which* paths are eligible. The desktop
launches the core with `--allow-cwd /`, so `resolveAllowedCWD` would accept any path the user
can already write; it adds nothing here. What constrains this verb is that the parent directory
must be one the Docker CLI itself searches, the file name must be one the CLI would load, and
the entry must still be classified faulty by a scan this call performs itself. A caller cannot
nominate a target by asserting it is broken.
*/
func validatePluginPath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 4096 {
		return "", opError("invalid_plugin_path",
			"Plugin path must contain between 1 and 4096 characters.", nil, nil)
	}
	// The value becomes an argument to a filesystem call beside no flags at all, but the same
	// rule as validateArchivePath is kept: a leading '-' is what turns a path into an option.
	if strings.HasPrefix(value, "-") {
		return "", opError("invalid_plugin_path",
			"Plugin path must not begin with '-'.", nil, nil)
	}
	if !filepath.IsAbs(value) {
		return "", opError("invalid_plugin_path", "Plugin path must be absolute.", nil, nil)
	}
	for _, char := range value {
		if char == 0 || char == '\n' || char == '\r' {
			return "", opError("invalid_plugin_path",
				"Plugin path must not contain control characters.", nil, nil)
		}
	}
	cleaned := filepath.Clean(value)
	// The CLI loads `docker-*` and ignores everything else, so anything else in these
	// directories is not a plugin and is not this verb's business.
	if !strings.HasPrefix(filepath.Base(cleaned), "docker-") {
		return "", opError("invalid_plugin_path",
			"Plugin file names begin with 'docker-'.", nil, map[string]any{"path": raw})
	}
	parent := filepath.Dir(cleaned)
	for _, dir := range pluginSearchDirs() {
		if sameDirectory(parent, dir) {
			return cleaned, nil
		}
	}
	return "", opError("plugin_path_outside_search_path",
		"Plugin path is not in a directory the Docker CLI searches for plugins.", nil,
		map[string]any{"path": raw, "searchPath": pluginSearchDirs()})
}

// sameDirectory compares directories by canonical form where both resolve and literally where
// they do not. A plugin directory is frequently a symlink itself, and matching only the literal
// string would refuse a legitimate path; resolving only one side would compare unlike things.
func sameDirectory(left, right string) bool {
	if filepath.Clean(left) == filepath.Clean(right) {
		return true
	}
	leftReal, leftErr := filepath.EvalSymlinks(left)
	rightReal, rightErr := filepath.EvalSymlinks(right)
	return leftErr == nil && rightErr == nil && leftReal == rightReal
}

// findFaultyPlugin locates the entry a repair names within a scan this call performed. Matching
// on both name and path: a name alone is ambiguous across directories, and a path alone would
// let a caller repair one entry while naming another in the audit trail.
func findFaultyPlugin(entries []Plugin, name, path string) *Plugin {
	for index := range entries {
		if entries[index].Name == name && entries[index].Path == path {
			return &entries[index]
		}
	}
	return nil
}

func (s *Service) pluginAction(ctx context.Context, params PluginActionParams) (PluginActionResult, error) {
	action := strings.TrimSpace(params.Action)
	if !pluginActions[action] {
		return PluginActionResult{}, opError("unsupported_plugin_action",
			"Plugin action is not in the mutation allowlist.", nil,
			map[string]any{"action": params.Action})
	}
	name := strings.TrimSpace(params.Name)
	if name == "" || len(name) > 128 {
		return PluginActionResult{}, opError("invalid_plugin_name",
			"Plugin name must contain between 1 and 128 characters.", nil, nil)
	}
	path, err := validatePluginPath(params.Path)
	if err != nil {
		return PluginActionResult{}, err
	}
	// Removing is deleting a file on the operator's machine. Enabling is not gated: it adds a
	// permission bit to a file that is already there and is reversible with the same verb's
	// counterpart on disk.
	if action == "remove" && !params.Confirmed {
		return PluginActionResult{}, confirmationRequired("plugin", name, "remove")
	}

	loaded, err := s.loadedPluginsStrict(ctx, params.Context)
	if err != nil {
		return PluginActionResult{}, err
	}
	target := findFaultyPlugin(inspectPluginInstallation(pluginSearchDirs(), loaded), name, path)
	if target == nil {
		return PluginActionResult{}, opError("plugin_not_faulty",
			"That entry is not reported as broken or unloaded, so there is nothing to repair.", nil,
			map[string]any{"name": name, "path": path})
	}

	outcome := ""
	switch action {
	case "remove":
		// Lstat, never Stat: the entry being removed is usually a symlink whose target is
		// gone, and following it would report the wrong thing about what is being deleted.
		info, lstatErr := os.Lstat(path)
		if lstatErr != nil {
			return PluginActionResult{}, opError("plugin_remove_failed",
				"The plugin entry could not be read: "+lstatErr.Error(), lstatErr,
				map[string]any{"path": path})
		}
		if info.IsDir() {
			return PluginActionResult{}, opError("plugin_remove_failed",
				"That path is a directory, not a plugin entry.", nil, map[string]any{"path": path})
		}
		// Remove, not RemoveAll: a directory that slipped past the check above must fail
		// rather than take a tree with it.
		if err := os.Remove(path); err != nil {
			return PluginActionResult{}, opError("plugin_remove_failed",
				"The plugin entry could not be removed: "+err.Error(), err,
				map[string]any{"path": path})
		}
		outcome = "removed"
	case "enable":
		// Stat, following the link: the execute bit the CLI checks belongs to the file it
		// ends up running, and a dangling link has no target to make executable.
		info, statErr := os.Stat(path)
		if statErr != nil {
			return PluginActionResult{}, opError("plugin_enable_failed",
				"The plugin file cannot be read, so it cannot be made executable. A link with no target has to be removed instead.",
				statErr, map[string]any{"path": path})
		}
		if info.IsDir() {
			return PluginActionResult{}, opError("plugin_enable_failed",
				"That path is a directory, not a plugin entry.", nil, map[string]any{"path": path})
		}
		permissions := info.Mode().Perm()
		if permissions&0o111 != 0 {
			return PluginActionResult{}, opError("plugin_already_executable",
				"That plugin is already executable, so the missing execute bit is not why the CLI skipped it.",
				nil, map[string]any{"path": path})
		}
		// x wherever r is already set, which is what `chmod +x` amounts to for a normally
		// permissioned file. Granting 0o111 outright would make a private file group- and
		// world-executable, which is a wider change than the fault being repaired.
		if err := os.Chmod(path, permissions|(permissions&0o444)>>2); err != nil {
			return PluginActionResult{}, opError("plugin_enable_failed",
				"The execute bit could not be set: "+err.Error(), err, map[string]any{"path": path})
		}
		outcome = "enabled"
	}

	// Re-read rather than patch the previous report: `enable` can make a plugin load, which
	// changes entries this call never touched, and a client-side edit would not know that.
	after, err := s.pluginInstallation(ctx, PluginsParams{Context: params.Context})
	if err != nil {
		return PluginActionResult{}, err
	}
	return PluginActionResult{
		ProtocolVersion: ProtocolVersion,
		Name:            name,
		Path:            path,
		Action:          action,
		Outcome:         outcome,
		Plugins:         after,
		ObservedAt:      nowUTC(),
	}, nil
}

/*
How this machine installs software.

A CLI plugin is a client-side executable, so it is installed on the machine running Anchorage —
not on whatever daemon a context points at. The engine snapshot cannot answer this: against a
remote context it describes the daemon's operating system, and the plugin still has to land here.

The lookup below is of package manager names, not of plugins. That distinction matters: a list of
plugin names would go stale every time Docker shipped one, while `pacman`, `apt-get`, `dnf`,
`zypper` and `apk` have named themselves the same way for decades. An unrecognised host reports
nothing rather than guessing, and the surface then says it does not know rather than printing a
command that will fail.
*/
type hostPackageManager struct {
	// Name is the manager itself: pacman, apt-get, dnf, zypper, apk.
	Name string `json:"name"`
	// Helper is an AUR helper where one is installed, because packages that live in the AUR
	// cannot be installed by pacman alone and telling an operator otherwise wastes their time.
	Helper string `json:"helper,omitempty"`
}

func detectHostPackageManager() *hostPackageManager {
	binaryDirs := []string{"/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"}
	found := func(name string) bool {
		for _, dir := range binaryDirs {
			info, err := os.Stat(filepath.Join(dir, name))
			if err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
				return true
			}
		}
		return false
	}
	// Ordered so a derivative that ships two managers reports the one that owns its packages.
	for _, name := range []string{"pacman", "apt-get", "dnf", "zypper", "apk"} {
		if !found(name) {
			continue
		}
		manager := &hostPackageManager{Name: name}
		if name == "pacman" {
			for _, helper := range []string{"paru", "yay"} {
				if found(helper) {
					manager.Helper = helper
					break
				}
			}
		}
		return manager
	}
	return nil
}
