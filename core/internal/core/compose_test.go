package core

import (
	"strings"
	"testing"
)

func TestComposeStatusParsesIntoTerms(t *testing.T) {
	// Compose reports a joined display string. The counts are the only part the UI can act
	// on, so they are parsed once here rather than re-parsed in the renderer.
	terms := parseComposeStatus("exited(3), running(19)")
	if len(terms) != 2 {
		t.Fatalf("expected 2 terms, got %d: %+v", len(terms), terms)
	}
	if terms[0].State != "exited" || terms[0].Count != 3 {
		t.Fatalf("first term wrong: %+v", terms[0])
	}
	if terms[1].State != "running" || terms[1].Count != 19 {
		t.Fatalf("second term wrong: %+v", terms[1])
	}
	if got := parseComposeStatus(""); len(got) != 0 {
		t.Fatalf("empty status should produce no terms, got %+v", got)
	}
	// A term Compose words differently must still surface, with an unknown count, rather
	// than making the project disappear from the list.
	odd := parseComposeStatus("paused")
	if len(odd) != 1 || odd[0].State != "paused" || odd[0].Count != -1 {
		t.Fatalf("unparseable term should survive with an unknown count: %+v", odd)
	}
}

func TestComposeServicesDecodeBothFramings(t *testing.T) {
	// `compose ps` emits one object per line while `compose ls` emits an array. Guessing
	// wrong yields an empty list rather than an error, so both are handled explicitly.
	ndjson := []byte(`{"Name":"api-1","Service":"api","ID":"abc","State":"running"}
{"Name":"db-1","Service":"db","ID":"def","State":"exited","ExitCode":1}`)
	services, err := decodeComposeServices(ndjson)
	if err != nil {
		t.Fatalf("NDJSON should decode: %v", err)
	}
	if len(services) != 2 || services[0].Service != "api" || services[1].ExitCode != 1 {
		t.Fatalf("NDJSON decoded wrong: %+v", services)
	}

	array := []byte(`[{"Name":"api-1","Service":"api","ID":"abc","State":"running"}]`)
	services, err = decodeComposeServices(array)
	if err != nil {
		t.Fatalf("array should decode: %v", err)
	}
	if len(services) != 1 || services[0].Name != "api-1" {
		t.Fatalf("array decoded wrong: %+v", services)
	}

	if got, err := decodeComposeServices([]byte("  \n ")); err != nil || len(got) != 0 {
		t.Fatalf("blank output should be an empty list, got %+v (%v)", got, err)
	}
	if _, err := decodeComposeServices([]byte("{not json}")); err == nil {
		t.Fatal("malformed output must error rather than report no services")
	}
}

func TestComposeProjectNamesAreConstrained(t *testing.T) {
	for _, name := range []string{"hyper-trader", "buzz", "a.b_c-1"} {
		if err := validateComposeProject(name); err != nil {
			t.Fatalf("%q should be accepted: %v", name, err)
		}
	}
	// The name becomes an argv element and a label selector.
	for _, name := range []string{"", "-p", "Upper", "has space", "semi;colon",
		strings.Repeat("a", 256)} {
		if err := validateComposeProject(name); err == nil {
			t.Fatalf("%q must be rejected", name)
		}
	}
}

func TestComposeActionOptionsBelongToOneAction(t *testing.T) {
	// up cannot recreate containers without the file that defines them.
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "up",
	}); err == nil {
		t.Fatal("up must require configuration files")
	}
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "up", ConfigFiles: []string{"-rf"},
	}); err == nil {
		t.Fatal("a flag-like configuration path must be rejected")
	}
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "up", ConfigFiles: []string{"/srv/app/compose.yaml"},
	}); err != nil {
		t.Fatalf("a well-formed up should validate: %v", err)
	}

	// down removes containers and networks, so it is confirmed like every other
	// destructive verb, and it finds the project by label rather than by file.
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "down",
	}); err == nil {
		t.Fatal("down must require confirmation")
	}
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "down", Confirmed: true,
		ConfigFiles: []string{"/srv/app/compose.yaml"},
	}); err == nil {
		t.Fatal("down must reject configuration files")
	}
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "down", Confirmed: true, RemoveVolumes: true,
	}); err != nil {
		t.Fatalf("a confirmed down should validate: %v", err)
	}

	// stop/start/restart take neither.
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "stop", RemoveVolumes: true,
	}); err == nil {
		t.Fatal("stop must reject options belonging to down")
	}
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "restart",
	}); err != nil {
		t.Fatalf("a plain restart should validate: %v", err)
	}
	if err := validateComposeAction(ComposeActionParams{
		Project: "demo", Action: "exec",
	}); err == nil {
		t.Fatal("an unsupported compose action must be rejected")
	}
}

func TestComposeConfigFileSplitDropsBlanks(t *testing.T) {
	files := splitComposeConfigFiles("/a/compose.yml, /b/override.yml")
	if len(files) != 2 || files[1] != "/b/override.yml" {
		t.Fatalf("config files split wrong: %+v", files)
	}
	if got := splitComposeConfigFiles(""); len(got) != 0 {
		t.Fatalf("empty config files should split to nothing, got %+v", got)
	}
}
