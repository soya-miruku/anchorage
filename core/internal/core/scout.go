package core

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// Scout indexes an image the first time it sees it, which is proportional to image size:
	// a 1 GB image took over two minutes here, while a second run against the same image
	// returned in two seconds from its cache. The timeout has to accommodate the first run.
	scoutTimeout = 8 * time.Minute
	// SARIF for a large image runs to a few hundred kilobytes. The response budget is 8 MiB,
	// so buffering four times that could only ever produce a report the transport rejects.
	scoutOutputLimit = 8 * 1024 * 1024
	// Findings are capped so one severely outdated image cannot produce a response line the
	// transport has to reject. The count in the summary is never capped.
	maxScoutFindings = 500
	// Individual fields are bounded too: capping the count alone still allows 500 findings
	// carrying arbitrarily long package URLs, which is the same overflow by another route.
	maxScoutFieldLength = 512
	// A running budget stops a report degrading to nothing at all. Losing the tail of a
	// finding list is recoverable; losing an eight-minute scan to response_too_large is not.
	maxScoutReportBytes = 2 * 1024 * 1024
)

// boundScoutField keeps one projected field within its limit, marking a truncation rather
// than silently shortening a version an operator might otherwise act on.
func boundScoutField(value string) string {
	if len(value) <= maxScoutFieldLength {
		return value
	}
	return value[:maxScoutFieldLength] + "…"
}

// scoutSeverities is the display order, worst first. Scout also emits UNSPECIFIED, which
// means it has no CVSS v3 vector — not that the CVE is harmless.
var scoutSeverities = []string{"CRITICAL", "HIGH", "MEDIUM", "LOW", "UNSPECIFIED"}

type sarifReport struct {
	Runs []struct {
		Tool struct {
			Driver struct {
				Name    string `json:"name"`
				Version string `json:"version"`
				Rules   []struct {
					ID         string `json:"id"`
					HelpURI    string `json:"helpUri"`
					Properties struct {
						AffectedVersion string   `json:"affected_version"`
						FixedVersion    string   `json:"fixed_version"`
						Severity        string   `json:"cvssV3_severity"`
						SecuritySev     string   `json:"security-severity"`
						Purls           []string `json:"purls"`
					} `json:"properties"`
				} `json:"rules"`
			} `json:"driver"`
		} `json:"tool"`
	} `json:"runs"`
}

// parsePurl pulls the package name and installed version out of a package URL such as
// `pkg:apk/alpine/c-ares@1.34.6-r0?os_name=alpine`. The name is the last path segment, which
// is what an operator recognizes; the namespace before it is the distribution.
func parsePurl(purl string) (name string, version string) {
	value := strings.TrimPrefix(purl, "pkg:")
	if index := strings.IndexByte(value, '?'); index >= 0 {
		value = value[:index]
	}
	if index := strings.LastIndex(value, "@"); index >= 0 {
		version = value[index+1:]
		value = value[:index]
	}
	if decoded, err := url.PathUnescape(version); err == nil {
		version = decoded
	}
	segments := strings.Split(value, "/")
	name = segments[len(segments)-1]
	if decoded, err := url.PathUnescape(name); err == nil {
		name = decoded
	}
	return name, version
}

func normalizeScoutSeverity(value string) string {
	upper := strings.ToUpper(strings.TrimSpace(value))
	for _, known := range scoutSeverities {
		if upper == known {
			return upper
		}
	}
	// An unrecognized severity is reported as unspecified rather than dropped: a CVE that
	// Scout words differently must still be counted.
	return "UNSPECIFIED"
}

