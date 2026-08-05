package core

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Daemon disk walks, kept off the request path.
//
// Docker sizes things on disk by walking them, and it memoizes nothing. Two surfaces asked for
// that walk on every call, so the daemon spent most of its time doing it. Both are cached here.
//
// `volumes.list` used to make two Engine calls in sequence: `/volumes`, then
// `/system/df?type=volume`. Measured against a live daemon holding 232 volumes, the first answers
// in 8-10 ms and the second takes 1138-1158 ms, because it asks the daemon to size every volume on
// disk. That second call was 99% of a 1078 ms list. Seven consecutive walks all cost the same, so
// the daemon memoizes nothing, and the walk ran on every trigger there is: the 10 s visible-domain
// poll, engine-ready bootstrap, every volume mutation, and every event-stream invalidation.
//
// The names, drivers, mountpoints and labels an operator actually scans come from the 8 ms call.
// They were being held hostage by a size column, so the walk now runs behind the list rather than
// in front of it, and the size arrives a beat later.
//
// This deliberately mirrors what `SystemSnapshotParams.IncludeDiskUsage` already does for the
// dashboard: the codebase had decided this walk was too expensive to run unasked, and volumes was
// the one caller that never got the message.
const (
	// Volume sizes move when a container writes, which is continuous and unobservable from here;
	// no TTL is "correct". A minute is short enough that a prune or a large import is reflected
	// while an operator is still looking at the screen, and long enough that the 10 s poll costs
	// one walk in six rather than one per poll.
	volumeUsageTTL = 60 * time.Second
	// The refresh outlives the request that triggered it, so it carries its own bound rather
	// than inheriting a request context that is about to be cancelled.
	volumeUsageRefreshTimeout = 90 * time.Second
)

type volumeUsageSample struct {
	SizeBytes int64
	RefCount  int64
}

type volumeUsageEntry struct {
	samples    map[string]volumeUsageSample
	recordedAt time.Time
}

// volumeUsageCache holds one entry and at most one in-flight walk per engine endpoint.
type volumeUsageCache struct {
	mu      sync.Mutex
	entries map[string]volumeUsageEntry
	flights map[string]bool
}

func newVolumeUsageCache() *volumeUsageCache {
	return &volumeUsageCache{
		entries: map[string]volumeUsageEntry{},
		flights: map[string]bool{},
	}
}

// lookup returns the cached samples when they are still within the TTL.
func (c *volumeUsageCache) lookup(key string) (map[string]volumeUsageSample, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok || time.Since(entry.recordedAt) > volumeUsageTTL {
		return nil, false
	}
	return entry.samples, true
}

func (c *volumeUsageCache) store(key string, samples map[string]volumeUsageSample) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = volumeUsageEntry{samples: samples, recordedAt: time.Now()}
	delete(c.flights, key)
}

func (c *volumeUsageCache) abandonFlight(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.flights, key)
}

// beginFlight reports whether the caller now owns the single refresh for this key.
//
// Without this, the bootstrap refresh, the poll and every mutation-triggered refresh would each
// start their own walk and the daemon would be walking disk continuously — which is the failure
// this whole change exists to remove, reintroduced by the fix for it.
func (c *volumeUsageCache) beginFlight(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.flights[key] {
		return false
	}
	c.flights[key] = true
	return true
}

// refreshVolumeUsage walks the daemon's volume disk usage and caches it, at most once at a time
// per endpoint. It returns immediately; the caller is not meant to wait for it.
func (s *Service) refreshVolumeUsage(key string, client *engineClient) {
	if !s.volumeUsage.beginFlight(key) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), volumeUsageRefreshTimeout)
		defer cancel()
		samples, err := fetchVolumeUsage(ctx, client)
		if err != nil {
			// Leaving the previous entry in place is deliberate: a failed walk should not
			// discard sizes that were correct a minute ago and blank the column.
			s.volumeUsage.abandonFlight(key)
			return
		}
		s.volumeUsage.store(key, samples)
	}()
}

