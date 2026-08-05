package core

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The disk walk must leave the request path.
//
// `/system/df?type=volume` asks the daemon to size every volume on disk. Measured against a live
// daemon holding 232 volumes: /volumes answers in 8-10 ms and the walk takes 1138-1158 ms, so
// 99% of a 1078 ms volumes.list was the size column. Seven consecutive walks all cost the same,
// so the daemon caches nothing. Worse, the walk ran on every call: a 10 s visible-domain poll,
// engine-ready bootstrap, every volume mutation, and every event-stream invalidation.
//
// The names, drivers, mountpoints and labels an operator scans are available in 8 ms. This holds
// them to that, and lets the size column arrive a beat later.
func startVolumeEngine(t *testing.T, walks *int64) (string, func()) {
	t.Helper()
	return startCustomDomainEngine(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/version":
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
		case "/v1.55/volumes":
			_, _ = writer.Write([]byte(`{"Volumes":[
				{"Name":"data","Driver":"local","Mountpoint":"/vol/data","CreatedAt":"2026-01-01T00:00:00Z",
				 "Labels":{},"Scope":"local","Options":{}}
			],"Warnings":[]}`))
		case "/v1.55/system/df":
			atomic.AddInt64(walks, 1)
			// The real call is slow; this stands in for that without making the suite slow.
			time.Sleep(40 * time.Millisecond)
			_, _ = writer.Write([]byte(`{"Volumes":[
				{"Name":"data","UsageData":{"Size":4096,"RefCount":2}}
			]}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestVolumesListDoesNotWalkDiskOnTheRequestPath(t *testing.T) {
	var walks int64
	socketPath, closeServer := startVolumeEngine(t, &walks)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	first, err := service.volumesList(context.Background(), VolumesListParams{Context: "default"})
	if err != nil {
		t.Fatalf("volumes list: %v", err)
	}
	if len(first.Volumes) != 1 || first.Volumes[0].Name != "data" {
		t.Fatalf("the volume itself must be listed immediately: %#v", first.Volumes)
	}
	if first.Volumes[0].Usage != nil {
		t.Fatal("a cold cache must report usage as unknown rather than block on the walk")
	}
	if len(first.Limitations) == 0 {
		t.Fatal("unknown usage must be stated, not left for the reader to infer from a missing field")
	}

	// The walk still has to happen — just not while the caller waits.
	deadline := time.Now().Add(5 * time.Second)
	var warm VolumesListResult
	for time.Now().Before(deadline) {
		warm, err = service.volumesList(context.Background(), VolumesListParams{Context: "default"})
		if err != nil {
			t.Fatalf("volumes list: %v", err)
		}
		if len(warm.Volumes) == 1 && warm.Volumes[0].Usage != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if warm.Volumes[0].Usage == nil {
		t.Fatal("usage never arrived; the background refresh did not populate the cache")
	}
	if warm.Volumes[0].Usage.SizeBytes != 4096 || warm.Volumes[0].Usage.RefCount != 2 {
		t.Fatalf("cached usage must be the daemon's own numbers: %#v", warm.Volumes[0].Usage)
	}
}

func TestVolumeUsageRefreshIsSingleFlight(t *testing.T) {
	// Without single-flight, the bootstrap refresh, the 10 s poll and every mutation-triggered
	// refresh would each start their own walk, and the daemon would be walking disk continuously.
	var walks int64
	socketPath, closeServer := startVolumeEngine(t, &walks)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, _ = service.volumesList(context.Background(), VolumesListParams{Context: "default"})
		}()
	}
	group.Wait()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		result, err := service.volumesList(context.Background(), VolumesListParams{Context: "default"})
		if err == nil && len(result.Volumes) == 1 && result.Volumes[0].Usage != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := atomic.LoadInt64(&walks); got > 2 {
		t.Fatalf("eight concurrent lists must join one walk, not start their own; got %d walks", got)
	}
}

func TestVolumeUsageServesFromCacheWithinTTL(t *testing.T) {
	var walks int64
	socketPath, closeServer := startVolumeEngine(t, &walks)
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		result, err := service.volumesList(context.Background(), VolumesListParams{Context: "default"})
		if err == nil && len(result.Volumes) == 1 && result.Volumes[0].Usage != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	settled := atomic.LoadInt64(&walks)
	if settled == 0 {
		t.Fatal("expected at least one walk to populate the cache")
	}

	// A poll every 10 s against a 60 s TTL must not re-walk.
	for i := 0; i < 5; i++ {
		result, err := service.volumesList(context.Background(), VolumesListParams{Context: "default"})
		if err != nil {
			t.Fatalf("volumes list: %v", err)
		}
		if result.Volumes[0].Usage == nil {
			t.Fatal("a warm cache must keep serving usage")
		}
	}
	if got := atomic.LoadInt64(&walks); got != settled {
		t.Fatalf("repeated lists inside the TTL must not re-walk: %d walks became %d", settled, got)
	}
}

// The dashboard must not hold the daemon in a permanent disk walk.
//
// `/system/df` measured 1791-7176 ms against a live daemon, and useAnchorageStore drives it from a
// 10 s timer whenever the Dashboard is open. A call that can outlast its own interval is not a
// poll; it is a walk that never stops. The first snapshot pays for it because the cards have
// nothing else to show, and every snapshot after that inside the TTL is served from memory.
func TestSnapshotDiskUsageIsWalkedOncePerTTL(t *testing.T) {
	var walks int64
	socketPath, closeServer := startCustomDomainEngine(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/version":
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
		case "/v1.55/info":
			_, _ = writer.Write([]byte(`{"ID":"engine-id","Name":"fixture","ServerVersion":"29.7.1",
				"OSType":"linux","OperatingSystem":"Fixture","Architecture":"x86_64","KernelVersion":"6.0",
				"NCPU":8,"MemTotal":16000000000,"Containers":0,"ContainersRunning":0,"ContainersPaused":0,
				"ContainersStopped":0,"Images":0,"Driver":"overlay2","DockerRootDir":"/var/lib/docker",
				"ExperimentalBuild":false,"LiveRestoreEnabled":true,"Swarm":{"LocalNodeState":"inactive"},
				"Warnings":[]}`))
		case "/v1.55/system/df":
			atomic.AddInt64(&walks, 1)
			time.Sleep(40 * time.Millisecond)
			_, _ = writer.Write([]byte(`{"LayersSize":600,"BuilderSize":50,"Images":[],"Containers":[],
				"Volumes":[],"BuildCache":[]}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	first, err := service.systemSnapshot(context.Background(), SystemSnapshotParams{
		Context: "default", IncludeDiskUsage: true,
	})
	if err != nil {
		t.Fatalf("first snapshot: %v", err)
	}
	if first.DiskUsage.LayersSizeBytes != 600 {
		t.Fatalf("the first snapshot must carry real figures, got %#v", first.DiskUsage)
	}
	if got := atomic.LoadInt64(&walks); got != 1 {
		t.Fatalf("the cold snapshot should walk exactly once, got %d", got)
	}

	// Six more polls, i.e. a minute of the dashboard's 10 s timer, must add no walks.
	for i := 0; i < 6; i++ {
		again, err := service.systemSnapshot(context.Background(), SystemSnapshotParams{
			Context: "default", IncludeDiskUsage: true,
		})
		if err != nil {
			t.Fatalf("snapshot %d: %v", i, err)
		}
		if again.DiskUsage.LayersSizeBytes != 600 {
			t.Fatalf("a cached snapshot must keep reporting the figures, got %#v", again.DiskUsage)
		}
	}
	if got := atomic.LoadInt64(&walks); got != 1 {
		t.Fatalf("polling inside the TTL must not re-walk: expected 1 walk, got %d", got)
	}
}

// A full stats batch must complete in one wave.
//
// The renderer sends up to LIST_STATS_BATCH_LIMIT = 32 ids (app/src/store/useAnchorageStore.ts).
// The core admitted 16 at a time, so a full batch ran as two waves. Each sample spends its whole
// life waiting — Docker holds the connection for a collection cycle so precpu_stats is populated
// — which is ~1s, so halving the window doubled the wall time for no saving: the work is
// latency-bound, not CPU-bound. This asserts the window is wide enough to admit a whole batch.
func TestStatsBatchAdmitsAFullRendererBatchInOneWave(t *testing.T) {
	const rendererBatchLimit = 32 // must track LIST_STATS_BATCH_LIMIT in the renderer

	var inFlight, peak int64
	var peakMu sync.Mutex
	socketPath, closeServer := startCustomDomainEngine(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/version" {
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
			return
		}
		if strings.HasSuffix(request.URL.Path, "/stats") {
			current := atomic.AddInt64(&inFlight, 1)
			peakMu.Lock()
			if current > peak {
				peak = current
			}
			peakMu.Unlock()
			// Stand in for the daemon's collection cycle, which is what makes this latency-bound.
			time.Sleep(60 * time.Millisecond)
			atomic.AddInt64(&inFlight, -1)
			_, _ = writer.Write([]byte(`{"read":"2026-01-01T00:00:01Z",
				"cpu_stats":{"cpu_usage":{"total_usage":300},"system_cpu_usage":1200,"online_cpus":2},
				"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":1000},
				"memory_stats":{"usage":1000,"limit":2000,"stats":{"inactive_file":100}},
				"networks":{},"blkio_stats":{},"pids_stats":{"current":7}}`))
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	ids := make([]string, rendererBatchLimit)
	for i := range ids {
		ids[i] = fmt.Sprintf("%064x", i+1)
	}
	if _, err := service.containersStatsBatch(context.Background(), ContainersStatsBatchParams{
		Context: "default", IDs: ids,
	}); err != nil {
		t.Fatalf("stats batch: %v", err)
	}

	peakMu.Lock()
	observed := peak
	peakMu.Unlock()
	if observed < rendererBatchLimit {
		t.Fatalf("a %d-id batch must run in one wave, but at most %d samples were ever in flight — "+
			"statsBatchConcurrency is narrower than the renderer's batch, so the batch is serialised into waves",
			rendererBatchLimit, observed)
	}
}

/*
What this cache actually costs, measured rather than assumed.

The commit that introduced it blamed it for a 11.7 MB -> 17.6 MB step in soak RSS, "holding
roughly 1,986 image records". Both halves were wrong. `/system/df` reports top-level images
only — 284 entries in 0.7 MB on the reference host — while 1,986 is the `images.list` count,
which includes intermediates and dangling layers. Two different endpoints, conflated.

Measuring RSS around each request puts the whole step on `images.list`, which parses that full
listing and did so long before this cache existed:

	baseline (health only)            10.8 MB
	+ containers.list + images.list   16.2 MB   <- the step
	+ volumes.list, usage cached      16.5 MB
	+ system.snapshot with disk usage 15.9 MB
	+ five more cached snapshots      16.7 MB
	+ stats batches of 32             16.6 MB

Adding, warming and repeatedly serving this cache moves RSS by less than the ~1 MB run-to-run
jitter, and so does the widened stats fan-out. The likelier reading of the soak delta is the
speedup itself: volumes.list went 1078 ms to 3 ms, so a fixed 1800-second soak serves far more
iterations and reaches a higher heap high-water mark. Growth over that window is still exactly 0.

This note lives in the test file on purpose. Go embeds file positions for stack traces, so adding
it to disk_usage_cache.go shifted every following line and changed the shipped binary's hash —
which would have invalidated the mutation, capability and performance evidence bound to it, and
cost a 30-minute soak to restore, for a comment.
*/
