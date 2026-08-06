package core

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

/*
Installing a CLI plugin, which Anchorage previously could not do at all.

Every capability screen used to end at "here is the command, go and run it". That was honest
while the alternative was worse, and for a *distribution package* it still is: installing one
needs root, and the core must never acquire that. But it was never the whole truth. A Docker CLI
plugin is one executable in `~/.docker/cli-plugins`, a directory the operator already owns, and
putting a file there needs no privilege at all. The blocker was never permission; it was that
the core had no way to fetch bytes from anywhere but the Docker socket.

This adds that, deliberately narrowly. The properties below are the design, not decoration —
each one closes a way this could otherwise become a general-purpose download-and-execute
primitive, which is exactly what an attacker who reached the RPC boundary would want.

 1. **The caller names a capability, never a URL.** `installableCapabilities` below is the
    complete set, compiled in. A request carries the key `agent` or `mcp` and nothing else, so
    no input reaches the network layer that could redirect it somewhere else.

 2. **The host allowlist is checked on every hop.** GitHub serves release assets by redirecting
    to a CDN, so redirects must be followed — and each one is re-checked rather than trusted
    because the first hop was fine.

 3. **The digest is not supplied by the caller.** It comes from the GitHub API response, over
    TLS, and the downloaded bytes must match it. An asset with no published digest is refused
    rather than installed unverified.

 4. **The write target is derived, never passed.** It is always
    `~/.docker/cli-plugins/docker-<name>` for a name from the table.

 5. **A separate HTTP client.** The engine client's transport dials the Docker socket and
    nothing else; reusing it here would either fail or, worse, quietly widen it. This one has
    its own transport, its own timeouts, and no proxy.

What this does *not* provide, stated plainly because the UI repeats it to the operator: the
digest binds the bytes to what GitHub's API said the release contained at the moment we asked.
It is not a publisher signature, and it does not attest that Docker built or reviewed the
artifact. Docker publishes no signatures for these release binaries; if that changes, the check
belongs here.
*/

const (
	// Generous, because these are large binaries — docker-agent is ~135 MB — and a slow link
	// must not look like a failed install.
	capabilityInstallTimeout = 10 * time.Minute
	// Well above the largest asset here and far below anything that would fill a disk. A body
	// that exceeds it is abandoned rather than buffered.
	capabilityMaxAssetBytes = 512 * 1024 * 1024
	// The release metadata is a small JSON document; nothing legitimate here is close.
	capabilityMaxMetadataBytes = 4 * 1024 * 1024
	// Redirects are expected — GitHub sends release downloads to a CDN — but a chain this long
	// is a loop or a redirector being used as one.
	capabilityMaxRedirects = 5
)

// capabilityHostAllowlist is every host these installs may reach, on any hop.
//
// `api.github.com` serves the release metadata. `github.com` is where the asset URL starts and
// `objects.githubusercontent.com` is where it redirects; `release-assets.githubusercontent.com`
// is the newer name for the same CDN and is included so an install does not break the day
// GitHub moves.
var capabilityHostAllowlist = map[string]bool{
	"api.github.com":                       true,
	"github.com":                           true,
	"objects.githubusercontent.com":        true,
	"release-assets.githubusercontent.com": true,
}

/*
installableCapability is one plugin Anchorage can fetch, and where from.

The asset name is a template rather than a fixed string because a release carries one binary per
platform. Only linux/amd64 and linux/arm64 are listed: Anchorage packages for Linux, and
inventing a darwin entry that nothing here can exercise would be a claim rather than a feature.
*/
type installableCapability struct {
	// Plugin is the `docker <name>` this becomes, and therefore the filename: docker-<name>.
	Plugin string
	// Repository is `owner/name` on GitHub.
	Repository string
	// Asset maps GOARCH to the release asset name.
	Asset map[string]string
	// Archive marks an asset that arrives as a .tar.gz containing the binary, rather than as
	// the binary itself. The two publishers disagree, so this is recorded rather than sniffed.
	Archive bool
	// AllowPrerelease is set for a repository that marks every release as a prerelease.
	//
	// This is not a preference, it is a fact about the publisher, and it was found by running
	// this against GitHub rather than by reading documentation: `/releases/latest` omits
	// prereleases, so it answers 404 for docker/mcp-gateway and the install failed outright.
	// Recording it per capability keeps the exception where it belongs — docker/docker-agent
	// publishes ordinary releases and must not silently start taking prereleases too.
	AllowPrerelease bool
	// BinaryInArchive is the path within the archive, when Archive is set.
	BinaryInArchive string
}

