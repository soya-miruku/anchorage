package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stagePluginDir points the user plugin directory at a temporary tree, so these assert the
// classifier's behaviour rather than whatever happens to be installed on the build machine.
func stagePluginDir(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "cli-plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("staging plugin dir: %v", err)
	}
	t.Setenv("DOCKER_CONFIG", root)
	return dir
}

func writePlugin(t *testing.T, dir, name string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
	return path
}

func findPlugin(plugins []Plugin, name string) *Plugin {
	for index := range plugins {
		if plugins[index].Name == name {
			return &plugins[index]
		}
	}
	return nil
}

func TestInspectReportsBrokenSymlinkWithItsTarget(t *testing.T) {
	dir := stagePluginDir(t)
	target := filepath.Join(t.TempDir(), "removed", "docker-mcp")
	if err := os.Symlink(target, filepath.Join(dir, "docker-mcp")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	found := findPlugin(inspectPluginInstallation([]string{dir}, nil), "mcp")
	if found == nil {
		t.Fatal("a dangling plugin link was not reported; docker info omits it, so nothing would")
	}
	if found.Status != "broken" {
		t.Fatalf("status = %q, want broken", found.Status)
	}
	// The target is the whole diagnosis: without it the user cannot tell a stale Desktop
	// link from a plugin that was never installed.
	if !strings.Contains(found.AvailabilityNote, target) {
		t.Fatalf("note does not name the missing target %q: %s", target, found.AvailabilityNote)
	}
}

func TestInspectReportsAPluginThatIsNotExecutable(t *testing.T) {
	dir := stagePluginDir(t)
	writePlugin(t, dir, "docker-thing", 0o644)

	found := findPlugin(inspectPluginInstallation([]string{dir}, nil), "thing")
	if found == nil || found.Status != "broken" {
		t.Fatalf("a non-executable plugin was not reported as broken: %+v", found)
	}
}

func TestInspectStaysSilentAboutPluginsThatWork(t *testing.T) {
	dir := stagePluginDir(t)
	path := writePlugin(t, dir, "docker-compose", 0o755)

	// The CLI loaded it, so there is nothing to explain.
	loaded := []Plugin{{Name: "compose", Path: path}}
	if reported := inspectPluginInstallation([]string{dir}, loaded); len(reported) != 0 {
		t.Fatalf("a working plugin was reported as an issue: %+v", reported)
	}
}

func TestInspectStaysSilentAboutAShadowedDuplicate(t *testing.T) {
	dir := stagePluginDir(t)
	shadowed := writePlugin(t, dir, "docker-compose", 0o755)

	// A second copy elsewhere won; the CLI documents this under ShadowedPaths and uses the
	// winner. Reporting the loser as a fault would cry wolf on an ordinary installation.
	loaded := []Plugin{{Name: "compose", Path: "/usr/lib/docker/cli-plugins/docker-compose"}}
	for _, reported := range inspectPluginInstallation([]string{dir}, loaded) {
		if reported.Path == shadowed {
			t.Fatalf("a shadowed duplicate was reported as an issue: %+v", reported)
		}
	}
}

func TestInspectReportsAnExecutablePluginTheCLIRejected(t *testing.T) {
	dir := stagePluginDir(t)
	writePlugin(t, dir, "docker-mystery", 0o755)

	found := findPlugin(inspectPluginInstallation([]string{dir}, nil), "mystery")
	if found == nil {
		t.Fatal("an executable plugin absent from docker info was not reported")
	}
	// Distinct from "broken": the file is fine, the handshake is not, and the remedy differs.
	if found.Status != "degraded" {
		t.Fatalf("status = %q, want degraded", found.Status)
	}
}

func TestInspectIgnoresFilesThatAreNotPlugins(t *testing.T) {
	dir := stagePluginDir(t)
	writePlugin(t, dir, "README", 0o644)
	writePlugin(t, dir, "notdocker-thing", 0o644)

	if reported := inspectPluginInstallation([]string{dir}, nil); len(reported) != 0 {
		t.Fatalf("non-plugin files were reported: %+v", reported)
	}
}

func TestSearchPathFollowsTheCLIOrder(t *testing.T) {
	root := t.TempDir()
	t.Setenv("DOCKER_CONFIG", root)

	dirs := pluginSearchDirs()
	if len(dirs) == 0 || dirs[0] != filepath.Join(root, "cli-plugins") {
		t.Fatalf("the user directory must come first, as the CLI searches it first: %v", dirs)
	}
}