// parseScoutSARIF turns Scout's SARIF into the projection the UI needs.
func parseScoutSARIF(stdout []byte) ([]ScoutFinding, map[string]int, string, error) {
	summary := map[string]int{}
	for _, severity := range scoutSeverities {
		summary[severity] = 0
	}
	trimmed := bytes.TrimSpace(stdout)
	if len(trimmed) == 0 {
		return []ScoutFinding{}, summary, "", nil
	}
	var report sarifReport
	if err := json.Unmarshal(trimmed, &report); err != nil {
		return nil, nil, "", opError("scout_invalid",
			"Docker Scout returned a report that could not be read.", err, nil)
	}
	findings := []ScoutFinding{}
	budget := 0
	scanner := ""
	for _, run := range report.Runs {
		driver := run.Tool.Driver
		if scanner == "" && driver.Name != "" {
			scanner = strings.TrimSpace(driver.Name + " " + driver.Version)
		}
		for _, rule := range driver.Rules {
			severity := normalizeScoutSeverity(rule.Properties.Severity)
			summary[severity]++
			if len(findings) >= maxScoutFindings {
				continue
			}
			packageName, packageVersion := "", ""
			if len(rule.Properties.Purls) > 0 {
				packageName, packageVersion = parsePurl(rule.Properties.Purls[0])
			}
			score := 0.0
			if parsed, err := strconv.ParseFloat(rule.Properties.SecuritySev, 64); err == nil {
				score = parsed
			}
			finding := ScoutFinding{
				ID: boundScoutField(rule.ID), Severity: severity, Score: score,
				Package:          boundScoutField(packageName),
				InstalledVersion: boundScoutField(packageVersion),
				AffectedVersion:  boundScoutField(rule.Properties.AffectedVersion),
				FixedVersion:     boundScoutField(rule.Properties.FixedVersion),
				URL:              boundScoutField(rule.HelpURI),
			}
			budget += len(finding.ID) + len(finding.Package) + len(finding.InstalledVersion) +
				len(finding.AffectedVersion) + len(finding.FixedVersion) + len(finding.URL)
			if budget > maxScoutReportBytes {
				// Stop adding findings but keep counting severities, so the summary stays
				// truthful about how many exist even when the list is cut short.
				continue
			}
			findings = append(findings, finding)
		}
	}
	// Worst first, then by score, then by package so the order is stable between runs.
	rank := map[string]int{}
	for index, severity := range scoutSeverities {
		rank[severity] = index
	}
	sort.SliceStable(findings, func(i, j int) bool {
		if rank[findings[i].Severity] != rank[findings[j].Severity] {
			return rank[findings[i].Severity] < rank[findings[j].Severity]
		}
		if findings[i].Score != findings[j].Score {
			return findings[i].Score > findings[j].Score
		}
		return findings[i].Package < findings[j].Package
	})
	return findings, summary, scanner, nil
}

// imagesScout runs `docker scout cves` and projects its SARIF report.
//
// Scout is an optional CLI plugin with no Engine API, so this is CLI-routed and an absent
// plugin is a reportable state. It is never run automatically: the first analysis of an image
// indexes it, which is slow in proportion to image size, so the operator asks for it.
func (s *Service) imagesScout(parent context.Context, params ImagesScoutParams) (ImagesScoutResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ImagesScoutResult{}, err
	}
	reference := strings.TrimSpace(params.Reference)
	// Scout accepts an immutable image ID as well as a tag, so a dangling image can still be
	// analyzed; validateImageReference already rejects flag-like and whitespace-bearing input.
	if err := validateImageReference(reference); err != nil {
		return ImagesScoutResult{}, err
	}
	// Scout resolves more than images: `fs://` walks a local directory, `archive://` reads a
	// tarball, `sbom://` reads an SBOM. Because CVE matching is a network service, `fs:///home`
	// would build an inventory of the operator's files and send it off the machine. This
	// method analyses images, so every scheme is refused rather than allowlisting image://.
	if strings.Contains(reference, "://") {
		return ImagesScoutResult{}, opError("invalid_image_reference",
			"Analysis takes an image reference or ID, not a source scheme.", nil,
			map[string]any{"reference": reference})
	}
	release, err := acquireSlot(parent, s.scoutSlots, "scout_busy",
		"Another image is being analyzed; Scout indexes one image at a time.")
	if err != nil {
		return ImagesScoutResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, scoutTimeout)
	defer cancel()

	result, err := s.runDockerValidated(ctx, contextName,
		[]string{"scout", "cves", "--format", "sarif", reference}, scoutOutputLimit)
	if err != nil {
		return ImagesScoutResult{}, err
	}
	stderr := strings.TrimSpace(string(result.stderr))
	if result.timedOut {
		return ImagesScoutResult{}, opError("scout_timeout",
			"Docker Scout did not finish analyzing this image in time.", nil,
			map[string]any{"reference": reference})
	}
	if result.exitCode != 0 {
		if dockerPluginMissing(stderr) {
			return ImagesScoutResult{}, opError("scout_unavailable",
				"The Docker Scout plugin is not installed for this Docker CLI.", nil,
				map[string]any{"stderr": stderr})
		}
		return ImagesScoutResult{}, opError("scout_failed",
			"Docker Scout could not analyze this image.", nil,
			map[string]any{"exitCode": result.exitCode, "stderr": stderr,
				"reference": reference})
	}

	findings, summary, scanner, err := parseScoutSARIF(result.stdout)
	if err != nil {
		return ImagesScoutResult{}, err
	}
	total := 0
	for _, count := range summary {
		total += count
	}
	limitations := []string{}
	if total > len(findings) {
		limitations = append(limitations,
			"Showing the "+strconv.Itoa(len(findings))+" highest-severity findings of "+
				strconv.Itoa(total)+".")
	}
	return ImagesScoutResult{
		Context: contextName, Reference: reference, Source: "cli-sarif",
		Scanner: scanner, Summary: summary, Total: total, Findings: findings,
		ObservedAt: nowUTC(), Limitations: limitations,
	}, nil
}
