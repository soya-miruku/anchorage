package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Persistence and warming for the recursive `docker --help` walk.
//
// The walk is roughly one subprocess per advertised command node — 304 nodes and ~3.1s on the
// reference machine — and it sat on the launch path: the renderer cannot report an engine
// until system.capabilities returns, and capabilities did not return until the walk finished.
// Memoizing it in the service helped a second call within one process and did nothing for the
// launch that paid for the first, because the core is a fresh process on every launch.
//
// Three things change that here:
//
//   - The result is written to the user's cache directory, so the walk is paid once per Docker
//     installation rather than once per launch.
//   - The walk is started when the core starts rather than when it is first asked for, so on a
//     cold cache it overlaps Chromium and renderer startup instead of following them.
//   - Concurrent callers join one walk instead of each starting their own; without this the
//     warm start and the renderer's first request would run 600 subprocesses between them.
//
// What the cache is keyed by matters more than where it lives. The docker binary's SHA-256
// alone is not enough: installing or removing a CLI plugin changes the help tree without
// touching the binary, and a cache that missed that would report a command surface the
// operator no longer has. The key therefore also covers the plugin set the client reports,
// so `docker plugin install`, an upgrade, or a removal all invalidate it.
const (
	inventoryCacheSchemaVersion = 1
	// A backstop for anything the key does not model. The key is expected to catch real
	// changes; this bounds how long a mistake in that expectation can persist.
	inventoryCacheMaxAge = 14 * 24 * time.Hour
	// Generous for a document that is ~1 MB in practice, and small enough that a corrupted or
	// hostile file cannot be read into memory unbounded.
	inventoryCacheMaxBytes = 8 << 20
	// The walk outlives the request that triggered it (see below), so it needs its own bound.
	inventoryWalkTimeout = 2 * time.Minute
)

type inventoryCacheRecord struct {
	SchemaVersion int              `json:"schemaVersion"`
	BinarySHA256  string           `json:"binarySha256"`
	Context       string           `json:"context"`
	PluginsDigest string           `json:"pluginsDigest"`
	RecordedAt    time.Time        `json:"recordedAt"`
	Inventory     CommandInventory `json:"inventory"`
}

// inventoryFlight is one in-progress walk that later callers can wait on.
type inventoryFlight struct {
	done      chan struct{}
	inventory CommandInventory
}

// WarmCommandInventory starts the help walk in the background if it is not already cached.
//
// Called at core start, before any request arrives. On a warm cache this reads one small file
// and exits; on a cold one it runs the walk while Electron and the renderer are still starting,
// which is the difference between the walk costing the launch three seconds and costing it
// nothing. Failures are silent by design: this is a pre-computation, and every path it feeds
// re-derives the answer for itself if it is missing.
func (s *Service) WarmCommandInventory(ctx context.Context) {
	if s.docker == nil {
		return
	}
	go func() {
		selected := s.currentContextName(ctx)
		if err := validateContextName(selected); err != nil {
			return
		}
		s.commandInventory(ctx, s.docker.binary, selected)
	}()
}

// currentContextName resolves the context the walk should be keyed by, the same way
// capabilities resolves it, so warming and the first request agree on a key.
func (s *Service) currentContextName(ctx context.Context) string {
	result, err := s.runDiscovery(ctx, nil, "context", "show")
	if err != nil || result.exitCode != 0 || result.timedOut {
		return "default"
	}
	name := strings.TrimSpace(string(result.stdout))
	if name == "" {
		return "default"
	}
	return name
}

// commandInventory returns the walk for this binary, context and plugin set, computing it at
// most once across every concurrent caller.
func (s *Service) commandInventory(
	ctx context.Context,
	binary BinaryFingerprint,
	selectedContext string,
) CommandInventory {
	if binary.SHA256 == "" {
		return s.discoverCommandInventory(ctx, selectedContext)
	}
	// The plugin digest costs one `docker info` (~60ms). It runs before the cache is consulted
	// because it is part of the key: without it a cache hit could describe a plugin set the
	// operator has since changed.
	digest := s.pluginSetDigest(ctx, selectedContext)
	key := inventoryCacheKey(binary.SHA256, selectedContext, digest)

	s.inventoryMu.Lock()
	if cached, ok := s.inventoryCache[key]; ok {
		s.inventoryMu.Unlock()
		return cached
	}
	if flight, ok := s.inventoryFlights[key]; ok {
		s.inventoryMu.Unlock()
		select {
		case <-flight.done:
			return flight.inventory
		case <-ctx.Done():
			// This caller is gone; the walk continues for whoever is next.
			return s.discoverCommandInventory(ctx, selectedContext)
		}
	}
	flight := &inventoryFlight{done: make(chan struct{})}
	if s.inventoryFlights == nil {
		s.inventoryFlights = map[string]*inventoryFlight{}
	}
	s.inventoryFlights[key] = flight
	s.inventoryMu.Unlock()

	inventory, cacheable := s.resolveCommandInventory(ctx, selectedContext, key, binary, digest)
	flight.inventory = inventory
	close(flight.done)

	s.inventoryMu.Lock()
	delete(s.inventoryFlights, key)
	if cacheable {
		if s.inventoryCache == nil {
			s.inventoryCache = map[string]CommandInventory{}
		}
		s.inventoryCache[key] = inventory
	}
	s.inventoryMu.Unlock()
	return inventory
}

