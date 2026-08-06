package core

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

/*
The install verb is the only thing in Anchorage that fetches bytes from outside the machine and
then makes them executable. Its security rests on a short list of properties, and each one below
is a way it could stop being safe rather than stop working — a broken install is visible, a
silently unverified one is not.
*/

func TestOnlyCompiledInCapabilitiesAreInstallable(t *testing.T) {
	// The single most important property: the caller names a key, never a URL. If this table
	// ever accepted caller input, the verb would become a general download-and-execute
	// primitive pointed at a directory the Docker CLI runs.
	for _, name := range []string{"", "ai", "sbx", "compose", "../../etc/passwd", "AGENT"} {
		if _, ok := installableCapabilities[name]; ok {
			t.Fatalf("%q must not be installable", name)
		}
	}
	for _, name := range []string{"agent", "mcp"} {
		capability, ok := installableCapabilities[name]
		if !ok {
			t.Fatalf("%q should be installable", name)
		}
		// The filename is derived from the table, so a plugin name that disagreed with its key
		// would write to a path the rest of the system does not expect.
		if capability.Plugin != name {
			t.Fatalf("%q maps to plugin %q", name, capability.Plugin)
		}
		if !strings.HasPrefix(capability.Repository, "docker/") {
			t.Fatalf("%q resolves to a non-Docker repository: %q", name, capability.Repository)
		}
		for _, arch := range []string{"amd64", "arm64"} {
			if capability.Asset[arch] == "" {
				t.Fatalf("%q has no asset for %s", name, arch)
			}
		}
	}
}

func TestRedirectPolicyRefusesAnythingOffTheAllowlist(t *testing.T) {
	client := capabilityHTTPClient()
	if client.CheckRedirect == nil {
		t.Fatal("the client must police redirects; a release download is served by a redirect")
	}

	request := func(raw string) *http.Request {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		return &http.Request{URL: parsed}
	}

	// The hop that actually happens.
	if err := client.CheckRedirect(
		request("https://objects.githubusercontent.com/some/asset"), nil,
	); err != nil {
		t.Fatalf("the CDN hop must be allowed: %v", err)
	}

	// A redirect is attacker-influenced in a way the first URL is not: it comes from the
	// response, so checking only the initial host would leave the real target unchecked.
	for _, hostile := range []string{
		"https://evil.example/payload",
		"https://github.com.evil.example/payload",
		"http://objects.githubusercontent.com/downgrade",
		"https://raw.githubusercontent.com/other/thing",
	} {
		if err := client.CheckRedirect(request(hostile), nil); err == nil {
			t.Fatalf("redirect to %q must be refused", hostile)
		}
	}

	// A redirect loop must terminate rather than run until the timeout.
	chain := make([]*http.Request, capabilityMaxRedirects)
	if err := client.CheckRedirect(
		request("https://objects.githubusercontent.com/asset"), chain,
	); err == nil {
		t.Fatal("a redirect chain past the limit must be refused")
	}
}

func TestCapabilityClientIsNotTheEngineClient(t *testing.T) {
	// The engine's transport dials the Docker socket and refuses a proxy. Reusing it here
	// would either fail every request or, if someone "fixed" that, quietly widen the socket
	// client into a general-purpose one.
	client := capabilityHTTPClient()
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("unexpected transport %T", client.Transport)
	}
	// No proxy: a proxy would put a third party chosen by an environment variable in the
	// middle of a binary download.
	if transport.Proxy != nil {
		t.Fatal("the capability client must not honour a proxy")
	}
	if transport.TLSHandshakeTimeout == 0 {
		t.Fatal("the capability client must bound its TLS handshake")
	}
}

func TestVerifyDigestRefusesEverythingItCannotCheck(t *testing.T) {
	payload := []byte("the plugin binary")
	sum := sha256.Sum256(payload)
	good := "sha256:" + hex.EncodeToString(sum[:])

	if err := verifyDigest(payload, good); err != nil {
		t.Fatalf("a matching digest must verify: %v", err)
	}
	// GitHub's own casing varies by field; the comparison must not depend on it.
	if err := verifyDigest(payload, strings.ToUpper(good)); err != nil {
		t.Fatalf("digest comparison must be case-insensitive: %v", err)
	}

	// Every rejection below is a case where continuing would install unverified bytes.
	for name, digest := range map[string]string{
		"empty":            "",
		"no algorithm":     hex.EncodeToString(sum[:]),
		"wrong algorithm":  "md5:" + hex.EncodeToString(sum[:]),
		"wrong digest":     "sha256:" + strings.Repeat("00", 32),
		"truncated digest": "sha256:abc",
	} {
		if err := verifyDigest(payload, digest); err == nil {
			t.Fatalf("%s must be refused", name)
		}
	}

	// A different payload with a valid-looking digest is the case this exists for.
	if err := verifyDigest([]byte("something else"), good); err == nil {
		t.Fatal("altered bytes must not pass the published digest")
	}
}

