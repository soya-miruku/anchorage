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

/*
Repairing a faulty entry.

The classifier above already tells the operator what to do about each fault it reports. These
cover the verb that carries it out, and they weight the refusals more heavily than the successes:
this is the first thing in the core that deletes a file on the operator's machine, so what it
declines to touch is the part worth pinning down.
*/

// pluginRepairService stands up a service whose `docker info` reports exactly `loaded`, so the
// classification a repair re-derives is under the test's control rather than the build machine's.
func pluginRepairService(t *testing.T, loaded string) *Service {
	t.Helper()
	script := `#!/bin/sh
case "$*" in
  *"info --format"*)
    printf '%s\n' '{"ExperimentalBuild":false,"ClientInfo":{"Plugins":` + loaded + `}}'
    ;;
  *)
    exit 0
    ;;
esac
`
	return newTestService(t, writeFakeDockerScript(t, script))
}

func TestPluginRepairRefusesAnActionOutsideTheAllowlist(t *testing.T) {
	dir := stagePluginDir(t)
	path := writePlugin(t, dir, "docker-mcp", 0o644)
	service := pluginRepairService(t, "[]")

	_, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "mcp", Path: path, Action: "install", Confirmed: true,
	})
	if code := AsOpError(err).Code; code != "unsupported_plugin_action" {
		t.Fatalf("an unlisted action must be refused by name, got %q", code)
	}
}

func TestPluginRepairRefusesAPathOutsideTheSearchPath(t *testing.T) {
	stagePluginDir(t)
	// A real plugin name in a directory the CLI never reads. Nothing about the file is wrong;
	// its location is the whole objection.
	elsewhere := filepath.Join(t.TempDir(), "docker-mcp")
	if err := os.WriteFile(elsewhere, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatalf("writing decoy: %v", err)
	}
	service := pluginRepairService(t, "[]")

	_, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "mcp", Path: elsewhere, Action: "remove", Confirmed: true,
	})
	if code := AsOpError(err).Code; code != "plugin_path_outside_search_path" {
		t.Fatalf("only the CLI's own plugin directories are eligible, got %q", code)
	}
	if _, statErr := os.Stat(elsewhere); statErr != nil {
		t.Fatalf("the refused file must still be there: %v", statErr)
	}
}

func TestPluginRepairRefusesAFileTheCLIWouldNeverLoad(t *testing.T) {
	dir := stagePluginDir(t)
	// In the right directory, but not a plugin: the CLI only loads `docker-*`, so nothing else
	// in these directories is this verb's business.
	path := writePlugin(t, dir, "config.json", 0o644)
	service := pluginRepairService(t, "[]")

	_, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "config", Path: path, Action: "remove", Confirmed: true,
	})
	if code := AsOpError(err).Code; code != "invalid_plugin_path" {
		t.Fatalf("a non-plugin file must be refused, got %q", code)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("the refused file must still be there: %v", statErr)
	}
}

func TestPluginRemoveRequiresConfirmation(t *testing.T) {
	dir := stagePluginDir(t)
	path := writePlugin(t, dir, "docker-mcp", 0o644)
	service := pluginRepairService(t, "[]")

	_, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "mcp", Path: path, Action: "remove",
	})
	if code := AsOpError(err).Code; code != "confirmation_required" {
		t.Fatalf("deleting a host file must be confirmed, got %q", code)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("an unconfirmed remove must not delete anything: %v", statErr)
	}
}

func TestPluginRepairRefusesAnEntryThatIsNotFaulty(t *testing.T) {
	dir := stagePluginDir(t)
	path := writePlugin(t, dir, "docker-compose", 0o755)
	// The CLI reports this very file as loaded, so the scan does not classify it as a fault
	// and the caller's say-so does not make it one.
	service := pluginRepairService(t,
		`[{"SchemaVersion":"0.1.0","Vendor":"Docker Inc.","Version":"5.3.1","Name":"compose","Path":"`+path+`"}]`)

	_, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "compose", Path: path, Action: "remove", Confirmed: true,
	})
	if code := AsOpError(err).Code; code != "plugin_not_faulty" {
		t.Fatalf("a working plugin must not be removable, got %q", code)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("a working plugin must survive: %v", statErr)
	}
}

func TestPluginRemoveClearsADanglingSymlink(t *testing.T) {
	dir := stagePluginDir(t)
	// The reference fault: Docker Desktop's installer left the link, its package manager took
	// the target, and no Docker command can clear what remains.
	path := filepath.Join(dir, "docker-mcp")
	if err := os.Symlink(filepath.Join(dir, "gone", "docker-mcp"), path); err != nil {
		t.Fatalf("staging dangling link: %v", err)
	}
	service := pluginRepairService(t, "[]")

	result, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "mcp", Path: path, Action: "remove", Confirmed: true,
	})
	if err != nil {
		t.Fatalf("removing a dangling link: %v", err)
	}
	if result.Outcome != "removed" {
		t.Fatalf("outcome must name what happened, got %q", result.Outcome)
	}
	if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
		t.Fatalf("the link is still there: %v", statErr)
	}
	// The result carries the re-read installation, so a surface cannot draw a report that
	// disagrees with the change it just made.
	if findPlugin(result.Plugins.Plugins, "mcp") != nil {
		t.Fatalf("the removed entry is still in the report: %+v", result.Plugins.Plugins)
	}
}