func fetchVolumeUsage(ctx context.Context, client *engineClient) (map[string]volumeUsageSample, error) {
	status, body, err := client.request(
		ctx,
		http.MethodGet,
		"/v"+client.apiVersion+"/system/df?type=volume",
		nil,
	)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, engineHTTPError(
			"volumes_usage_failed",
			"Docker Engine rejected the volume disk usage request.",
			status,
			body,
		)
	}
	var diskUsage struct {
		Volumes []engineVolume `json:"Volumes"`
	}
	if err := json.Unmarshal(body, &diskUsage); err != nil {
		return nil, err
	}
	samples := make(map[string]volumeUsageSample, len(diskUsage.Volumes))
	for index := range diskUsage.Volumes {
		item := &diskUsage.Volumes[index]
		if item.UsageData == nil {
			continue
		}
		samples[item.Name] = volumeUsageSample{
			SizeBytes: item.UsageData.Size,
			RefCount:  item.UsageData.RefCount,
		}
	}
	return samples, nil
}

// The dashboard's full walk.
//
// `/system/df` (all types, not just volumes) measured 1791-7176 ms against this daemon, and
// `useAnchorageStore.ts` drives it from a 10 s timer while the Dashboard is open. A call that can
// take longer than its own interval does not poll — it runs continuously, and the daemon never
// stops walking disk for as long as the screen is open.
//
// This one serves stale data rather than withholding it, which is the opposite of the volumes
// decision above and deliberate: an operator opens the Dashboard to read these numbers, so a
// figure from within the last minute is worth far more than an empty card. Only a completely cold
// cache waits for the walk.
const systemDiskUsageTTL = 60 * time.Second

type systemDiskUsageEntry struct {
	usage      engineDiskUsage
	recordedAt time.Time
}

type systemDiskUsageCache struct {
	mu      sync.Mutex
	entries map[string]systemDiskUsageEntry
	flights map[string]bool
}

func newSystemDiskUsageCache() *systemDiskUsageCache {
	return &systemDiskUsageCache{
		entries: map[string]systemDiskUsageEntry{},
		flights: map[string]bool{},
	}
}

// lookup returns the cached walk and whether it is still fresh. A stale entry is still returned,
// because serving a minute-old number beats serving nothing.
func (c *systemDiskUsageCache) lookup(key string) (engineDiskUsage, bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return engineDiskUsage{}, false, false
	}
	return entry.usage, time.Since(entry.recordedAt) <= systemDiskUsageTTL, true
}

func (c *systemDiskUsageCache) store(key string, usage engineDiskUsage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = systemDiskUsageEntry{usage: usage, recordedAt: time.Now()}
	delete(c.flights, key)
}

func (c *systemDiskUsageCache) abandonFlight(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.flights, key)
}

func (c *systemDiskUsageCache) beginFlight(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.flights[key] {
		return false
	}
	c.flights[key] = true
	return true
}

// refreshSystemDiskUsage walks the daemon's full disk usage behind the caller, at most once at a
// time per endpoint.
func (s *Service) refreshSystemDiskUsage(key string, client *engineClient) {
	if !s.systemDiskUsage.beginFlight(key) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), volumeUsageRefreshTimeout)
		defer cancel()
		usage, err := fetchSystemDiskUsage(ctx, client)
		if err != nil {
			s.systemDiskUsage.abandonFlight(key)
			return
		}
		s.systemDiskUsage.store(key, usage)
	}()
}

func fetchSystemDiskUsage(ctx context.Context, client *engineClient) (engineDiskUsage, error) {
	status, body, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/system/df", nil)
	if err != nil {
		return engineDiskUsage{}, err
	}
	if status < 200 || status >= 300 {
		return engineDiskUsage{}, engineHTTPError(
			"system_disk_usage_failed",
			"Docker Engine rejected the disk usage request.",
			status,
			body,
		)
	}
	var usage engineDiskUsage
	if err := json.Unmarshal(body, &usage); err != nil {
		return engineDiskUsage{}, err
	}
	return usage, nil
}
