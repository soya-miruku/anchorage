package core

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
)

// The volume is mounted here inside the helper container. The name is deliberately
// distinctive so a listing can never be confused with the helper image's own filesystem.
const volumeHelperMount = "/anchorage-volume"

// volumeHelperLabel marks a helper so a leaked one can be found and removed by label rather
// than by guessing at its name.
const volumeHelperLabel = "io.anchorage.helper"

func mountMode(writable bool) string {
	if writable {
		return ":rw"
	}
	return ":ro"
}

// volumeHelperImage picks an image to instantiate the helper from.
//
// The helper is created and never started, so the image's contents are irrelevant — Docker
// only needs a valid image to build a container filesystem around the mount. Any local image
// therefore works, and using one avoids a network pull for what is meant to be a read. The
// smallest is preferred purely so the choice is deterministic.
func (s *Service) volumeHelperImage(ctx context.Context, client *engineClient) (string, error) {
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/images/json", nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", engineHTTPError("volume_browse_failed",
			"Docker Engine could not list images for the volume helper.", status, body)
	}
	var images []struct {
		ID        string   `json:"Id"`
		RepoTags  []string `json:"RepoTags"`
		SizeBytes int64    `json:"Size"`
	}
	if err := json.Unmarshal(body, &images); err != nil {
		return "", opError("volume_browse_failed",
			"Docker Engine returned invalid image JSON.", err, nil)
	}
	best := ""
	var bestSize int64
	for _, image := range images {
		if image.ID == "" {
			continue
		}
		if best == "" || image.SizeBytes < bestSize {
			best = image.ID
			bestSize = image.SizeBytes
		}
	}
	if best == "" {
		// Nothing to build a helper from. Saying so is more useful than a create failure,
		// because the fix is to pull any image at all.
		return "", opError("volume_browse_unavailable",
			"Browsing a volume needs at least one local image to mount it into; this Docker has none.",
			nil, nil)
	}
	return best, nil
}

// sweepVolumeHelpers force-removes any helper left behind by an earlier browse.
//
// The helper is labelled specifically so it can be found without guessing from a name. A leak
// matters more than it looks: the helper holds a reference on the volume, so `docker volume
// rm` fails with "volume is in use" and the volume survives a prune, with nothing on screen
// connecting the two.
func (s *Service) sweepVolumeHelpers(ctx context.Context, client *engineClient) {
	filters := `{"label":["` + volumeHelperLabel + `=volume-browse"]}`
	values := url.Values{}
	values.Set("all", "true")
	values.Set("filters", filters)
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/containers/json?"+values.Encode(), nil)
	if err != nil || status < 200 || status >= 300 {
		// Sweeping is opportunistic; a failure here must not block the browse the caller asked
		// for, and the per-request cleanup remains the primary mechanism.
		return
	}
	var containers []struct {
		ID string `json:"Id"`
	}
	if json.Unmarshal(body, &containers) != nil {
		return
	}
	for _, container := range containers {
		if container.ID == "" {
			continue
		}
		remove := url.Values{}
		remove.Set("force", "true")
		_, _, _ = client.request(ctx, http.MethodDelete,
			"/v"+client.apiVersion+"/containers/"+url.PathEscape(container.ID)+"?"+remove.Encode(), nil)
	}
}

// requireExistingVolume fails unless the volume already exists.
func (s *Service) requireExistingVolume(ctx context.Context, client *engineClient, volume string) error {
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/volumes/"+url.PathEscape(volume), nil)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		return opError("volume_not_found", "That volume does not exist.", nil,
			map[string]any{"volume": volume})
	}
	if status < 200 || status >= 300 {
		return engineHTTPError("volume_browse_failed",
			"Docker Engine could not confirm the volume exists.", status, body)
	}
	return nil
}

