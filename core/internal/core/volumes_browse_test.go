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
