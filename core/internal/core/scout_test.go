package core

import "testing"

func TestPurlYieldsPackageAndInstalledVersion(t *testing.T) {
	// The package and the version actually installed are what an operator acts on; both are
	// only available inside the purl.
	for _, testCase := range []struct{ purl, name, version string }{
		{"pkg:apk/alpine/c-ares@1.34.6-r0?os_name=alpine&os_version=3.23", "c-ares", "1.34.6-r0"},
		{"pkg:golang/stdlib@1.22.1", "stdlib", "1.22.1"},
		{"pkg:npm/%40scope/pkg@1.0.0", "pkg", "1.0.0"},
		{"pkg:deb/debian/openssl", "openssl", ""},
	} {
		name, version := parsePurl(testCase.purl)
		if name != testCase.name || version != testCase.version {
			t.Fatalf("%q parsed to (%q, %q), want (%q, %q)",
				testCase.purl, name, version, testCase.name, testCase.version)
		}
	}
}

func TestScoutSARIFIsProjectedWorstFirst(t *testing.T) {
	report := []byte(`{"runs":[{"tool":{"driver":{"name":"Docker Scout","version":"1.18.3","rules":[
		{"id":"CVE-1","helpUri":"https://example/1","properties":{"cvssV3_severity":"LOW",
		 "security-severity":"3.1","affected_version":"<1","fixed_version":"1.0",
		 "purls":["pkg:apk/alpine/zlib@0.9"]}},
		{"id":"CVE-2","properties":{"cvssV3_severity":"CRITICAL","security-severity":"9.8",
		 "purls":["pkg:apk/alpine/openssl@1.1"]}},
		{"id":"CVE-3","properties":{"cvssV3_severity":"HIGH","security-severity":"7.5",
		 "purls":["pkg:apk/alpine/curl@8.0"]}}
	]}}}]}`)
	findings, summary, scanner, err := parseScoutSARIF(report)
	if err != nil {
		t.Fatalf("valid SARIF should parse: %v", err)
	}
	if scanner != "Docker Scout 1.18.3" {
		t.Fatalf("scanner identity wrong: %q", scanner)
	}
	// A vulnerability list is only useful worst-first.
	if findings[0].ID != "CVE-2" || findings[1].ID != "CVE-3" || findings[2].ID != "CVE-1" {
		t.Fatalf("findings not ordered worst-first: %+v", findings)
	}
	if findings[0].Package != "openssl" || findings[0].InstalledVersion != "1.1" {
		t.Fatalf("package projection wrong: %+v", findings[0])
	}
	if findings[2].FixedVersion != "1.0" {
		t.Fatalf("fixed version lost: %+v", findings[2])
	}
	if summary["CRITICAL"] != 1 || summary["HIGH"] != 1 || summary["LOW"] != 1 {
		t.Fatalf("summary wrong: %+v", summary)
	}
	// Every severity is present even at zero, so the UI never has to guess a missing key.
	for _, severity := range scoutSeverities {
		if _, ok := summary[severity]; !ok {
			t.Fatalf("summary is missing %q", severity)
		}
	}
}

func TestScoutHandlesEmptyAndUnknownSeverities(t *testing.T) {
	// A clean image reports nothing; that is a result, not a failure.
	findings, summary, _, err := parseScoutSARIF([]byte(`{"runs":[{"tool":{"driver":{"rules":[]}}}]}`))
	if err != nil || len(findings) != 0 || summary["CRITICAL"] != 0 {
		t.Fatalf("clean report should yield no findings: %+v %+v %v", findings, summary, err)
	}
	if got, _, _, err := parseScoutSARIF(nil); err != nil || len(got) != 0 {
		t.Fatalf("absent output should be empty, not an error: %v", err)
	}
	// A severity Scout words differently is counted as unspecified, never dropped.
	_, summary, _, err = parseScoutSARIF([]byte(
		`{"runs":[{"tool":{"driver":{"rules":[{"id":"CVE-9","properties":{"cvssV3_severity":"WEIRD"}}]}}}]}`))
	if err != nil || summary["UNSPECIFIED"] != 1 {
		t.Fatalf("unknown severity must still be counted: %+v %v", summary, err)
	}
	if _, _, _, err := parseScoutSARIF([]byte("not json")); err == nil {
		t.Fatal("malformed output must error rather than report a clean image")
	}
}