// withVolumeHelper creates a container with the volume mounted read-only, hands its ID to fn,
// and always removes it.
//
// The helper is never started: Docker's archive endpoint reads a container's filesystem
// whether or not a process has ever run in it, so browsing a volume executes no code at all.
// The mount is read-only so a browse cannot alter what it is inspecting.
// writable selects the mount mode. Browsing passes false so a read cannot alter what it is
// inspecting; only the upload path asks for write access, and only for the duration of the
// request.
func (s *Service) withVolumeHelper(ctx context.Context, client *engineClient, volume string,
	writable bool, fn func(containerID string) error) error {
	// Docker creates a volume implicitly when a bind names one that does not exist, so
	// browsing a mistyped name would silently create an empty volume. A read must not have
	// that side effect; the volume's existence is confirmed first.
	if err := s.requireExistingVolume(ctx, client, volume); err != nil {
		return err
	}
	image, err := s.volumeHelperImage(ctx, client)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"Image": image,
		"Labels": map[string]string{
			// Labelled so an operator can identify a helper that outlived its request, and so
			// a future sweep can find one without guessing from the name.
			volumeHelperLabel:     "volume-browse",
			"io.anchorage.volume": volume,
		},
		"HostConfig": map[string]any{
			"Binds":      []string{volume + ":" + volumeHelperMount + mountMode(writable)},
			"AutoRemove": false,
		},
	})
	if err != nil {
		return opError("volume_browse_failed", "The volume helper request could not be built.", err, nil)
	}
	// Sweep before creating. A helper only survives a request if the core died between the
	// create call and its cleanup, or if the create response was lost after the daemon had
	// already built the container — in both cases the ID was never known, so the label is the
	// only way back to it. Doing this here rather than only at startup means a leak is cleared
	// by the next browse instead of persisting until a restart.
	s.sweepVolumeHelpers(ctx, client)

	status, body, err := client.request(ctx, http.MethodPost,
		"/v"+client.apiVersion+"/containers/create", bytes.NewReader(payload))
	if err != nil {
		// The daemon may have created the container before the response was lost, in which
		// case nothing else will ever know its ID.
		s.sweepVolumeHelpers(context.WithoutCancel(ctx), client)
		return err
	}
	if status < 200 || status >= 300 {
		return engineHTTPError("volume_browse_failed",
			"Docker Engine rejected the volume helper container.", status, body)
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.ID == "" {
		return opError("volume_browse_failed",
			"Docker Engine returned no identity for the volume helper.", err, nil)
	}
	// Removal uses a context detached from the caller's so a cancelled or timed-out browse
	// still cleans up; a leaked helper would hold a reference on the volume and silently
	// block its removal.
	defer func() {
		removeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), domainReadTimeout)
		defer cancel()
		values := url.Values{}
		values.Set("force", "true")
		_, _, _ = client.request(removeCtx, http.MethodDelete,
			"/v"+client.apiVersion+"/containers/"+url.PathEscape(created.ID)+"?"+values.Encode(), nil)
	}()
	return fn(created.ID)
}

// volumeInternalPath maps a path the operator sees inside the volume onto its location in the
// helper. The volume's root is `/`, so a listing never leaks the helper's own filesystem.
func volumeInternalPath(requested string) (string, error) {
	target, err := normalizeContainerPath(requested)
	if err != nil {
		return "", err
	}
	if target == "/" {
		return volumeHelperMount, nil
	}
	return path.Join(volumeHelperMount, target), nil
}

// volumeVisiblePath is the inverse: entries are reported relative to the volume root.
func volumeVisiblePath(internal string) string {
	trimmed := strings.TrimPrefix(internal, volumeHelperMount)
	if trimmed == "" {
		return "/"
	}
	return trimmed
}

func (s *Service) volumeFiles(parent context.Context, params VolumeFilesParams) (VolumeFilesResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumeFilesResult{}, err
	}
	if err := validateVolumeName(params.Name); err != nil {
		return VolumeFilesResult{}, err
	}
	internal, err := volumeInternalPath(params.Path)
	if err != nil {
		return VolumeFilesResult{}, err
	}
	release, err := acquireSlot(parent, s.volumeSlots, "volume_browse_busy",
		"Too many volume reads are already in flight.")
	if err != nil {
		return VolumeFilesResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, volumeBrowseTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "volumes.files")
	if err != nil {
		return VolumeFilesResult{}, err
	}

	var entries []ContainerFileEntry
	truncated := false
	if err := s.withVolumeHelper(ctx, client, params.Name, false, func(containerID string) error {
		listed, cut, listErr := listArchiveChildren(ctx, client, containerID, internal)
		if listErr != nil {
			return listErr
		}
		entries, truncated = listed, cut
		return nil
	}); err != nil {
		return VolumeFilesResult{}, err
	}
	for index := range entries {
		entries[index].Path = volumeVisiblePath(entries[index].Path)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})

	limitations := []string{}
	if truncated {
		limitations = append(limitations,
			"Listing stopped at the entry cap; this directory contains more.")
	}
	return VolumeFilesResult{
		Context: contextName, Volume: params.Name, Source: "engine-api",
		Path: volumeVisiblePath(internal), Entries: entries, Truncated: truncated,
		ObservedAt: nowUTC(), Limitations: limitations,
	}, nil
}

func (s *Service) volumeFileRead(parent context.Context, params VolumeFileReadParams) (VolumeFileReadResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumeFileReadResult{}, err
	}
	if err := validateVolumeName(params.Name); err != nil {
		return VolumeFileReadResult{}, err
	}
	internal, err := volumeInternalPath(params.Path)
	if err != nil {
		return VolumeFileReadResult{}, err
	}
	if internal == volumeHelperMount {
		return VolumeFileReadResult{}, opError("invalid_path",
			"A directory cannot be read as a file.", nil, nil)
	}
	release, err := acquireSlot(parent, s.volumeSlots, "volume_browse_busy",
		"Too many volume reads are already in flight.")
	if err != nil {
		return VolumeFileReadResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, volumeBrowseTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "volumes.fileRead")
	if err != nil {
		return VolumeFileReadResult{}, err
	}

	var result VolumeFileReadResult
	if err := s.withVolumeHelper(ctx, client, params.Name, false, func(containerID string) error {
		values := url.Values{}
		values.Set("path", internal)
		requestPath := "/v" + client.apiVersion + "/containers/" + url.PathEscape(containerID) +
			"/archive?" + values.Encode()
		body, status, streamErr := client.stream(ctx, http.MethodGet, requestPath)
		if streamErr != nil {
			return streamErr
		}
		defer body.Close()
		if status < 200 || status >= 300 {
			payload, _ := io.ReadAll(io.LimitReader(body, 8*1024))
			return engineHTTPError("volume_file_read_failed",
				"Docker Engine rejected the volume path.", status, payload)
		}
		content, size, encoding, cut, readErr := readSingleArchiveFile(body)
		if readErr != nil {
			return readErr
		}
		result = VolumeFileReadResult{
			Context: contextName, Volume: params.Name, Path: volumeVisiblePath(internal),
			SizeBytes: size, Encoding: encoding, Content: content, Truncated: cut,
			ObservedAt: nowUTC(),
		}
		return nil
	}); err != nil {
		return VolumeFileReadResult{}, err
	}
	return result, nil
}