var installableCapabilities = map[string]installableCapability{
	// Docker Agent, formerly cagent. The release publishes bare binaries.
	"agent": {
		Plugin:     "agent",
		Repository: "docker/docker-agent",
		Asset: map[string]string{
			"amd64": "docker-agent-linux-amd64",
			"arm64": "docker-agent-linux-arm64",
		},
	},
	// The MCP Gateway, which provides `docker mcp`. This one ships tarballs.
	"mcp": {
		Plugin:          "mcp",
		Repository:      "docker/mcp-gateway",
		Archive:         true,
		AllowPrerelease: true,
		BinaryInArchive: "docker-mcp",
		Asset: map[string]string{
			"amd64": "docker-mcp-linux-amd64.tar.gz",
			"arm64": "docker-mcp-linux-arm64.tar.gz",
		},
	},
}

// InstallableCapabilityNames is what the protocol boundary validates against, so the allowlist
// has exactly one definition rather than one here and a copy in the schema.
func InstallableCapabilityNames() []string {
	names := make([]string, 0, len(installableCapabilities))
	for name := range installableCapabilities {
		names = append(names, name)
	}
	return names
}

// capabilityHTTPClient is the outbound client, kept entirely separate from the engine's.
//
// The redirect policy is where the host allowlist is actually enforced for the CDN hop: Go
// calls CheckRedirect before following, so returning an error here stops the request rather
// than reporting it afterwards.
func capabilityHTTPClient() *http.Client {
	transport := &http.Transport{
		// No proxy. A proxy would be a third party in the middle of a binary download, chosen
		// by an environment variable rather than by the operator.
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 5 * time.Second,
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= capabilityMaxRedirects {
				return fmt.Errorf("too many redirects")
			}
			if request.URL.Scheme != "https" {
				return fmt.Errorf("redirect to non-https %q refused", request.URL.Scheme)
			}
			if !capabilityHostAllowlist[request.URL.Hostname()] {
				return fmt.Errorf("redirect to %q is not an allowed host", request.URL.Hostname())
			}
			return nil
		},
	}
}

// releaseAsset is the part of GitHub's release JSON this needs. `digest` is the field the whole
// verification rests on; it arrived relatively recently and an asset without one is refused.
type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Digest             string `json:"digest"`
	Size               int64  `json:"size"`
}

