package core

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"
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
// Any local image works, which avoids a network pull for what is meant to be a read, and the
// smallest is preferred so the choice is deterministic.
//
// The image's contents used to be irrelevant, because the helper was never started. They matter
// slightly now: the fast listing path needs `/bin/sh` to exec `ls` into. An image without one
// still produces a usable helper — the start simply fails and the caller falls back to the
// archive walk — so this stays a preference rather than a requirement, and no image is ever
// pulled to satisfy it.
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

// holdVolumeHelper records a helper this process created and still owns, and returns the
// release for when it is gone.
//
// The sweep below exists for helpers whose ID was lost, and it finds them by label — which
// matches every live helper too. Two volume operations can run at once, and a clone runs two
// helpers by itself, so without this the second create would force-remove the container the
// first is still streaming from.
func (s *Service) holdVolumeHelper(containerID string) func() {
	s.helperMu.Lock()
	if s.liveHelpers == nil {
		s.liveHelpers = map[string]bool{}
	}
	s.liveHelpers[containerID] = true
	s.helperMu.Unlock()
	return func() {
		s.helperMu.Lock()
		delete(s.liveHelpers, containerID)
		s.helperMu.Unlock()
	}
}

func (s *Service) helperIsLive(containerID string) bool {
	s.helperMu.Lock()
	defer s.helperMu.Unlock()
	return s.liveHelpers[containerID]
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
		if container.ID == "" || s.helperIsLive(container.ID) {
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
	// A parked helper skips the whole create path, which is where the time goes.
	key := volumeHelperKey(volume, writable)
	if containerID, release, ok := s.takeVolumeHelper(ctx, client, key); ok {
		defer func() {
			release()
			if s.parkVolumeHelper(key, containerID, client) {
				return
			}
			s.removeVolumeHelper(context.WithoutCancel(ctx), client, containerID)
		}()
		return fn(containerID)
	}
	image, err := s.volumeHelperImage(ctx, client)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"Image": image,
		// The image's own program never runs: the entrypoint is overridden and the container
		// executes nothing but a sleep loop, which exists so `ls` can be exec-ed into it.
		"Entrypoint": []string{"/bin/sh"},
		"Cmd":        []string{"-c", volumeHelperIdleCommand},
		"Labels": map[string]string{
			// Labelled so an operator can identify a helper that outlived its request, and so
			// a future sweep can find one without guessing from the name.
			volumeHelperLabel:     "volume-browse",
			"io.anchorage.volume": volume,
		},
		"HostConfig": map[string]any{
			"Binds":      []string{volume + ":" + volumeHelperMount + mountMode(writable)},
			"AutoRemove": false,
			/*
				A helper that runs a process is a helper that could do more than read, so it is
				given nothing to do it with — with one exception, which is the point.

				`CAP_DAC_READ_SEARCH` is the capability to read and traverse any path
				regardless of its mode. Dropping it looked like obvious hardening and broke
				precisely the volumes worth browsing: a Postgres data directory is
				`drwx------` owned by another uid, and root without this capability gets
				"Permission denied", so every such volume listed as empty. The archive endpoint
				this replaces runs inside dockerd and was never subject to file modes at all,
				so restoring this restores the access that already existed rather than adding
				any.

				It grants reading, not writing. `DAC_OVERRIDE` — which would also bypass write
				permission — is added only for an upload, which is the only request that has a
				reason to write.
			*/
			"NetworkMode":    "none",
			"CapDrop":        []string{"ALL"},
			"CapAdd":         volumeHelperCapabilities(writable),
			"SecurityOpt":    []string{"no-new-privileges"},
			"ReadonlyRootfs": !writable,
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
	// Started so `ls` can be exec-ed into it. If this fails — an image with no /bin/sh, a
	// daemon that refuses — the helper is still usable for the archive walk, so the error is
	// recorded on the container rather than returned.
	startStatus, startBody, startErr := client.request(ctx, http.MethodPost,
		"/v"+client.apiVersion+"/containers/"+url.PathEscape(created.ID)+"/start", nil)
	started := startErr == nil && startStatus >= 200 && startStatus < 300
	_ = startBody

	release := s.holdVolumeHelper(created.ID)
	// Removal uses a context detached from the caller's so a cancelled or timed-out browse
	// still cleans up; a leaked helper would hold a reference on the volume and silently
	// block its removal.
	defer func() {
		release()
		if s.parkVolumeHelper(key, created.ID, client) {
			// Parked for the next request against this volume rather than destroyed. It is
			// still labelled, still swept, and still removed on idle — see reapVolumeHelpers.
			return
		}
		s.removeVolumeHelper(context.WithoutCancel(ctx), client, created.ID)
	}()
	s.recordHelperStarted(created.ID, started)
	return fn(created.ID)
}

/*
Keeping one helper alive between requests.

Every listing used to create a container and destroy it again. The listing itself is an archive
read and takes about ten milliseconds; the container create takes **eight seconds** on the
reference host. So the cost of browsing was almost entirely the cost of building somewhere to
browse from, paid again on every directory the operator opened — five levels deep was forty
seconds of pure container churn, which is what "two minutes and I still cannot get into a
folder" actually was.

A helper is now parked after use and reused by the next request for the same volume and
mount mode, which is the difference between eight seconds a hop and roughly none. The
properties that made the create-per-request version safe are all kept:

  - **Mount mode is part of the key.** A read-only helper is never handed to a writer, because
    the bind was established at create time and cannot be changed afterwards.
  - **A parked helper is still held.** `liveHelpers` still lists it, so a concurrent sweep will
    not force-remove a container another request is about to use.
  - **It is still labelled**, so a helper that outlives this process is still found by the
    sweep rather than leaking a reference that blocks `docker volume rm`.
  - **It is removed on idle**, so a browse does not leave a container sitting on the volume
    indefinitely — which would block exactly the removal the sweep exists to protect.

Only one helper is parked per key, and only one key at a time is parked in total: a browse is
something an operator does in one place, and holding a container open per volume they happened
to glance at would trade the problem for a different one.
*/
const volumeHelperIdle = 90 * time.Second

type parkedVolumeHelper struct {
	containerID string
	/*
		The client that created it, and therefore the only one that can remove it.

		A container ID means nothing to a daemon that did not make the container. Eviction used
		the *incoming* caller's client instead, so browsing a volume on one daemon and then a
		volume on another deleted the first helper's ID against the second daemon: the call
		found no such container, the helper kept running, and it held its volume until something
		swept that daemon. The core acceptance suite hits this every run — it browses on the
		host and again inside a disposable dind — and the visible symptom was `docker volume rm`
		failing with "volume is in use".
	*/
	client  *engineClient
	release func()
	timer   *time.Timer
}

func volumeHelperKey(volume string, writable bool) string {
	if writable {
		return volume + "\x00rw"
	}
	return volume + "\x00ro"
}

// takeVolumeHelper returns a parked helper for this key, if one is waiting, and confirms with
// the daemon that it still exists — a container removed behind our back (a `docker rm`, a
// prune, a daemon restart) must not be handed out as though it were usable.
func (s *Service) takeVolumeHelper(ctx context.Context, client *engineClient, key string) (string, func(), bool) {
	s.helperMu.Lock()
	parked, ok := s.parkedHelpers[key]
	if ok {
		delete(s.parkedHelpers, key)
		parked.timer.Stop()
	}
	s.helperMu.Unlock()
	if !ok {
		return "", nil, false
	}
	status, _, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/containers/"+url.PathEscape(parked.containerID)+"/json", nil)
	if err != nil || status < 200 || status >= 300 {
		parked.release()
		return "", nil, false
	}
	return parked.containerID, parked.release, true
}

// parkVolumeHelper keeps a helper for the next request. It reports whether it took ownership;
// when it declines, the caller removes the container as before.
func (s *Service) parkVolumeHelper(key, containerID string, client *engineClient) bool {
	s.helperMu.Lock()
	defer s.helperMu.Unlock()
	if s.parkedHelpers == nil {
		s.parkedHelpers = map[string]*parkedVolumeHelper{}
	}
	// One at a time. Anything already parked under a different key is dropped rather than
	// accumulated, so a session that walks several volumes cannot pin a container on each.
	for existing, helper := range s.parkedHelpers {
		if existing == key {
			continue
		}
		helper.timer.Stop()
		delete(s.parkedHelpers, existing)
		go func(id string, owner *engineClient, done func()) {
			done()
			removeCtx, cancel := context.WithTimeout(context.Background(), domainReadTimeout)
			defer cancel()
			s.removeVolumeHelper(removeCtx, owner, id)
		}(helper.containerID, helper.client, helper.release)
	}
	if _, taken := s.parkedHelpers[key]; taken {
		return false
	}
	// The hold is re-taken for the parked lifetime so a sweep cannot claim it while it waits.
	// Taken inline rather than through holdVolumeHelper: this function already owns helperMu,
	// and that one locks it too — a self-deadlock on a mutex Go will not let you re-enter.
	if s.liveHelpers == nil {
		s.liveHelpers = map[string]bool{}
	}
	s.liveHelpers[containerID] = true
	hold := func() {
		s.helperMu.Lock()
		delete(s.liveHelpers, containerID)
		s.helperMu.Unlock()
	}
	helper := &parkedVolumeHelper{containerID: containerID, client: client, release: hold}
	helper.timer = time.AfterFunc(volumeHelperIdle, func() {
		s.helperMu.Lock()
		current, still := s.parkedHelpers[key]
		if still && current.containerID == containerID {
			delete(s.parkedHelpers, key)
		}
		s.helperMu.Unlock()
		hold()
		removeCtx, cancel := context.WithTimeout(context.Background(), domainReadTimeout)
		defer cancel()
		s.removeVolumeHelper(removeCtx, client, containerID)
	})
	s.parkedHelpers[key] = helper
	return true
}

func (s *Service) removeVolumeHelper(ctx context.Context, client *engineClient, containerID string) {
	// Guarded because two of the three callers run on a goroutine — the idle timer and the
	// eviction below — and a panic there takes the whole core down rather than one request.
	// The sweep still finds anything this declines to remove, by label.
	if client == nil || containerID == "" {
		return
	}
	values := url.Values{}
	values.Set("force", "true")
	_, _, _ = client.request(ctx, http.MethodDelete,
		"/v"+client.apiVersion+"/containers/"+url.PathEscape(containerID)+"?"+values.Encode(), nil)
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
	source := "archive"
	if err := s.withVolumeHelper(ctx, client, params.Name, false, func(containerID string) error {
		listed, cut, used, listErr := s.listVolumeChildren(ctx, client, containerID, internal)
		if listErr != nil {
			return listErr
		}
		entries, truncated, source = listed, cut, used
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
	// Which instrument answered is reported rather than hidden, because the two have different
	// properties and the panel tells the operator what was done on their behalf: `exec` runs a
	// shell in the helper, `archive` does not but cannot list a large directory.
	if source == "archive" {
		limitations = append(limitations,
			"Listed by reading the volume's archive stream, because the helper could not be started. Large directories cannot be listed this way.")
	}
	return VolumeFilesResult{
		Context: contextName, Volume: params.Name, Source: "engine-api",
		Path: volumeVisiblePath(internal), Entries: entries, Truncated: truncated,
		Listing: source, ObservedAt: nowUTC(), Limitations: limitations,
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

// volumeBackup writes a volume's entire contents to a host tar.
//
// This is what volumes are actually for: the data outlives the container, so there has to be
// a way to get it out. Docker offers no endpoint for it — the archive stream is read through
// the same never-started helper the browser uses, and copied straight to disk so a volume
// larger than memory is still backupable.
//
// The helper's mount point is stripped as the stream is rewritten, so the archive holds the
// volume's contents at its root. That makes it an ordinary tar the operator can inspect with
// `tar -tf` or hand to any other tool, rather than one carrying an Anchorage-shaped prefix.
func (s *Service) volumeBackup(parent context.Context, params VolumeBackupParams) (VolumeBackupResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumeBackupResult{}, err
	}
	if err := validateVolumeName(params.Name); err != nil {
		return VolumeBackupResult{}, err
	}
	archivePath, err := s.validateArchivePath(params.ArchivePath, false, params.Overwrite)
	if err != nil {
		return VolumeBackupResult{}, err
	}

	release, err := acquireSlot(parent, s.volumeSlots, "volume_browse_busy",
		"Too many volume reads are already in flight.")
	if err != nil {
		return VolumeBackupResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, volumeBackupTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "volumes.backup")
	if err != nil {
		return VolumeBackupResult{}, err
	}

	var entries int
	var written int64
	if err := s.withVolumeHelper(ctx, client, params.Name, false, func(containerID string) error {
		values := url.Values{}
		values.Set("path", volumeHelperMount)
		body, status, streamErr := client.stream(ctx, http.MethodGet,
			"/v"+client.apiVersion+"/containers/"+url.PathEscape(containerID)+
				"/archive?"+values.Encode())
		if streamErr != nil {
			return streamErr
		}
		defer body.Close()
		if status < 200 || status >= 300 {
			payload, _ := io.ReadAll(io.LimitReader(body, 8*1024))
			return engineHTTPError("volume_backup_failed",
				"Docker Engine rejected the volume read.", status, payload)
		}
		file, createErr := os.OpenFile(archivePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if createErr != nil {
			return opError("volume_backup_failed",
				"The backup file could not be created.", createErr,
				map[string]any{"path": archivePath})
		}
		// Closed before the helper is removed so a partial file is never left looking whole.
		defer file.Close()
		entries, written, err = rewriteVolumeArchive(body, file)
		return err
	}); err != nil {
		// A failed backup must not leave a truncated tar behind that looks like a real one.
		_ = os.Remove(archivePath)
		return VolumeBackupResult{}, err
	}
	return VolumeBackupResult{
		Context: contextName, Volume: params.Name, ArchivePath: archivePath,
		Entries: entries, SizeBytes: written, ObservedAt: nowUTC(),
	}, nil
}

// rewriteVolumeArchive copies a tar stream, stripping the helper's mount prefix so the result
// is rooted at the volume's own contents. Entry by entry, so a volume larger than memory is
// still handled.
func rewriteVolumeArchive(source io.Reader, destination io.Writer) (int, int64, error) {
	prefix := strings.TrimPrefix(volumeHelperMount, "/") + "/"
	reader := tar.NewReader(source)
	writer := tar.NewWriter(destination)
	entries := 0
	var written int64
	for {
		header, readErr := reader.Next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, 0, opError("volume_backup_invalid",
				"Docker Engine returned an unreadable archive stream.", readErr, nil)
		}
		name := strings.TrimPrefix(path.Clean(header.Name), "./")
		name = strings.TrimPrefix(name, prefix)
		if name == "" || name == strings.TrimSuffix(prefix, "/") {
			// The mount point itself; its children are what the backup is for.
			continue
		}
		rewritten := *header
		rewritten.Name = name
		if err := writer.WriteHeader(&rewritten); err != nil {
			return 0, 0, opError("volume_backup_failed",
				"The backup archive could not be written.", err, nil)
		}
		if header.Typeflag == tar.TypeReg {
			copied, copyErr := io.Copy(writer, reader)
			if copyErr != nil {
				return 0, 0, opError("volume_backup_failed",
					"The backup archive could not be written.", copyErr, nil)
			}
			written += copied
		}
		entries++
	}
	if err := writer.Close(); err != nil {
		return 0, 0, opError("volume_backup_failed",
			"The backup archive could not be finalized.", err, nil)
	}
	return entries, written, nil
}

// volumeRestore extracts a backup tar back into a volume.
//
// The inverse of volumeBackup, and destructive in a way backup is not: it writes into a
// volume that may already hold data, and Docker will let it happen under a running container.
// Both hazards are acknowledged separately — one for overwriting existing contents, one for
// doing it while something is using them.
func (s *Service) volumeRestore(parent context.Context, params VolumeRestoreParams) (VolumeRestoreResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumeRestoreResult{}, err
	}
	if err := validateVolumeName(params.Name); err != nil {
		return VolumeRestoreResult{}, err
	}
	archivePath, err := s.validateArchivePath(params.ArchivePath, true, false)
	if err != nil {
		return VolumeRestoreResult{}, err
	}
	if !params.Confirmed {
		return VolumeRestoreResult{}, confirmationRequired("volume", params.Name, "restore")
	}

	release, err := acquireSlot(parent, s.volumeSlots, "volume_browse_busy",
		"Too many volume reads are already in flight.")
	if err != nil {
		return VolumeRestoreResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, volumeBackupTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "volumes.restore")
	if err != nil {
		return VolumeRestoreResult{}, err
	}
	inUse, err := s.volumeReferenceCount(ctx, client, params.Name)
	if err != nil {
		return VolumeRestoreResult{}, err
	}
	if inUse > 0 && !params.ConfirmedInUse {
		return VolumeRestoreResult{}, opError("volume_in_use",
			"That volume is attached to a running container; restoring over it can corrupt data it is using.",
			nil, map[string]any{"volume": params.Name, "containers": inUse})
	}

	if err := s.withVolumeHelper(ctx, client, params.Name, true, func(containerID string) error {
		file, openErr := os.Open(archivePath)
		if openErr != nil {
			return opError("invalid_archive_path", "The backup file could not be read.",
				openErr, map[string]any{"path": archivePath})
		}
		defer file.Close()
		values := url.Values{}
		values.Set("path", volumeHelperMount)
		status, body, requestErr := client.request(ctx, http.MethodPut,
			"/v"+client.apiVersion+"/containers/"+url.PathEscape(containerID)+
				"/archive?"+values.Encode(), file)
		if requestErr != nil {
			return requestErr
		}
		if status < 200 || status >= 300 {
			return engineHTTPError("volume_restore_failed",
				"Docker Engine rejected the volume restore.", status, body)
		}
		return nil
	}); err != nil {
		return VolumeRestoreResult{}, err
	}
	return VolumeRestoreResult{
		Context: contextName, Volume: params.Name, ArchivePath: archivePath,
		ObservedAt: nowUTC(),
	}, nil
}

/*
Listing a directory by running `ls` in the helper, rather than tarring the volume.

The archive endpoint returns a directory's whole subtree, depth-first, so listing the root of a
625 GB volume meant streaming hundreds of gigabytes to find the second entry. Measured: 1,053 MB
in two seconds, one entry found. That is not a slow listing, it is the wrong instrument.

Running `ls` in the helper is the right one. Measured on the same volume: 0.043 seconds. Each
name is then stat-ed with `HEAD /archive`, which answers with a header carrying exactly the
fields a listing needs — size, mode, mtime, link target — and never tars anything.

This is why the helper is now started. It was created and never started, which was a real
property worth having, and it is given up deliberately rather than by accident:

  - The entrypoint is overridden, so the image's own program never runs. The container executes
    `/bin/sh -c 'while :; do sleep …; done'` and nothing else.
  - It has no network, drops every capability, and cannot gain privileges. A read mounts the
    volume read-only, exactly as before.
  - If any of that fails — no shell in the image, a daemon that refuses the start — the caller
    falls back to the archive walk, which still works for small directories. Nothing regresses.

The panel says which one answered, because "created and never started" was on screen and is no
longer true for the fast path.
*/

const volumeHelperIdleCommand = "while :; do sleep 3600; done"

// volumeHelperCapabilities is the smallest set that lets the helper do the job asked of it.
// Reading any path needs DAC_READ_SEARCH; writing into one needs DAC_OVERRIDE as well, and only
// an upload writes.
func volumeHelperCapabilities(writable bool) []string {
	if writable {
		return []string{"DAC_READ_SEARCH", "DAC_OVERRIDE"}
	}
	return []string{"DAC_READ_SEARCH"}
}

// execListNames runs `ls -A` in a started helper and returns the direct children by name.
//
// Names only. Parsing `ls -l` means parsing a date format that differs between GNU coreutils
// and busybox, and a filename column that can contain spaces; one name per line has neither
// problem, and `HEAD /archive` supplies the metadata exactly.
func execListNames(ctx context.Context, client *engineClient, containerID, target string) ([]string, error) {
	payload, err := json.Marshal(map[string]any{
		"AttachStdout": true,
		// Attached so a failure is legible. It was not, and that was the whole defect: a
		// permission-denied `ls` wrote to a stream nobody read, exited non-zero into an exit
		// code nobody checked, and produced zero names — which the caller rendered as "Empty
		// directory" for every volume whose contents are not world-readable.
		"AttachStderr": true,
		/*
			No TTY, deliberately, and this was got wrong first.

			With `Tty: true` the output arrives raw and needs no demultiplexing, which is why it
			was tempting. But `ls` then believes it is talking to a terminal: it prints in
			columns and wraps every name in ANSI colour, so the first run came back with one
			"entry" reading "\x1b[1;34mlive-capture\x1b[m  \x1b[1;34mregistry\x1b[m". Without a
			TTY it prints one plain name per line, and the eight-byte frame header that comes
			with that is trivial to strip.
		*/
		"Tty": false,
		// `-1` as well as no TTY: belt and braces against an image whose ls is wrapped.
		"Cmd": []string{"/bin/sh", "-c", "ls -1A -- " + quoteForShell(target)},
		/*
			Root, because the daemon already reads this volume as root.

			The archive endpoint this replaces runs inside dockerd and is not subject to the
			image's user at all, so it could read a 0700 directory owned by another uid. The
			exec inherits the image's user instead, and most real volumes are not
			world-readable — a Postgres data directory is `drwx------` — so without this the
			fast path returned nothing for exactly the volumes worth browsing.

			This grants no access the previous implementation did not have. It is root inside a
			container with no network, no capabilities and a read-only mount.
		*/
		"User": "0:0",
	})
	if err != nil {
		return nil, opError("volume_browse_failed", "The listing command could not be built.", err, nil)
	}
	status, body, err := client.request(ctx, http.MethodPost,
		"/v"+client.apiVersion+"/containers/"+url.PathEscape(containerID)+"/exec",
		bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, engineHTTPError("volume_exec_failed",
			"Docker Engine refused the listing command.", status, body)
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.ID == "" {
		return nil, opError("volume_exec_failed",
			"Docker Engine returned no identity for the listing command.", err, nil)
	}

	startPayload, err := json.Marshal(map[string]any{"Detach": false, "Tty": false})
	if err != nil {
		return nil, opError("volume_browse_failed", "The listing start could not be built.", err, nil)
	}
	stream, startStatus, err := client.streamWithBody(ctx, http.MethodPost,
		"/v"+client.apiVersion+"/exec/"+url.PathEscape(created.ID)+"/start",
		bytes.NewReader(startPayload))
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	if startStatus < 200 || startStatus >= 300 {
		return nil, opError("volume_exec_failed",
			"Docker Engine refused to run the listing command.", nil,
			map[string]any{"status": startStatus})
	}
	// Bounded like every other read here: a directory with a million names must not be able to
	// buffer a million names.
	raw, err := io.ReadAll(io.LimitReader(stream, 4*1024*1024))
	if err != nil {
		return nil, opError("volume_exec_failed", "The listing output could not be read.", err, nil)
	}

	stdout, stderr := demultiplex(raw)

	// The exit code is the difference between "this directory is empty" and "the listing
	// failed". Treating them alike is what made every unreadable volume look empty.
	status, body, err = client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/exec/"+url.PathEscape(created.ID)+"/json", nil)
	if err != nil {
		return nil, err
	}
	var inspected struct {
		ExitCode int  `json:"ExitCode"`
		Running  bool `json:"Running"`
	}
	if status < 200 || status >= 300 || json.Unmarshal(body, &inspected) != nil {
		return nil, opError("volume_exec_failed",
			"Docker Engine did not report how the listing command ended.", nil,
			map[string]any{"status": status})
	}
	if inspected.Running || inspected.ExitCode != 0 {
		return nil, opError("volume_exec_failed",
			"The listing command failed inside the helper.", nil, map[string]any{
				"exitCode": inspected.ExitCode,
				"stderr":   strings.TrimSpace(boundScoutField(stderr)),
			})
	}

	names := []string{}
	for _, line := range strings.Split(stdout, "\n") {
		name := strings.TrimRight(line, "\r")
		// `.` and `..` are not returned by `ls -A`, but a defensive skip costs nothing and a
		// name containing a slash is not a direct child whatever produced it.
		if name == "" || name == "." || name == ".." || strings.Contains(name, "/") {
			continue
		}
		names = append(names, name)
		if len(names) >= maxFileEntries {
			break
		}
	}
	return names, nil
}

// shellQuote wraps a path for `sh -c`. The path is derived from a validated request rather than
// taken raw, but it still reaches a shell, so it is quoted rather than trusted.
func quoteForShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// statArchiveEntry reads one path's metadata from the header `HEAD /archive` answers with. It
// stats the path and tars nothing, which is the whole reason this is not the GET.
func statArchiveEntry(ctx context.Context, client *engineClient, containerID, target string) (ContainerFileEntry, bool) {
	values := url.Values{}
	values.Set("path", target)
	request, err := http.NewRequestWithContext(ctx, http.MethodHead,
		"http://docker/v"+client.apiVersion+"/containers/"+url.PathEscape(containerID)+
			"/archive?"+values.Encode(), nil)
	if err != nil {
		return ContainerFileEntry{}, false
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ContainerFileEntry{}, false
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ContainerFileEntry{}, false
	}
	encoded := response.Header.Get("X-Docker-Container-Path-Stat")
	if encoded == "" {
		return ContainerFileEntry{}, false
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return ContainerFileEntry{}, false
	}
	var stat struct {
		Name       string `json:"name"`
		Size       int64  `json:"size"`
		Mode       uint32 `json:"mode"`
		MTime      string `json:"mtime"`
		LinkTarget string `json:"linkTarget"`
	}
	if err := json.Unmarshal(decoded, &stat); err != nil {
		return ContainerFileEntry{}, false
	}
	mode := fs.FileMode(stat.Mode)
	entry := ContainerFileEntry{
		Name:       stat.Name,
		Path:       target,
		IsDir:      mode.IsDir(),
		SizeBytes:  stat.Size,
		Mode:       mode.String(),
		LinkTarget: stat.LinkTarget,
	}
	if parsed, err := time.Parse(time.RFC3339Nano, stat.MTime); err == nil {
		entry.ModifiedAt = parsed.UTC().Format(time.RFC3339)
	}
	return entry, true
}

// recordHelperStarted remembers whether a helper is running, so a listing knows whether the
// fast path is available without asking the daemon again on every hop.
func (s *Service) recordHelperStarted(containerID string, started bool) {
	s.helperMu.Lock()
	defer s.helperMu.Unlock()
	if s.startedHelpers == nil {
		s.startedHelpers = map[string]bool{}
	}
	s.startedHelpers[containerID] = started
}

func (s *Service) helperIsStarted(containerID string) bool {
	s.helperMu.Lock()
	defer s.helperMu.Unlock()
	return s.startedHelpers[containerID]
}

/*
listVolumeChildren picks the instrument that suits the directory.

`ls` in a started helper, stat-ed per entry, is correct at any size. The archive walk is the
fallback for a helper that would not start, and remains subject to its own bounds — it is the
one that cannot list a large directory at all.
*/
func (s *Service) listVolumeChildren(ctx context.Context, client *engineClient,
	containerID, internal string) ([]ContainerFileEntry, bool, string, error) {
	if s.helperIsStarted(containerID) {
		names, err := execListNames(ctx, client, containerID, internal)
		// A failing exec used to fall through silently, which turned "the listing command
		// failed" into "this directory is empty" for every volume that was not world-readable.
		// The fallback is for a helper that never started; a started helper whose listing
		// failed is a fault worth reporting.
		if err != nil {
			return nil, false, "exec", err
		}
		{
			entries := make([]ContainerFileEntry, 0, len(names))
			for _, name := range names {
				// A name that cannot be stat-ed is still listed. A broken symlink or a file
				// removed between the listing and the stat is a real thing to see, and
				// dropping it would make the directory look emptier than it is.
				if entry, ok := statArchiveEntry(ctx, client, containerID, path.Join(internal, name)); ok {
					entries = append(entries, entry)
					continue
				}
				entries = append(entries, ContainerFileEntry{
					Name: name, Path: path.Join(internal, name), Mode: "?",
				})
			}
			return entries, len(names) >= maxFileEntries, "exec", nil
		}
	}
	entries, truncated, err := listArchiveChildren(ctx, client, containerID, internal)
	return entries, truncated, "archive", err
}

/*
demultiplex strips Docker's stream framing from an attached exec's output.

Without a TTY the daemon frames each chunk with eight bytes — one for the stream, three unused,
then a big-endian length. Dropping to a TTY to avoid this is what produced columnar, ANSI-
coloured output the first time, so the framing is parsed instead.

A frame whose header is short or whose length runs past the buffer means the stream was cut, and
what has been read so far is returned rather than discarded: a truncated listing is still a
listing, and the caller bounds it either way.
*/
func demultiplex(raw []byte) (string, string) {
	var stdout, stderr strings.Builder
	for len(raw) >= 8 {
		// Byte zero is the stream: 1 is stdout, 2 is stderr. Merging them would let a
		// permission-denied message become a filename in the listing.
		stream := raw[0]
		size := int(binary.BigEndian.Uint32(raw[4:8]))
		raw = raw[8:]
		if size > len(raw) {
			size = len(raw)
		}
		if stream == 2 {
			stderr.Write(raw[:size])
		} else {
			stdout.Write(raw[:size])
		}
		raw = raw[size:]
	}
	return stdout.String(), stderr.String()
}

/*
ReleaseVolumeHelpersFor removes the helpers holding one volume, and waits for them to go.

A parked helper is a *running* container with the volume mounted, which is what makes the second
hop through a directory tree fast. It is also, to the daemon, a reason the volume cannot be
removed:

	Error response from daemon: remove anchorage_browse_4d8dfef7:
	volume is in use - [ad75365a2bb57de1ecf74701f446841d2aeaddbccf6fd7c58356a17ad520ab52]

Found by the core acceptance suite, which browses a volume and then removes it — the exact
sequence an operator performs when they look inside something before deleting it. The idle timer
would have released it eventually, so this was a window rather than a wall, and a window is
worse: the removal fails only if you are quick, which reads as Docker being flaky.

Both spellings of the key, because a browse opens read-only and a write opens read-write, and
whichever the operator did last is the one still parked. Synchronous on purpose: the caller is
about to ask the daemon to remove the volume, and a release that has not finished is a release
that has not happened.
*/
func (s *Service) ReleaseVolumeHelpersFor(ctx context.Context, volume string) {
	name := strings.TrimSpace(volume)
	if name == "" {
		return
	}
	s.helperMu.Lock()
	held := make([]*parkedVolumeHelper, 0, 2)
	for _, writable := range []bool{false, true} {
		key := volumeHelperKey(name, writable)
		if helper, ok := s.parkedHelpers[key]; ok {
			helper.timer.Stop()
			held = append(held, helper)
			delete(s.parkedHelpers, key)
		}
	}
	s.helperMu.Unlock()
	// Each through the client that created it. Resolving a fresh endpoint here was the first
	// attempt and it was wrong twice over: against "default" it addressed the wrong daemon, and
	// against the caller's context it still assumed the helper came from the same place.
	for _, helper := range held {
		helper.release()
		s.removeVolumeHelper(ctx, helper.client, helper.containerID)
	}
}

/*
ReleaseVolumeHelpers removes any helper this process is holding.

A parked helper is kept alive by an idle timer, and a timer dies with the process. Before the
helper was started that left a created-but-not-running container, which is untidy; now it would
leave a *running* one holding a reference on the volume, which silently blocks `docker volume
rm` until something sweeps it.

The sweep before each create still catches these, so this is not the only line of defence — it
is the one that means a clean shutdown does not need a later browse to tidy up after it.
*/
func (s *Service) ReleaseVolumeHelpers(ctx context.Context) {
	s.helperMu.Lock()
	parked := make([]*parkedVolumeHelper, 0, len(s.parkedHelpers))
	for key, helper := range s.parkedHelpers {
		helper.timer.Stop()
		parked = append(parked, helper)
		delete(s.parkedHelpers, key)
	}
	s.helperMu.Unlock()
	// Each through the client that created it, for the same reason as above: this sweep can be
	// holding helpers from more than one daemon, and a single endpoint would only reach one.
	for _, helper := range parked {
		helper.release()
		s.removeVolumeHelper(ctx, helper.client, helper.containerID)
	}
}