// volumeFileWrite uploads one file into a volume.
//
// The counterpart to browsing, and the only path that mounts the helper writable. The mode is
// a parameter of the operation rather than a property of the helper, so a read can never be
// made to alter what it inspects.
//
// The real hazard is writing into a volume a running container is using: Docker will happily
// mount the same volume into a second container, so an upload can land under a live database
// while it is writing. The core refuses unless that specific situation has been acknowledged,
// and the count comes from the daemon rather than from the caller.
func (s *Service) volumeFileWrite(parent context.Context, params VolumeFileWriteParams) (VolumeFileWriteResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumeFileWriteResult{}, err
	}
	if err := validateVolumeName(params.Name); err != nil {
		return VolumeFileWriteResult{}, err
	}
	internal, err := volumeInternalPath(params.Path)
	if err != nil {
		return VolumeFileWriteResult{}, err
	}
	entry, err := validateUploadName(params.FileName)
	if err != nil {
		return VolumeFileWriteResult{}, err
	}
	content, err := decodeUploadContent(params.Content)
	if err != nil {
		return VolumeFileWriteResult{}, err
	}

	release, err := acquireSlot(parent, s.volumeSlots, "volume_browse_busy",
		"Too many volume reads are already in flight.")
	if err != nil {
		return VolumeFileWriteResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, volumeBrowseTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "volumes.fileWrite")
	if err != nil {
		return VolumeFileWriteResult{}, err
	}
	inUse, err := s.volumeReferenceCount(ctx, client, params.Name)
	if err != nil {
		return VolumeFileWriteResult{}, err
	}
	if inUse > 0 && !params.ConfirmedInUse {
		return VolumeFileWriteResult{}, opError("volume_in_use",
			"That volume is attached to a running container; writing to it now can corrupt data it is using.",
			nil, map[string]any{"volume": params.Name, "containers": inUse})
	}

	archive, err := buildUploadArchive(entry, content, params.Mode)
	if err != nil {
		return VolumeFileWriteResult{}, err
	}
	if err := s.withVolumeHelper(ctx, client, params.Name, true, func(containerID string) error {
		values := url.Values{}
		values.Set("path", internal)
		status, body, requestErr := client.request(ctx, http.MethodPut,
			"/v"+client.apiVersion+"/containers/"+url.PathEscape(containerID)+
				"/archive?"+values.Encode(), bytes.NewReader(archive))
		if requestErr != nil {
			return requestErr
		}
		if status < 200 || status >= 300 {
			return engineHTTPError("volume_file_write_failed",
				"Docker Engine rejected the volume upload.", status, body)
		}
		return nil
	}); err != nil {
		return VolumeFileWriteResult{}, err
	}
	return VolumeFileWriteResult{
		Context: contextName, Volume: params.Name,
		Path:      path.Join(volumeVisiblePath(internal), entry),
		SizeBytes: int64(len(content)), ObservedAt: nowUTC(),
	}, nil
}

// volumeReferenceCount asks the daemon how many running containers hold the volume. The
// answer must come from Docker rather than a renderer-supplied flag, since the whole point is
// to stop an upload landing under something live.
func (s *Service) volumeReferenceCount(ctx context.Context, client *engineClient, volume string) (int, error) {
	values := url.Values{}
	values.Set("all", "true")
	values.Set("filters", `{"volume":["`+volume+`"]}`)
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/containers/json?"+values.Encode(), nil)
	if err != nil {
		return 0, err
	}
	if status < 200 || status >= 300 {
		return 0, engineHTTPError("volume_file_write_failed",
			"Docker Engine could not report which containers use the volume.", status, body)
	}
	var containers []struct {
		State string `json:"State"`
	}
	if err := json.Unmarshal(body, &containers); err != nil {
		return 0, opError("volume_file_write_failed",
			"Docker Engine returned invalid container JSON.", err, nil)
	}
	running := 0
	for _, container := range containers {
		// A stopped container holding the volume cannot be writing to it, so it is not the
		// hazard this gate exists for.
		if container.State == "running" || container.State == "paused" {
			running++
		}
	}
	return running, nil
}