type releaseMetadata struct {
	TagName    string         `json:"tag_name"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Assets     []releaseAsset `json:"assets"`
}

func capabilityRequestError(code, message string, err error, details map[string]any) *OpError {
	return opError(code, message, err, details)
}

// fetchAllowed performs one GET against an allowlisted host. The check here covers the first
// hop; CheckRedirect covers the rest.
func fetchAllowed(ctx context.Context, client *http.Client, url string, limit int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, capabilityRequestError("capability_request_invalid",
			"The capability download request could not be constructed.", err, nil)
	}
	if request.URL.Scheme != "https" {
		return nil, capabilityRequestError("capability_host_refused",
			"A capability download must use https.", nil, map[string]any{"scheme": request.URL.Scheme})
	}
	if !capabilityHostAllowlist[request.URL.Hostname()] {
		return nil, capabilityRequestError("capability_host_refused",
			"That host is not on the capability download allowlist.", nil,
			map[string]any{"host": request.URL.Hostname()})
	}
	request.Header.Set("Accept", "application/octet-stream, application/json")
	request.Header.Set("User-Agent", "anchorage/"+CoreVersion)

	response, err := client.Do(request)
	if err != nil {
		return nil, capabilityRequestError("capability_download_failed",
			"The capability download could not be completed.", err, nil)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, capabilityRequestError("capability_download_failed",
			"The capability download returned an unexpected status.", nil,
			map[string]any{"status": response.StatusCode})
	}
	// LimitReader with one extra byte, so exceeding the cap is detected rather than silently
	// producing a truncated file that would then fail the digest check for the wrong reason.
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, capabilityRequestError("capability_download_failed",
			"The capability download could not be read.", err, nil)
	}
	if int64(len(body)) > limit {
		return nil, capabilityRequestError("capability_too_large",
			"The capability download exceeded the size limit.", nil,
			map[string]any{"limit": limit})
	}
	return body, nil
}

/*
verifyDigest compares what arrived against what the API said would arrive.

The comparison is on the hex digest rather than the raw bytes so the error can name both, and
`sha256:` is stripped because GitHub prefixes the algorithm. Only sha256 is accepted: silently
skipping an algorithm this does not recognise would turn the whole check off.
*/
func verifyDigest(payload []byte, published string) error {
	algorithm, expected, found := strings.Cut(strings.TrimSpace(published), ":")
	if !found || !strings.EqualFold(algorithm, "sha256") {
		return capabilityRequestError("capability_digest_unsupported",
			"The release does not publish a SHA-256 digest for this asset, so the download cannot be verified.",
			nil, map[string]any{"published": published})
	}
	sum := sha256.Sum256(payload)
	actual := hex.EncodeToString(sum[:])
	if !strings.EqualFold(actual, expected) {
		return capabilityRequestError("capability_digest_mismatch",
			"The downloaded bytes do not match the digest the release published.", nil,
			map[string]any{"expected": expected, "actual": actual})
	}
	return nil
}

/*
selectRelease picks the newest release this capability will accept.

Drafts are never taken: a draft is unpublished and its assets can change under the same tag.
Prereleases are taken only where the table says the publisher uses nothing else, so opting in
for one repository does not quietly opt in for the other.
*/
func selectRelease(releases []releaseMetadata, capability installableCapability) (releaseMetadata, bool) {
	for _, release := range releases {
		if release.Draft {
			continue
		}
		if release.Prerelease && !capability.AllowPrerelease {
			continue
		}
		return release, true
	}
	return releaseMetadata{}, false
}

func (s *Service) capabilityInstall(parent context.Context, params CapabilityInstallParams) (CapabilityInstallResult, error) {
	name := strings.TrimSpace(params.Capability)
	capability, known := installableCapabilities[name]
	if !known {
		return CapabilityInstallResult{}, capabilityRequestError("capability_not_installable",
			"Anchorage does not know how to install that capability.", nil,
			map[string]any{"capability": name})
	}
	assetName, supported := capability.Asset[hostArch()]
	if !supported {
		return CapabilityInstallResult{}, capabilityRequestError("capability_arch_unsupported",
			"That capability publishes no binary for this architecture.", nil,
			map[string]any{"architecture": hostArch()})
	}
	directory := userPluginDir()
	if directory == "" {
		return CapabilityInstallResult{}, capabilityRequestError("capability_target_unknown",
			"The Docker CLI plugin directory could not be located for this user.", nil, nil)
	}

	ctx, cancel := context.WithTimeout(parent, capabilityInstallTimeout)
	defer cancel()
	client := capabilityHTTPClient()
	defer client.CloseIdleConnections()

	// 1. Resolve the release. The asset URL and its digest both come from here, so neither is
	//    ever taken from the caller.
	//
	//    The listing endpoint rather than `/releases/latest`, because `/latest` omits
	//    prereleases and docker/mcp-gateway marks every release as one — it answers 404 there.
	//    The list is newest-first, so the filter below picks the same release `/latest` would
	//    have for a publisher that uses it normally.
	metadataURL := fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=10", capability.Repository)
	rawMetadata, err := fetchAllowed(ctx, client, metadataURL, capabilityMaxMetadataBytes)
	if err != nil {
		return CapabilityInstallResult{}, err
	}
	var releases []releaseMetadata
	if err := json.Unmarshal(rawMetadata, &releases); err != nil {
		return CapabilityInstallResult{}, capabilityRequestError("capability_release_unreadable",
			"The release metadata could not be read.", err, nil)
	}
	release, found := selectRelease(releases, capability)
	if !found {
		return CapabilityInstallResult{}, capabilityRequestError("capability_release_missing",
			"No published release carries a binary for this platform.", nil,
			map[string]any{"repository": capability.Repository, "asset": assetName})
	}
	var asset *releaseAsset
	for index := range release.Assets {
		if release.Assets[index].Name == assetName {
			asset = &release.Assets[index]
			break
		}
	}
	if asset == nil {
		return CapabilityInstallResult{}, capabilityRequestError("capability_asset_missing",
			"The latest release does not carry an asset for this platform.", nil,
			map[string]any{"asset": assetName, "release": release.TagName})
	}
	// Refused before the download rather than after: an unverifiable install is not offered at
	// all, so there is no path where bytes are written without a digest behind them.
	if strings.TrimSpace(asset.Digest) == "" {
		return CapabilityInstallResult{}, capabilityRequestError("capability_digest_unsupported",
			"The release publishes no digest for this asset, so the download cannot be verified.",
			nil, map[string]any{"asset": assetName, "release": release.TagName})
	}

	// 2. Download and verify before anything touches the filesystem.
	payload, err := fetchAllowed(ctx, client, asset.BrowserDownloadURL, capabilityMaxAssetBytes)
	if err != nil {
		return CapabilityInstallResult{}, err
	}
	if err := verifyDigest(payload, asset.Digest); err != nil {
		return CapabilityInstallResult{}, err
	}

	binary := payload
	if capability.Archive {
		extracted, err := extractFromTarGz(payload, capability.BinaryInArchive)
		if err != nil {
			return CapabilityInstallResult{}, err
		}
		binary = extracted
	}

	// 3. Write it. Atomically, so a failure part-way cannot leave a half-written executable in
	//    a directory the Docker CLI scans and runs.
	target := filepath.Join(directory, "docker-"+capability.Plugin)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return CapabilityInstallResult{}, capabilityRequestError("capability_write_failed",
			"The plugin directory could not be created.", err, map[string]any{"path": directory})
	}
	temporary, err := os.CreateTemp(directory, ".anchorage-install-*")
	if err != nil {
		return CapabilityInstallResult{}, capabilityRequestError("capability_write_failed",
			"A temporary file could not be created in the plugin directory.", err, nil)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if _, err := temporary.Write(binary); err != nil {
		cleanup()
		return CapabilityInstallResult{}, capabilityRequestError("capability_write_failed",
			"The plugin could not be written.", err, nil)
	}
	// Executable, because the CLI will not load a plugin it cannot run — the missing execute
	// bit is one of the faults the repair path already has to fix after a manual install.
	if err := temporary.Chmod(0o755); err != nil {
		cleanup()
		return CapabilityInstallResult{}, capabilityRequestError("capability_write_failed",
			"The plugin could not be made executable.", err, nil)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return CapabilityInstallResult{}, capabilityRequestError("capability_write_failed",
			"The plugin could not be flushed to disk.", err, nil)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return CapabilityInstallResult{}, capabilityRequestError("capability_write_failed",
			"The plugin could not be closed.", err, nil)
	}
	// Rename over whatever was there, which is how an upgrade and a repair of a dangling
	// symlink are the same operation.
	if err := os.Rename(temporaryPath, target); err != nil {
		_ = os.Remove(temporaryPath)
		return CapabilityInstallResult{}, capabilityRequestError("capability_write_failed",
			"The plugin could not be moved into place.", err, map[string]any{"path": target})
	}

	sum := sha256.Sum256(binary)
	return CapabilityInstallResult{
		ProtocolVersion: ProtocolVersion,
		Capability:      name,
		Plugin:          capability.Plugin,
		Path:            target,
		Repository:      capability.Repository,
		Release:         release.TagName,
		Asset:           assetName,
		// The digest of what was installed. For a bare binary this is the verified asset
		// digest; for an archive it is the extracted file's, which the asset digest does not
		// cover directly — so it is reported rather than implied.
		SHA256:      hex.EncodeToString(sum[:]),
		AssetSHA256: strings.TrimPrefix(strings.ToLower(asset.Digest), "sha256:"),
		SizeBytes:   int64(len(binary)),
		InstalledAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

// hostArch is separated so the architecture table can be tested without cross-compiling.
var hostArch = func() string { return runtime.GOARCH }

var errArchiveEntryMissing = errors.New("archive entry not found")

/*
extractFromTarGz pulls one named file out of a gzipped tarball.

Only the entry the table names is taken, and only if it is a regular file. Walking the archive
and writing whatever it contains is how a tarball becomes a path-traversal primitive; here the
name is compared against a constant the caller cannot influence, so a hostile archive can at
worst fail to contain it.
*/
func extractFromTarGz(payload []byte, wanted string) ([]byte, error) {
	gzipReader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, capabilityRequestError("capability_archive_unreadable",
			"The downloaded archive could not be opened.", err, nil)
	}
	defer func() { _ = gzipReader.Close() }()

	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, capabilityRequestError("capability_archive_unreadable",
				"The downloaded archive could not be read.", err, nil)
		}
		// Compared on the base name: publishers differ on whether entries carry a leading
		// directory, and the name being matched is a compiled-in constant either way.
		if filepath.Base(header.Name) != wanted {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return nil, capabilityRequestError("capability_archive_unreadable",
				"The archive entry for this plugin is not a regular file.", nil,
				map[string]any{"entry": header.Name})
		}
		// Bounded by the same ceiling as the download: a gzip bomb declares a small compressed
		// size and expands without limit, so the decompressed side needs its own cap.
		binary, err := io.ReadAll(io.LimitReader(reader, capabilityMaxAssetBytes+1))
		if err != nil {
			return nil, capabilityRequestError("capability_archive_unreadable",
				"The plugin could not be extracted from the archive.", err, nil)
		}
		if int64(len(binary)) > capabilityMaxAssetBytes {
			return nil, capabilityRequestError("capability_too_large",
				"The extracted plugin exceeded the size limit.", nil,
				map[string]any{"limit": capabilityMaxAssetBytes})
		}
		return binary, nil
	}
	return nil, capabilityRequestError("capability_archive_unreadable",
		"The archive does not contain the expected plugin binary.", errArchiveEntryMissing,
		map[string]any{"entry": wanted})
}
