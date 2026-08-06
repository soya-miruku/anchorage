package core

import "testing"

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