func TestPluginEnableAddsTheExecuteBitWithoutWideningTheFile(t *testing.T) {
	dir := stagePluginDir(t)
	// Readable by the owner only. `chmod +x` on this must not make it group- or
	// world-executable, which granting 0o111 outright would.
	path := writePlugin(t, dir, "docker-model", 0o600)
	service := pluginRepairService(t, "[]")

	result, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "model", Path: path, Action: "enable",
	})
	if err != nil {
		t.Fatalf("enabling a non-executable plugin: %v", err)
	}
	if result.Outcome != "enabled" {
		t.Fatalf("outcome must name what happened, got %q", result.Outcome)
	}
	info, statErr := os.Stat(path)
	if statErr != nil {
		t.Fatalf("stat after enable: %v", statErr)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("expected 0700, got %#o — the execute bit must follow the read bits", got)
	}
}

func TestPluginEnableRefusesALinkWithNoTarget(t *testing.T) {
	dir := stagePluginDir(t)
	path := filepath.Join(dir, "docker-ai")
	if err := os.Symlink(filepath.Join(dir, "gone", "docker-ai"), path); err != nil {
		t.Fatalf("staging dangling link: %v", err)
	}
	service := pluginRepairService(t, "[]")

	// There is nothing to make executable, and saying so points at the repair that does apply.
	_, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "ai", Path: path, Action: "enable",
	})
	if code := AsOpError(err).Code; code != "plugin_enable_failed" {
		t.Fatalf("a dangling link cannot be enabled, got %q", code)
	}
}

func TestPluginRepairRefusesWhenDockerCannotSayWhatItLoaded(t *testing.T) {
	dir := stagePluginDir(t)
	path := writePlugin(t, dir, "docker-mcp", 0o755)
	// `docker info` fails. Every executable plugin would classify as "not loaded" against an
	// empty answer, so an unanswered query must not license a deletion.
	service := newTestService(t, writeFakeDockerScript(t, "#!/bin/sh\nexit 1\n"))

	_, err := service.pluginAction(t.Context(), PluginActionParams{
		Context: "default", Name: "mcp", Path: path, Action: "remove", Confirmed: true,
	})
	if code := AsOpError(err).Code; code != "plugin_state_unknown" {
		t.Fatalf("an unanswered docker info must block the repair, got %q", code)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("nothing may be removed on an unknown state: %v", statErr)
	}
}

/*
The fault is a contract, not a description.

Three surfaces decide which repair to offer from `Plugin.Fault`, and they used to decide it by
matching on `AvailabilityNote` — so improving the wording of a sentence would have silently
withdrawn a button. These pin the values instead.
*/
func TestEachFaultIsNamedAsAValueNotOnlyInProse(t *testing.T) {
	dir := stagePluginDir(t)

	// A link with no target: removable, and nothing else.
	danglingPath := filepath.Join(dir, "docker-mcp")
	if err := os.Symlink(filepath.Join(dir, "gone", "docker-mcp"), danglingPath); err != nil {
		t.Fatalf("staging dangling link: %v", err)
	}
	// Present, real, and missing only its execute bit: the one fault a chmod repairs.
	writePlugin(t, dir, "docker-model", 0o644)
	// Executable and unshadowed but absent from `docker info`: a version mismatch, which has no
	// local repair at all.
	writePlugin(t, dir, "docker-agent", 0o755)

	reported := inspectPluginInstallation([]string{dir}, nil)
	for _, testCase := range []struct{ name, status, fault string }{
		{"mcp", "broken", "dangling-link"},
		{"model", "broken", "not-executable"},
		{"agent", "degraded", "handshake"},
	} {
		entry := findPlugin(reported, testCase.name)
		if entry == nil {
			t.Fatalf("%s was not reported at all: %+v", testCase.name, reported)
		}
		if entry.Status != testCase.status {
			t.Fatalf("%s status %q, want %q", testCase.name, entry.Status, testCase.status)
		}
		if entry.Fault != testCase.fault {
			t.Fatalf("%s fault %q, want %q", testCase.name, entry.Fault, testCase.fault)
		}
		// The prose stays, because it is what the operator reads.
		if entry.AvailabilityNote == "" {
			t.Fatalf("%s carries a fault but no explanation", testCase.name)
		}
	}
}

func TestAnEntryThatIsFineCarriesNoFault(t *testing.T) {
	dir := stagePluginDir(t)
	path := writePlugin(t, dir, "docker-compose", 0o755)
	// Reported as loaded, so it is not a fault and must not be described as one.
	loaded := []Plugin{{Name: "compose", Path: path, Status: "available"}}

	if reported := inspectPluginInstallation([]string{dir}, loaded); len(reported) != 0 {
		t.Fatalf("a working plugin was reported as faulty: %+v", reported)
	}
}