// tarGz builds a gzipped tarball in memory so extraction can be tested without a network.
func tarGz(t *testing.T, entries map[string]string, typeflag byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)
	for name, content := range entries {
		header := &tar.Header{
			Name:     name,
			Mode:     0o755,
			Size:     int64(len(content)),
			Typeflag: typeflag,
		}
		if typeflag != tar.TypeReg {
			header.Size = 0
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatalf("write header: %v", err)
		}
		if typeflag == tar.TypeReg {
			if _, err := tarWriter.Write([]byte(content)); err != nil {
				t.Fatalf("write body: %v", err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buffer.Bytes()
}

func TestExtractFromTarGzTakesOnlyTheNamedEntry(t *testing.T) {
	archive := tarGz(t, map[string]string{
		"README.md":  "not the binary",
		"docker-mcp": "the binary",
	}, tar.TypeReg)

	binary, err := extractFromTarGz(archive, "docker-mcp")
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if string(binary) != "the binary" {
		t.Fatalf("extracted %q", binary)
	}
}

func TestExtractFromTarGzIgnoresPathsInTheArchive(t *testing.T) {
	// The name is matched on its base, against a compiled-in constant. An archive that tries
	// to escape its own directory cannot influence where anything is written, because nothing
	// here writes using a name from the archive at all — the caller picks the destination.
	archive := tarGz(t, map[string]string{
		"../../../../etc/cron.d/docker-mcp": "hostile",
	}, tar.TypeReg)

	binary, err := extractFromTarGz(archive, "docker-mcp")
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	// It is read as the entry — and that is safe, because the destination is
	// ~/.docker/cli-plugins/docker-mcp regardless of what the archive called it.
	if string(binary) != "hostile" {
		t.Fatalf("extracted %q", binary)
	}
}

func TestExtractFromTarGzRefusesWhatItCannotUse(t *testing.T) {
	missing := tarGz(t, map[string]string{"other-file": "x"}, tar.TypeReg)
	if _, err := extractFromTarGz(missing, "docker-mcp"); err == nil {
		t.Fatal("an archive without the expected binary must be refused")
	}

	// A symlink entry named like the binary would otherwise be read as a zero-length file and
	// installed as an empty executable.
	link := tarGz(t, map[string]string{"docker-mcp": "/etc/passwd"}, tar.TypeSymlink)
	if _, err := extractFromTarGz(link, "docker-mcp"); err == nil {
		t.Fatal("a non-regular archive entry must be refused")
	}

	if _, err := extractFromTarGz([]byte("not gzip at all"), "docker-mcp"); err == nil {
		t.Fatal("a non-archive must be refused")
	}
}

func TestInstallRefusesAnUnknownCapabilityBeforeReachingTheNetwork(t *testing.T) {
	// No server is stubbed, so if this ever returned nil the test would hang rather than pass:
	// the rejection has to happen before the first request.
	service := &Service{}
	_, err := service.capabilityInstall(t.Context(), CapabilityInstallParams{
		Capability: "https://evil.example/payload",
		Confirmed:  true,
	})
	if err == nil {
		t.Fatal("an unknown capability must be refused")
	}
	if code := AsOpError(err).Code; code != "capability_not_installable" {
		t.Fatalf("unexpected error code %q: %v", code, err)
	}
}

func TestInstallRefusesAnArchitectureWithNoPublishedBinary(t *testing.T) {
	original := hostArch
	hostArch = func() string { return "riscv64" }
	t.Cleanup(func() { hostArch = original })

	service := &Service{}
	_, err := service.capabilityInstall(t.Context(), CapabilityInstallParams{
		Capability: "agent",
		Confirmed:  true,
	})
	if err == nil {
		t.Fatal("an unsupported architecture must be refused rather than guessed at")
	}
	if code := AsOpError(err).Code; code != "capability_arch_unsupported" {
		t.Fatalf("unexpected error code %q: %v", code, err)
	}
}

func TestSelectReleaseTakesPrereleasesOnlyWhereThePublisherUsesNothingElse(t *testing.T) {
	/*
		This is the defect that only running the thing against GitHub found. `/releases/latest`
		omits prereleases, and docker/mcp-gateway marks every release as one, so the endpoint
		answered 404 and the install failed outright. The fix must not become "take prereleases
		everywhere", which would silently start installing unfinished docker-agent builds.
	*/
	newest := releaseMetadata{TagName: "v2.0.0", Prerelease: true}
	stable := releaseMetadata{TagName: "v1.9.0"}
	draft := releaseMetadata{TagName: "v2.1.0", Draft: true}
	releases := []releaseMetadata{draft, newest, stable}

	agent := installableCapabilities["agent"]
	if agent.AllowPrerelease {
		t.Fatal("docker-agent publishes ordinary releases; it must not accept prereleases")
	}
	chosen, ok := selectRelease(releases, agent)
	if !ok || chosen.TagName != "v1.9.0" {
		t.Fatalf("a publisher with stable releases must get one: %+v ok=%v", chosen, ok)
	}

	mcp := installableCapabilities["mcp"]
	if !mcp.AllowPrerelease {
		t.Fatal("mcp-gateway marks every release a prerelease; /releases/latest 404s for it")
	}
	chosen, ok = selectRelease(releases, mcp)
	if !ok || chosen.TagName != "v2.0.0" {
		t.Fatalf("mcp must take the newest prerelease: %+v ok=%v", chosen, ok)
	}

	// A draft is never taken by either: it is unpublished, and its assets can be replaced
	// under the same tag.
	for name, capability := range map[string]installableCapability{"agent": agent, "mcp": mcp} {
		if chosen, _ := selectRelease([]releaseMetadata{draft}, capability); chosen.TagName != "" {
			t.Fatalf("%s took a draft release: %+v", name, chosen)
		}
	}

	// Nothing publishable at all is a refusal, not a zero value that would be used anyway.
	if _, ok := selectRelease(nil, mcp); ok {
		t.Fatal("an empty release list must not resolve")
	}
}
