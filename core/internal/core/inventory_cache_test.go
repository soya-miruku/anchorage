package core

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// helpProbeCount counts recursive help probes in the fake client's call log, which is how these
// tests tell "served from cache" apart from "walked again and got the same answer".
func helpProbeCount(t *testing.T, logPath string) int {
	t.Helper()
	content, err := os.ReadFile(logPath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatalf("read fake docker log: %v", err)
	}
	count := 0
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasSuffix(strings.TrimSpace(line), "--help") {
			count++
		}
	}
	return count
}

func TestCommandInventoryIsServedFromDiskOnTheNextCoreProcess(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	cacheDirectory := t.TempDir()
	t.Setenv("ANCHORAGE_CACHE_DIR", cacheDirectory)

	first := newTestService(t, fakeDocker)
	firstResult, err := first.capabilities(context.Background(), CapabilitiesParams{Context: "default"})
	if err != nil {
		t.Fatalf("first capabilities: %v", err)
	}
	walked := helpProbeCount(t, logPath)
	if walked == 0 {
		t.Fatalf("the first call must actually walk the help tree")
	}

	// A second Service is the honest stand-in for the next launch: the process-lifetime memo is
	// empty, so anything it saves has to have come off disk.
	second := newTestService(t, fakeDocker)
	secondResult, err := second.capabilities(context.Background(), CapabilitiesParams{Context: "default"})
	if err != nil {
		t.Fatalf("second capabilities: %v", err)
	}
	if after := helpProbeCount(t, logPath); after != walked {
		t.Fatalf("second process re-walked the help tree: %d probes before, %d after", walked, after)
	}
	if secondResult.CommandInventory.NodeCount != firstResult.CommandInventory.NodeCount {
		t.Fatalf(
			"cached inventory differs: %d nodes cached, %d walked",
			secondResult.CommandInventory.NodeCount,
			firstResult.CommandInventory.NodeCount,
		)
	}
	if findCommand(secondResult.CommandInventory.Root, []string{"scout", "attestation", "add"}) == nil {
		t.Fatalf("cached inventory lost its plugin subtree")
	}
	// The plugin capability probes still run: they are a live check of the installed plugin,
	// not part of the walk, and serving those from a file would be reporting a version nobody
	// looked for.
	if got := secondResult.Capabilities["compose"]; got.Status != "available" || got.Version != "5.3.1" {
		t.Fatalf("cached path skipped the live plugin probe: %#v", got)
	}
}

func TestCommandInventoryCacheInvalidatesWhenTheInstalledPluginSetChanges(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	t.Setenv("ANCHORAGE_CACHE_DIR", t.TempDir())

	first := newTestService(t, fakeDocker)
	if _, err := first.capabilities(context.Background(), CapabilitiesParams{Context: "default"}); err != nil {
		t.Fatalf("first capabilities: %v", err)
	}
	walked := helpProbeCount(t, logPath)

	// A plugin is removed. The docker binary is untouched — its hash is identical — so a cache
	// keyed on the binary alone would keep reporting a command tree that includes Scout.
	pluginsPath := filepath.Join(filepath.Dir(fakeDocker), "plugins.json")
	reduced := `[{"SchemaVersion":"0.1.0","Vendor":"Docker Inc.","Version":"5.3.1","Name":"compose","Path":"/fixture/docker-compose"}]`
	if err := os.WriteFile(pluginsPath, []byte(reduced), 0o600); err != nil {
		t.Fatalf("rewrite plugin set: %v", err)
	}

	second := newTestService(t, fakeDocker)
	if _, err := second.capabilities(context.Background(), CapabilitiesParams{Context: "default"}); err != nil {
		t.Fatalf("second capabilities: %v", err)
	}
	if after := helpProbeCount(t, logPath); after <= walked {
		t.Fatalf("changing the installed plugin set did not invalidate the cache: %d probes before and after", walked)
	}
}

func TestCommandInventoryRunsOneWalkForConcurrentCallers(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	t.Setenv("ANCHORAGE_CACHE_DIR", t.TempDir())
	service := newTestService(t, fakeDocker)

	// The warm start and the renderer's first request overlap in practice. Without a shared
	// flight each would run the full subprocess storm.
	var wait sync.WaitGroup
	counts := make([]int, 4)
	for index := range counts {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			inventory := service.commandInventory(
				context.Background(), service.docker.binary, "default",
			)
			counts[index] = inventory.NodeCount
		}(index)
	}
	wait.Wait()

	probes := helpProbeCount(t, logPath)
	for index, count := range counts {
		if count != counts[0] || count == 0 {
			t.Fatalf("caller %d saw a different inventory: %v", index, counts)
		}
	}
	// One walk of this fixture is 12 help probes; four independent walks would be 48. The
	// assertion is deliberately loose about the exact number and strict about the multiple.
	if probes >= 2*counts[0] {
		t.Fatalf("concurrent callers ran more than one walk: %d probes for %d nodes", probes, counts[0])
	}
}

