package core

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/*
Listing a directory stats every entry, and the stats used to run one after another.

Each entry costs one `HEAD /archive` — a round trip that spends all of its time waiting on the
daemon. maxFileEntries is 500, so a full directory meant up to 500 sequential requests for a
single hop, measured at roughly 1.5-2 s. Nothing about them is ordered or dependent; they are
latency, and latency overlaps.

Two properties matter and neither is visible from the outside: that the stats actually overlap,
and that overlapping them does not let the listing reorder itself according to which stat
happened to answer first.
*/

// A daemon that answers just enough for one exec listing plus a stat per name.
func fakeArchiveDaemon(t *testing.T, names []string, onStat func()) *engineClient {
	t.Helper()

	frame := func(payload string) []byte {
		header := make([]byte, 8)
		header[0] = 1
		binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
		return append(header, payload...)
	}

	handler := http.NewServeMux()
	handler.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/exec"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Id":"exec-1"}`))
		case strings.HasSuffix(r.URL.Path, "/start"):
			_, _ = w.Write(frame(strings.Join(names, "\n") + "\n"))
		case strings.HasSuffix(r.URL.Path, "/json"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ExitCode":0,"Running":false}`))
		case r.Method == http.MethodHead && strings.HasSuffix(r.URL.Path, "/archive"):
			onStat()
			target := r.URL.Query().Get("path")
			slash := strings.LastIndex(target, "/")
			stat, _ := json.Marshal(map[string]any{
				"name": target[slash+1:], "size": 1, "mode": 0o644,
				"mtime": "2026-08-07T10:00:00Z",
			})
			w.Header().Set("X-Docker-Container-Path-Stat",
				base64.StdEncoding.EncodeToString(stat))
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	address := server.Listener.Addr().String()

	// statArchiveEntry builds an absolute http://docker/... URL, so the transport is what
	// decides where it lands.
	return &engineClient{
		apiVersion: "1.55",
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "tcp", address)
				},
			},
		},
		endpoint: contextEndpoint{},
	}
}

func TestVolumeListingStatsEntriesConcurrently(t *testing.T) {
	names := make([]string, 64)
	for i := range names {
		names[i] = fmt.Sprintf("entry-%02d", i)
	}

	var inFlight, peak int64
	var mu sync.Mutex
	client := fakeArchiveDaemon(t, names, func() {
		current := atomic.AddInt64(&inFlight, 1)
		mu.Lock()
		if current > peak {
			peak = current
		}
		mu.Unlock()
		// Long enough that a serial implementation cannot overlap by accident, short enough
		// that 64 stats at a width of 16 stay well inside the test's own patience.
		time.Sleep(15 * time.Millisecond)
		atomic.AddInt64(&inFlight, -1)
	})

	service := &Service{}
	service.helperMu.Lock()
	service.startedHelpers = map[string]bool{"helper-1": true}
	service.helperMu.Unlock()

	entries, _, source, err := service.listVolumeChildren(
		context.Background(), client, "helper-1", volumeHelperMount)
	if err != nil {
		t.Fatalf("listing failed: %v", err)
	}
	if source != "exec" {
		t.Fatalf("a started helper should list by exec, got %q", source)
	}
	if len(entries) != len(names) {
		t.Fatalf("expected %d entries, got %d", len(names), len(entries))
	}

	mu.Lock()
	observed := peak
	mu.Unlock()
	if observed < 2 {
		t.Fatalf("the stats ran one at a time (peak concurrency %d)", observed)
	}
	if observed > volumeStatConcurrency {
		t.Fatalf("the fan-out exceeded its own gate: peak %d, limit %d",
			observed, volumeStatConcurrency)
	}
}

func TestVolumeListingKeepsTheOrderTheListingGaveIt(t *testing.T) {
	names := []string{"zebra", "alpha", "middle", "beta"}
	// Answers in reverse order of arrival, so an append-as-they-finish implementation would
	// produce a different sequence from the one `ls` reported.
	delays := map[string]time.Duration{
		"zebra": 40 * time.Millisecond, "alpha": 30 * time.Millisecond,
		"middle": 20 * time.Millisecond, "beta": 0,
	}
	var mu sync.Mutex
	pending := names
	client := fakeArchiveDaemon(t, names, func() {
		mu.Lock()
		next := pending[0]
		pending = pending[1:]
		mu.Unlock()
		time.Sleep(delays[next])
	})

	service := &Service{}
	service.helperMu.Lock()
	service.startedHelpers = map[string]bool{"helper-1": true}
	service.helperMu.Unlock()

	entries, _, _, err := service.listVolumeChildren(
		context.Background(), client, "helper-1", volumeHelperMount)
	if err != nil {
		t.Fatalf("listing failed: %v", err)
	}
	for index, name := range names {
		if entries[index].Name != name {
			t.Fatalf("entry %d should be %q, got %q — the listing reordered itself",
				index, name, entries[index].Name)
		}
	}
}
