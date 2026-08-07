package core

import (
	"context"
	"encoding/binary"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestVolumePathsAreScopedToTheVolumeRoot(t *testing.T) {
	// The operator browses the volume as if it were the filesystem root; internally that is
	// the helper's mount point. Leaking the mount prefix would expose an implementation
	// detail, and accepting a path outside it would expose the helper's own filesystem.
	for _, testCase := range []struct{ requested, internal string }{
		{"", volumeHelperMount},
		{"/", volumeHelperMount},
		{"/sub", volumeHelperMount + "/sub"},
		{"/sub/deep.txt", volumeHelperMount + "/sub/deep.txt"},
	} {
		internal, err := volumeInternalPath(testCase.requested)
		if err != nil {
			t.Fatalf("%q should map: %v", testCase.requested, err)
		}
		if internal != testCase.internal {
			t.Fatalf("%q mapped to %q, want %q", testCase.requested, internal, testCase.internal)
		}
		if visible := volumeVisiblePath(internal); visible != normalizedOrRoot(testCase.requested) {
			t.Fatalf("%q round-tripped to %q", testCase.requested, visible)
		}
	}

	// Traversal must not escape into the helper image's filesystem.
	for _, bad := range []string{"/../etc", "sub", "../../etc/passwd", "/sub/../../.."} {
		if _, err := volumeInternalPath(bad); err == nil {
			t.Fatalf("%q must be rejected", bad)
		}
	}
}

func normalizedOrRoot(requested string) string {
	if requested == "" {
		return "/"
	}
	normalized, err := normalizeContainerPath(requested)
	if err != nil {
		return requested
	}
	return normalized
}

func TestVolumeHelperMountIsReadOnlyAndDistinctive(t *testing.T) {
	// The mount point is compared against entry paths, so a generic name like /mnt could
	// collide with a real directory in the helper image and confuse the listing.
	if volumeHelperMount == "/mnt" || volumeHelperMount == "/data" || volumeHelperMount == "/" {
		t.Fatalf("volume helper mount %q is too generic", volumeHelperMount)
	}
}

func TestVolumeHelperKeySeparatesReadFromWrite(t *testing.T) {
	/*
		The bind is fixed when the helper container is created, so a read-only helper can never
		serve a write. Reusing helpers made that a real hazard rather than a theoretical one:
		before this, every request built its own container and the mount mode came along with
		it, so nothing could be handed the wrong one.
	*/
	if volumeHelperKey("data", false) == volumeHelperKey("data", true) {
		t.Fatal("a read-only helper must not be reused for a write")
	}
	// And two volumes must never share, whatever their names look like next to each other.
	if volumeHelperKey("a", false) == volumeHelperKey("a\x00ro", false) {
		t.Fatal("volume names must not be able to collide through the key separator")
	}
	if volumeHelperKey("data", false) != volumeHelperKey("data", false) {
		t.Fatal("the key must be stable for the same volume and mode")
	}
}

func TestParkVolumeHelperKeepsOnlyOneAndHoldsIt(t *testing.T) {
	/*
		Two properties at once, both of which a leak would break quietly.

		A parked helper stays in `liveHelpers`, because the sweep finds helpers by label and
		would otherwise force-remove a container the next request is about to reuse. And only
		one is parked at a time: browsing several volumes must not pin a container on each,
		which would hold a reference on every one of them and block their removal.
	*/
	service := &Service{}
	if !service.parkVolumeHelper("vol-a\x00ro", "container-a", nil) {
		t.Fatal("the first helper should park")
	}
	service.helperMu.Lock()
	held := service.liveHelpers["container-a"]
	parked := len(service.parkedHelpers)
	service.helperMu.Unlock()
	if !held {
		t.Fatal("a parked helper must stay held, or a sweep will remove it mid-reuse")
	}
	if parked != 1 {
		t.Fatalf("parked = %d, want 1", parked)
	}

	// A second key evicts the first rather than accumulating. The eviction removes the
	// container on a goroutine with a nil client here, which is why this only asserts the map.
	if !service.parkVolumeHelper("vol-b\x00ro", "container-b", nil) {
		t.Fatal("the second helper should park")
	}
	service.helperMu.Lock()
	defer service.helperMu.Unlock()
	if len(service.parkedHelpers) != 1 {
		t.Fatalf("parked = %d, want 1 — helpers must not accumulate", len(service.parkedHelpers))
	}
	if _, ok := service.parkedHelpers["vol-b\x00ro"]; !ok {
		t.Fatal("the newest helper should be the one kept")
	}
}

func TestArchiveScanBoundsAreBothNeeded(t *testing.T) {
	/*
		Measured against a real 625 GB volume: asking the archive endpoint for `/` returned the
		first top-level entry immediately, then descended into it and streamed 1,053 MB in two
		seconds without ever reaching the second one. The endpoint returns a directory's whole
		subtree, depth-first, so every direct child after the first sits behind everything
		beneath it.

		An entry count cannot bound that on its own, because 20,000 entries can be any number
		of bytes — which is why the byte and time bounds exist alongside it. This pins that all
		three are present and that none has been widened into uselessness.
	*/
	if maxArchiveScanBytes <= 0 || maxArchiveScanBytes > 256*1024*1024 {
		t.Fatalf("byte bound is %d — a listing that streams more than a few hundred MB is not a listing", maxArchiveScanBytes)
	}
	if maxArchiveScanTime <= 0 || maxArchiveScanTime > 30*time.Second {
		t.Fatalf("time bound is %v — the point is to fail fast rather than stall", maxArchiveScanTime)
	}
	if maxArchiveDescendants <= 0 {
		t.Fatal("the descendant bound is still needed for directories with many tiny files")
	}
}

func TestVolumeArchiveTooLargeNamesTheMechanism(t *testing.T) {
	// "Listing failed" is not actionable. Knowing the directory is fine and the method is not
	// tells the operator the volume is intact and this is Anchorage's limitation.
	err := volumeArchiveTooLarge("/anchorage-volume", 1_053_000_000, 1)
	if err.Code != "volume_directory_too_large" {
		t.Fatalf("code = %q", err.Code)
	}
	if !strings.Contains(err.Message, "whole subtree") {
		t.Fatalf("the message must name why, got %q", err.Message)
	}
	// The count is the tell: on a very large volume it is usually one, which makes the shape
	// of the problem obvious without reading any code.
	if err.Details["entriesFound"] != 1 || err.Details["bytesScanned"] != int64(1_053_000_000) {
		t.Fatalf("details = %v", err.Details)
	}
}

func TestDemultiplexStripsDockerStreamFraming(t *testing.T) {
	/*
		Got wrong first, and visibly. `Tty: true` avoids this framing entirely, which is why it
		was the first choice — but `ls` then believes it is on a terminal and answers in
		columns wrapped in ANSI colour, so a whole directory came back as one "entry" reading
		"\x1b[1;34mlive-capture\x1b[m  \x1b[1;34mregistry\x1b[m". Parsing eight bytes is the
		cheaper problem.
	*/
	frame := func(payload string) []byte {
		header := []byte{1, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(header[4:8], uint32(len(payload)))
		return append(header, payload...)
	}
	raw := append(frame("live-capture\n"), frame("registry\n")...)
	stdout, stderr := demultiplex(raw)
	if stdout != "live-capture\nregistry\n" || stderr != "" {
		t.Fatalf("demultiplex = %q / %q", stdout, stderr)
	}

	// A stream cut mid-frame returns what arrived rather than nothing: a truncated listing is
	// still a listing, and the caller bounds it either way.
	cut := frame("live-capture\n")
	cut = append(cut, 1, 0, 0, 0, 0, 0, 0, 99)
	if got, _ := demultiplex(cut); got != "live-capture\n" {
		t.Fatalf("a cut stream should keep what it had, got %q", got)
	}
	if got, _ := demultiplex([]byte{1, 2, 3}); got != "" {
		t.Fatalf("a fragment shorter than a header has no payload, got %q", got)
	}
}

func TestQuoteForShellClosesTheInjection(t *testing.T) {
	// The path is derived from a validated request rather than taken raw, but it still reaches
	// `sh -c`, so it is quoted rather than trusted.
	if got := quoteForShell("/anchorage-volume/ok"); got != "'/anchorage-volume/ok'" {
		t.Fatalf("quoteForShell = %s", got)
	}
	got := quoteForShell("/vol/'; rm -rf /; echo '")
	if strings.Contains(got, "'; rm") && !strings.Contains(got, `'\''`) {
		t.Fatalf("a quote in the path escaped its own quoting: %s", got)
	}
	// Every embedded quote is closed, escaped and reopened, so the shell sees one word.
	if !strings.HasPrefix(got, "'") || !strings.HasSuffix(got, "'") {
		t.Fatalf("not a single quoted word: %s", got)
	}
}

func TestDemultiplexKeepsStderrOutOfTheListing(t *testing.T) {
	/*
		The defect that made every non-world-readable volume look empty had two halves. This is
		the second: with both streams attached, a merged demultiplex would turn
		"ls: can't open '/anchorage-volume': Permission denied" into a filename. Byte zero of
		each frame says which stream it is, so they are kept apart.
	*/
	frame := func(stream byte, payload string) []byte {
		header := []byte{stream, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(header[4:8], uint32(len(payload)))
		return append(header, payload...)
	}
	raw := append(frame(1, "base\n"), frame(2, "ls: Permission denied\n")...)
	raw = append(raw, frame(1, "global\n")...)

	stdout, stderr := demultiplex(raw)
	if stdout != "base\nglobal\n" {
		t.Fatalf("stdout = %q — stderr leaked into the listing", stdout)
	}
	if !strings.Contains(stderr, "Permission denied") {
		t.Fatalf("stderr = %q — the reason a listing failed must survive to the error", stderr)
	}
}

func TestHelperExecRunsAsRootBecauseTheArchiveEndpointDid(t *testing.T) {
	/*
		Not a widening. The archive endpoint runs inside dockerd and is not subject to the
		image's user, so it always read 0700 directories owned by other uids. The exec inherits
		the image's user, and a Postgres data directory is `drwx------` — so the fast path
		returned nothing for exactly the volumes worth browsing until this matched the access
		the previous implementation already had.
	*/
	source, err := os.ReadFile("volumes_browse.go")
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	if !strings.Contains(string(source), `"User": "0:0"`) {
		t.Fatal("the listing exec must run as root, or unreadable volumes list as empty")
	}
	for _, hardening := range []string{`"NetworkMode":    "none"`, `"CapDrop":        []string{"ALL"}`, `"SecurityOpt":    []string{"no-new-privileges"}`} {
		if !strings.Contains(string(source), hardening) {
			t.Fatalf("root inside the helper is only acceptable with %s", hardening)
		}
	}
}

func TestHelperCapabilitiesAreTheSmallestSetThatWorks(t *testing.T) {
	/*
		Dropping every capability looked like obvious hardening and broke the feature: root
		without CAP_DAC_READ_SEARCH cannot traverse a `drwx------` directory owned by another
		uid, so a Postgres data volume listed as empty. The archive endpoint this replaces runs
		inside dockerd and was never subject to file modes, so this restores access that
		already existed rather than adding any.

		The read path must not be able to write. DAC_OVERRIDE bypasses write permission too and
		belongs only to an upload.
	*/
	read := volumeHelperCapabilities(false)
	if len(read) != 1 || read[0] != "DAC_READ_SEARCH" {
		t.Fatalf("a read needs exactly DAC_READ_SEARCH, got %v", read)
	}
	write := volumeHelperCapabilities(true)
	if !containsString(write, "DAC_READ_SEARCH") || !containsString(write, "DAC_OVERRIDE") {
		t.Fatalf("an upload needs both, got %v", write)
	}
	if len(write) != 2 {
		t.Fatalf("nothing else belongs in the write set, got %v", write)
	}
}

func TestReleaseVolumeHelpersForDropsTheHelperHoldingThatVolume(t *testing.T) {
	/*
		A parked helper is a running container with the volume mounted, and to the daemon that is
		a reason the volume cannot be removed:

			Error response from daemon: remove anchorage_browse_4d8dfef7:
			volume is in use - [ad75365a2bb5...]

		Found by the core acceptance suite, which browses a volume and then removes it — the
		sequence an operator performs whenever they look inside something before deleting it. The
		idle timer would have released the helper eventually, which made this a window rather
		than a wall, and a window is the worse failure: the removal fails only if you are quick,
		so it reads as Docker being unreliable rather than as anything with a cause.

		Both keys are looked up because a browse parks read-only and a write parks read-write,
		and only one helper is ever parked — whichever the operator did last. Checking one key
		would leave the volume held exactly half the time.

		The nil client is why this asserts the map rather than the container removal: the delete
		runs against the engine and there is none here. What has to be true either way is that
		the hold is gone.
	*/
	for _, writable := range []bool{false, true} {
		service := &Service{}
		if !service.parkVolumeHelper(volumeHelperKey("vol-a", writable), "container-a", nil) {
			t.Fatal("the helper should park")
		}

		service.ReleaseVolumeHelpersFor(context.Background(), "vol-a")

		service.helperMu.Lock()
		parked := len(service.parkedHelpers)
		service.helperMu.Unlock()
		if parked != 0 {
			t.Fatalf("writable=%v: %d helpers still parked, so the volume is still in use",
				writable, parked)
		}
	}
}

func TestReleaseVolumeHelpersForLeavesAnotherVolumeAlone(t *testing.T) {
	// Releasing everything on every remove would throw away the cache that takes a directory hop
	// from 8s to 0.04s, and it would do it on a volume the operator did not mention.
	service := &Service{}
	if !service.parkVolumeHelper(volumeHelperKey("vol-b", false), "container-b", nil) {
		t.Fatal("the helper should park")
	}

	service.ReleaseVolumeHelpersFor(context.Background(), "vol-a")

	service.helperMu.Lock()
	defer service.helperMu.Unlock()
	if _, ok := service.parkedHelpers[volumeHelperKey("vol-b", false)]; !ok {
		t.Fatal("removing vol-a must not release vol-b's helper")
	}
}

func TestReleaseVolumeHelpersForIgnoresAnEmptyName(t *testing.T) {
	// `prune` reaches the same code path with no volume named. Treating "" as a key would look
	// up a helper nothing ever parks, which is harmless, but the early return says so out loud.
	service := &Service{}
	service.ReleaseVolumeHelpersFor(context.Background(), "   ")
	service.helperMu.Lock()
	defer service.helperMu.Unlock()
	if len(service.parkedHelpers) != 0 {
		t.Fatal("nothing should have been created")
	}
}

func TestEvictedHelperIsRemovedThroughItsOwnClient(t *testing.T) {
	/*
		A container ID means nothing to a daemon that did not create the container.

		Only one helper parks at a time, so browsing a second volume evicts the first. Eviction
		used the *incoming* caller's client to remove the evicted container, which is correct
		only while every browse happens on one daemon. Cross two — as the core acceptance suite
		does every run, browsing on the host and again inside a disposable dind — and the delete
		is addressed to a daemon that has no such container. It quietly does nothing, the helper
		keeps running, and it holds its volume until something sweeps that daemon:

			Error response from daemon: remove anchorage_browse_c4726086:
			volume is in use - [b48f736ed717...]

		Asserted on the recorded client rather than on a removal, because removing needs an
		engine and there is none here. That the two helpers carry two different clients is the
		whole property: with the old code the second park would have removed the first through
		`clientB`, and this test would have had nothing to distinguish.
	*/
	service := &Service{}
	// Real enough to be called: eviction removes on a goroutine, and a client with no
	// http.Client panics there rather than failing, which takes the process down instead of the
	// test. These have nowhere to connect to, so the removal errors and is discarded — which is
	// the behaviour the sweep-by-label exists to back up.
	newClient := func(version string) *engineClient {
		return &engineClient{
			apiVersion: version,
			httpClient: &http.Client{Timeout: time.Millisecond},
			endpoint:   contextEndpoint{},
		}
	}
	clientA := newClient("1.44")
	clientB := newClient("1.45")

	if !service.parkVolumeHelper(volumeHelperKey("vol-a", false), "container-a", clientA) {
		t.Fatal("the first helper should park")
	}
	service.helperMu.Lock()
	parkedA := service.parkedHelpers[volumeHelperKey("vol-a", false)]
	service.helperMu.Unlock()
	if parkedA.client != clientA {
		t.Fatal("a parked helper must remember the client that created it")
	}

	// Evicts the first. The removal runs on a goroutine against a client with no transport, so
	// this asserts what the eviction was handed rather than what the daemon did with it.
	if !service.parkVolumeHelper(volumeHelperKey("vol-b", false), "container-b", clientB) {
		t.Fatal("the second helper should park")
	}
	service.helperMu.Lock()
	defer service.helperMu.Unlock()
	parkedB := service.parkedHelpers[volumeHelperKey("vol-b", false)]
	if parkedB == nil || parkedB.client != clientB {
		t.Fatal("the surviving helper must carry its own client")
	}
	if _, ok := service.parkedHelpers[volumeHelperKey("vol-a", false)]; ok {
		t.Fatal("the first helper should have been evicted")
	}
}