func TestWarmCommandInventoryPrecomputesTheWalkBeforeItIsAsked(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	cacheDirectory := t.TempDir()
	t.Setenv("ANCHORAGE_CACHE_DIR", cacheDirectory)

	warming := newTestService(t, fakeDocker)
	warming.WarmCommandInventory(context.Background())

	inventoryDirectory := filepath.Join(cacheDirectory, "command-inventory")
	deadline := time.Now().Add(30 * time.Second)
	for {
		entries, err := os.ReadDir(inventoryDirectory)
		if err == nil && len(entries) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("warm start never wrote an inventory to %s", inventoryDirectory)
		}
		time.Sleep(20 * time.Millisecond)
	}
	walked := helpProbeCount(t, logPath)

	// The launch that follows must find it done rather than repeat it.
	launched := newTestService(t, fakeDocker)
	result, err := launched.capabilities(context.Background(), CapabilitiesParams{Context: "default"})
	if err != nil {
		t.Fatalf("capabilities after warm: %v", err)
	}
	if after := helpProbeCount(t, logPath); after != walked {
		t.Fatalf("the warmed walk was repeated: %d probes before, %d after", walked, after)
	}
	if !result.CommandInventory.Complete || result.CommandInventory.NodeCount == 0 {
		t.Fatalf("warmed inventory was not usable: %#v", result.CommandInventory)
	}
}

func TestInventoryCacheRejectsRecordsItCannotTrust(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	cacheDirectory := t.TempDir()
	t.Setenv("ANCHORAGE_CACHE_DIR", cacheDirectory)

	service := newTestService(t, fakeDocker)
	if _, err := service.capabilities(context.Background(), CapabilitiesParams{Context: "default"}); err != nil {
		t.Fatalf("capabilities: %v", err)
	}
	walked := helpProbeCount(t, logPath)

	entries, err := os.ReadDir(filepath.Join(cacheDirectory, "command-inventory"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected exactly one cache file, got %v (%v)", entries, err)
	}
	cachePath := filepath.Join(cacheDirectory, "command-inventory", entries[0].Name())

	// Age is a backstop for anything the key does not model, so an expired record must be
	// re-walked rather than served.
	aged := `{"schemaVersion":1,"binarySha256":"","context":"default","pluginsDigest":"",` +
		`"recordedAt":"2000-01-01T00:00:00Z","inventory":{"root":{"path":[],"name":"docker"},` +
		`"nodeCount":1,"complete":true,"limitReached":false,"maxDepth":4,"discoveredAt":"2000-01-01T00:00:00Z","warnings":[]}}`
	if err := os.WriteFile(cachePath, []byte(aged), 0o600); err != nil {
		t.Fatalf("rewrite cache: %v", err)
	}
	next := newTestService(t, fakeDocker)
	if _, err := next.capabilities(context.Background(), CapabilitiesParams{Context: "default"}); err != nil {
		t.Fatalf("capabilities after tampering: %v", err)
	}
	if after := helpProbeCount(t, logPath); after <= walked {
		t.Fatalf("an untrustworthy cache record was served instead of re-walked")
	}
	walked = helpProbeCount(t, logPath)

	if err := os.WriteFile(cachePath, []byte("{ not json"), 0o600); err != nil {
		t.Fatalf("corrupt cache: %v", err)
	}
	corrupted := newTestService(t, fakeDocker)
	result, err := corrupted.capabilities(context.Background(), CapabilitiesParams{Context: "default"})
	if err != nil {
		t.Fatalf("a corrupt cache file must not fail the call: %v", err)
	}
	if after := helpProbeCount(t, logPath); after <= walked {
		t.Fatalf("a corrupt cache record was served instead of re-walked")
	}
	if !result.CommandInventory.Complete {
		t.Fatalf("recovery from a corrupt cache produced a partial inventory")
	}
}

func TestSystemContextsAnswersWithoutWalkingTheHelpTree(t *testing.T) {
	socketPath, closeServer, _ := startFakeEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	t.Setenv("ANCHORAGE_CACHE_DIR", t.TempDir())
	service := newTestService(t, fakeDocker)

	result, err := service.contexts(context.Background(), ContextsParams{})
	if err != nil {
		t.Fatalf("contexts: %v", err)
	}
	if result.ProtocolVersion != ProtocolVersion {
		t.Fatalf("unexpected protocol version %q", result.ProtocolVersion)
	}
	if result.SelectedContext != "default" || result.CurrentContext != "default" {
		t.Fatalf("unexpected contexts: selected=%q current=%q", result.SelectedContext, result.CurrentContext)
	}
	if len(result.Contexts) != 2 || result.Contexts[0].Name != "default" || result.Contexts[1].Name != "remote" {
		t.Fatalf("unexpected context list: %#v", result.Contexts)
	}
	if result.Binary == nil || len(result.Binary.SHA256) != 64 {
		t.Fatalf("missing binary fingerprint: %#v", result.Binary)
	}
	// The whole point of the verb: no help probes, no plugin version probes, so the launch path
	// cannot be held up by the size of the installed command surface.
	if probes := helpProbeCount(t, logPath); probes != 0 {
		t.Fatalf("system.contexts walked the help tree: %d probes", probes)
	}
	content, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read call log: %v", err)
	}
	for _, forbidden := range []string{"compose version", "scout version", "buildx version"} {
		if strings.Contains(string(content), forbidden) {
			t.Fatalf("system.contexts probed a plugin: %q", forbidden)
		}
	}

	// An explicit context is honoured, because the Command Center can pin one.
	pinned, err := service.contexts(context.Background(), ContextsParams{Context: "remote"})
	if err != nil {
		t.Fatalf("contexts(remote): %v", err)
	}
	if pinned.SelectedContext != "remote" || pinned.CurrentContext != "default" {
		t.Fatalf("explicit context was not honoured: %#v", pinned)
	}
}