func (s *Service) resolveCommandInventory(
	ctx context.Context,
	selectedContext string,
	key string,
	binary BinaryFingerprint,
	digest string,
) (CommandInventory, bool) {
	if digest != "" {
		if cached, ok := readInventoryCache(key, binary.SHA256, selectedContext, digest); ok {
			return cached, true
		}
	}
	// The walk is detached from the caller's cancellation: a renderer that gives up mid-flight
	// would otherwise leave the next launch to pay for it again, and the subprocesses it has
	// already spawned are sunk cost either way. It keeps its own timeout instead.
	walkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), inventoryWalkTimeout)
	defer cancel()
	inventory := s.discoverCommandInventory(walkCtx, selectedContext)
	// Never persist or memoize a partial walk: a cancelled or truncated discovery would
	// otherwise be served as though it were the whole command surface.
	if !inventory.Complete || inventory.LimitReached {
		return inventory, false
	}
	if digest != "" {
		writeInventoryCache(key, inventoryCacheRecord{
			SchemaVersion: inventoryCacheSchemaVersion,
			BinarySHA256:  binary.SHA256,
			Context:       selectedContext,
			PluginsDigest: digest,
			RecordedAt:    time.Now().UTC(),
			Inventory:     inventory,
		})
	}
	return inventory, true
}

// pluginSetDigest fingerprints the CLI plugins the client reports.
//
// Returns "" when the plugin set cannot be determined, which disables the disk cache for this
// call rather than keying it on an assumption. An in-process memo is still safe there: it
// cannot outlive the installation it was taken from.
func (s *Service) pluginSetDigest(ctx context.Context, selectedContext string) string {
	args := withContext(selectedContext, "info", "--format", "{{json .ClientInfo.Plugins}}")
	result, err := s.runDiscovery(ctx, nil, args...)
	if err != nil || result.exitCode != 0 || result.timedOut || result.stdoutTruncated {
		return ""
	}
	var plugins []struct {
		Name          string `json:"Name"`
		Version       string `json:"Version"`
		Path          string `json:"Path"`
		SchemaVersion string `json:"SchemaVersion"`
	}
	if err := json.Unmarshal(result.stdout, &plugins); err != nil {
		return ""
	}
	// Sorted so the digest describes the set rather than the order the client happened to
	// list it in.
	entries := make([]string, 0, len(plugins))
	for _, plugin := range plugins {
		entries = append(entries, strings.Join(
			[]string{plugin.Name, plugin.Version, plugin.Path, plugin.SchemaVersion}, "\x00",
		))
	}
	sort.Strings(entries)
	sum := sha256.Sum256([]byte(strings.Join(entries, "\x01")))
	return hex.EncodeToString(sum[:])
}

func inventoryCacheKey(binarySHA256, selectedContext, pluginsDigest string) string {
	sum := sha256.Sum256([]byte(strings.Join(
		[]string{binarySHA256, selectedContext, pluginsDigest}, "\x00",
	)))
	return hex.EncodeToString(sum[:])
}

// inventoryCachePath is under the user's own cache directory, which is where a derived,
// regenerable artifact belongs: removing it costs one walk and nothing else. ANCHORAGE_CACHE_DIR
// overrides it so a test can exercise the cache without touching the developer's.
func inventoryCachePath(key string) (string, error) {
	base := strings.TrimSpace(os.Getenv("ANCHORAGE_CACHE_DIR"))
	if base == "" {
		userCache, err := os.UserCacheDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(userCache, "anchorage")
	}
	if !filepath.IsAbs(base) {
		return "", errors.New("cache directory must be absolute")
	}
	return filepath.Join(base, "command-inventory", key+".json"), nil
}

func readInventoryCache(key, binarySHA256, selectedContext, pluginsDigest string) (CommandInventory, bool) {
	path, err := inventoryCachePath(key)
	if err != nil {
		return CommandInventory{}, false
	}
	file, err := os.Open(path)
	if err != nil {
		return CommandInventory{}, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > inventoryCacheMaxBytes {
		return CommandInventory{}, false
	}
	var record inventoryCacheRecord
	if err := json.NewDecoder(file).Decode(&record); err != nil {
		return CommandInventory{}, false
	}
	// Every field of the key is re-checked against the file's own copy. The filename is a hash
	// of the key, so a mismatch means a collision or a hand-edited file; either way the walk is
	// cheaper than being wrong about what Docker can do.
	if record.SchemaVersion != inventoryCacheSchemaVersion ||
		record.BinarySHA256 != binarySHA256 ||
		record.Context != selectedContext ||
		record.PluginsDigest != pluginsDigest {
		return CommandInventory{}, false
	}
	if record.RecordedAt.IsZero() || time.Since(record.RecordedAt) > inventoryCacheMaxAge {
		return CommandInventory{}, false
	}
	if record.Inventory.Root == nil || !record.Inventory.Complete || record.Inventory.LimitReached {
		return CommandInventory{}, false
	}
	if record.Inventory.Warnings == nil {
		record.Inventory.Warnings = []string{}
	}
	return record.Inventory, true
}

func writeInventoryCache(key string, record inventoryCacheRecord) {
	path, err := inventoryCachePath(key)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return
	}
	// Written to a temporary file and renamed so a concurrent reader sees either the previous
	// document or the new one, never a half-written one.
	temp, err := os.CreateTemp(filepath.Dir(path), ".inventory-*")
	if err != nil {
		return
	}
	tempPath := temp.Name()
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		os.Remove(tempPath)
		return
	}
	if _, err := temp.Write(encoded); err != nil {
		temp.Close()
		os.Remove(tempPath)
		return
	}
	if err := temp.Close(); err != nil {
		os.Remove(tempPath)
		return
	}
	if err := os.Rename(tempPath, path); err != nil {
		os.Remove(tempPath)
	}
}
