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

func userPluginDir() string {
	if configured := strings.TrimSpace(os.Getenv("DOCKER_CONFIG")); configured != "" {
		return filepath.Join(configured, "cli-plugins")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".docker", "cli-plugins")
}

func pluginSearchDirs() []string {
	dirs := make([]string, 0, 5)
	if user := userPluginDir(); user != "" {
		dirs = append(dirs, user)
	}
	return append(dirs, systemPluginDirs()...)
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

			status, note := classifyPluginEntry(path, command, working[command])
			if status == "" {
				continue
			}
			issues = append(issues, Plugin{
				Name:             command,
				Path:             path,
				Status:           status,
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

// classifyPluginEntry names why the CLI skipped this file. An empty status means the entry is
// fine and simply lost a shadowing contest, which is not worth reporting.
func classifyPluginEntry(path, command string, nameAlreadyWorks bool) (string, string) {
	target, linkErr := os.Readlink(path)
	info, statErr := os.Stat(path)

	if statErr != nil {
		if linkErr == nil {
			// A symlink whose target is gone. `ls` lists it, `docker info` ignores it,
			// and `docker <name>` falls through to the root help with no explanation.
			return "broken", "A symbolic link pointing at " + target + ", which does not exist. Usually left behind when Docker Desktop was removed. Deleting the link is safe; the plugin is already gone."
		}
		return "broken", "Present in the plugin directory but cannot be read: " + statErr.Error()
	}

	if info.IsDir() {
		return "", ""
	}

	if info.Mode().Perm()&0o111 == 0 {
		return "broken", "Present but not executable, so the Docker CLI does not load it. `chmod +x` makes it available."
	}

	if nameAlreadyWorks {
		// Another copy of the same plugin won; the CLI reports the winner's path under
		// ShadowedPaths, so this is documented behaviour rather than a fault.
		return "", ""
	}

	// Executable, resolvable, unshadowed, and still absent from `docker info`: the CLI
	// loaded it and rejected it, which its metadata handshake does on a version mismatch.
	return "degraded", "Executable but not loaded by the Docker CLI. It is usually a plugin built against a different CLI version, so its metadata handshake fails."
}

// pluginInstallation answers the health question on its own, without the recursive help walk
// and per-plugin probes that `system.capabilities` performs.
func (s *Service) pluginInstallation(ctx context.Context, params PluginsParams) (PluginsResult, error) {
	result := PluginsResult{
		ProtocolVersion: ProtocolVersion,
		Plugins:         []Plugin{},
		SearchPath:      pluginSearchDirs(),
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
func (s *Service) loadedPlugins(ctx context.Context, selectedContext string) ([]Plugin, []string) {
	warnings := []string{}
	args := withContext(selectedContext, "info", "--format", "{{json .}}")
	result, err := s.runDiscovery(ctx, nil, args...)
	if err != nil {
		return nil, append(warnings, "Docker info failed to start: "+err.Error())
	}
	if result.exitCode != 0 || result.timedOut {
		return nil, append(warnings, evidenceFailure("docker info", result))
	}
	var info dockerInfo
	if err := json.Unmarshal(result.stdout, &info); err != nil {
		return nil, append(warnings, "Docker info output was not valid JSON: "+err.Error())
	}
	return convertPlugins(info.ClientInfo.Plugins), warnings
}
