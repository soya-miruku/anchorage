package core

import (
	"encoding/json"
	"testing"
)

func TestBuildRecordIDStripsTheBuilderPath(t *testing.T) {
	// `history ls` reports builder/node/id but `history inspect` rejects that outright. The
	// mismatch yields an empty detail pane rather than an error, so it is pinned here.
	for _, testCase := range []struct{ ref, id string }{
		{"default/default/00b5zi7celyy89egnd8922ps1", "00b5zi7celyy89egnd8922ps1"},
		{"00b5zi7celyy89egnd8922ps1", "00b5zi7celyy89egnd8922ps1"},
		{"a/b/c/d", "d"},
	} {
		if got := buildRecordID(testCase.ref); got != testCase.id {
			t.Fatalf("%q reduced to %q, want %q", testCase.ref, got, testCase.id)
		}
	}
}

func TestBuildRefValidationConstrainsArgv(t *testing.T) {
	if _, err := validateBuildRef("default/default/00b5zi7celyy89egnd8922ps1"); err != nil {
		t.Fatalf("a real reference should validate: %v", err)
	}
	// The identifier becomes an argv element.
	// A builder name may legitimately carry separators and case, so those are accepted inside
	// a segment; what must never be accepted is anything that could read as a flag or escape
	// the reference's own shape.
	if _, err := validateBuildRef("desktop-linux/node_1/00b5zi7celyy89egnd8922ps1"); err != nil {
		t.Fatalf("a builder name with separators should validate: %v", err)
	}
	for _, bad := range []string{
		"", "--format", "-o", "../../etc", "has space", "semi;colon", "a//b", "/leading",
	} {
		if _, err := validateBuildRef(bad); err == nil {
			t.Fatalf("build reference %q must be rejected", bad)
		}
	}
}

func TestBuildStatusesAreProjected(t *testing.T) {
	for raw, want := range map[string]string{
		"Completed": "success", "completed": "success",
		"Error": "failed", "Canceled": "cancelled", "running": "running",
		"something-new": "unknown",
	} {
		if got := normalizeBuildStatus(raw); got != want {
			t.Fatalf("%q projected to %q, want %q", raw, got, want)
		}
	}
}

func TestStreamedJSONAcceptsBothFramings(t *testing.T) {
	// buildx uses an array in some places and one object per line in others, exactly as
	// Compose does. Guessing wrong yields an empty list rather than an error.
	for _, payload := range []string{
		`[{"n":1},{"n":2}]`,
		"{\"n\":1}\n{\"n\":2}\n",
	} {
		count := 0
		if err := decodeStreamedJSON([]byte(payload), func(json.RawMessage) error {
			count++
			return nil
		}); err != nil {
			t.Fatalf("%q should decode: %v", payload, err)
		}
		if count != 2 {
			t.Fatalf("%q yielded %d items, want 2", payload, count)
		}
	}
	if err := decodeStreamedJSON([]byte("  \n"), func(json.RawMessage) error { return nil }); err != nil {
		t.Fatalf("blank output should decode to nothing: %v", err)
	}
}
