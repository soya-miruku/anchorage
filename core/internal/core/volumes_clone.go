package core

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// volumeCloneLabel records where a clone came from. The source's own labels are deliberately
// not copied: a Compose project label would enlist the clone in that project, and `compose
// down --volumes` would then destroy a copy the operator took to keep.
const volumeCloneLabel = "io.anchorage.cloned-from"

// volumeClone copies one volume's contents into a new one.
//
// Docker has no clone verb, so this is a backup and a restore that never touch the disk: the
// source is read through a never-started helper and the stream is rewritten into a second
// helper mounted on the target. Rewriting is what makes the two ends independent — the archive
// Docker returns is rooted at the source helper's mount point, and the target expects the
// volume's own contents.
func (s *Service) volumeClone(parent context.Context, params VolumeCloneParams) (VolumeCloneResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumeCloneResult{}, err
	}
	if err := validateVolumeName(params.Name); err != nil {
		return VolumeCloneResult{}, err
	}
	if err := validateVolumeName(params.Target); err != nil {
		return VolumeCloneResult{}, err
	}
	if params.Name == params.Target {
		return VolumeCloneResult{}, opError("invalid_volume_target",
			"A volume cannot be cloned onto itself.", nil, map[string]any{"volume": params.Name})
	}

	release, err := acquireSlot(parent, s.volumeSlots, "volume_browse_busy",
		"Too many volume reads are already in flight.")
	if err != nil {
		return VolumeCloneResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, volumeBackupTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "volumes.clone")
	if err != nil {
		return VolumeCloneResult{}, err
	}
	source, err := s.inspectVolume(ctx, client, params.Name, "volume_clone_failed")
	if err != nil {
		return VolumeCloneResult{}, err
	}
	limitations := []string{}
	if len(source.Options) > 0 {
		// A local volume's options can name the storage it is backed by — a bind, an NFS
		// export. Reusing them would point the "clone" at the same bytes as the source, so the
		// target is created on the bare driver and the difference is reported rather than hidden.
		limitations = append(limitations,
			"The source's driver options were not copied; a clone that reused them could resolve to the same underlying storage.")
	}
	if err := s.createCloneTarget(ctx, client, params, source.Driver); err != nil {
		return VolumeCloneResult{}, err
	}

	var entries int
	var written int64
	if err := s.withVolumeHelper(ctx, client, params.Name, false, func(sourceID string) error {
		values := url.Values{}
		values.Set("path", volumeHelperMount)
		body, status, streamErr := client.stream(ctx, http.MethodGet,
			"/v"+client.apiVersion+"/containers/"+url.PathEscape(sourceID)+"/archive?"+values.Encode())
		if streamErr != nil {
			return streamErr
		}
		defer body.Close()
		if status < 200 || status >= 300 {
			payload, _ := io.ReadAll(io.LimitReader(body, 8*1024))
			return engineHTTPError("volume_clone_failed",
				"Docker Engine rejected the volume read.", status, payload)
		}
		return s.withVolumeHelper(ctx, client, params.Target, true, func(targetID string) error {
			// The archive is rewritten as it is uploaded rather than spooled: a volume larger
			// than memory, or than the host's temporary space, still clones.
			reader, writer := io.Pipe()
			rewritten := make(chan error, 1)
			go func() {
				count, bytesWritten, rewriteErr := rewriteVolumeArchive(body, writer)
				entries, written = count, bytesWritten
				// Closing with the error fails the upload rather than uploading a truncated
				// archive that the target would accept as a complete copy.
				_ = writer.CloseWithError(rewriteErr)
				rewritten <- rewriteErr
			}()
			uploadValues := url.Values{}
			uploadValues.Set("path", volumeHelperMount)
			status, response, requestErr := client.request(ctx, http.MethodPut,
				"/v"+client.apiVersion+"/containers/"+url.PathEscape(targetID)+
					"/archive?"+uploadValues.Encode(), reader)
			_ = reader.Close()
			rewriteErr := <-rewritten
			// The transport's own failure is reported ahead of the rewrite's, because closing
			// the pipe is how a failed upload stops the copy: the rewrite error would then be a
			// symptom describing the wrong cause.
			if requestErr != nil {
				return requestErr
			}
			if status < 200 || status >= 300 {
				return engineHTTPError("volume_clone_failed",
					"Docker Engine rejected the volume write.", status, response)
			}
			if rewriteErr != nil {
				// The upload succeeded on an archive that was never finished, which is the one
				// case where the target would otherwise look like a complete copy.
				return opError("volume_clone_failed",
					"The volume contents could not be copied.", rewriteErr, nil)
			}
			return nil
		})
	}); err != nil {
		// A partly written volume must not survive looking like a finished clone. The target
		// did not exist before this call, so discarding it destroys nothing the operator had.
		return VolumeCloneResult{}, s.discardCloneTarget(ctx, client, params.Target, err)
	}
	return VolumeCloneResult{
		Context: contextName, Volume: params.Name, Target: params.Target,
		Entries: entries, SizeBytes: written, ObservedAt: nowUTC(), Limitations: limitations,
	}, nil
}

// createCloneTarget refuses a target that already exists, then creates it.
//
// Docker's volume create is idempotent — it answers 201 with the existing volume — so asking
// it to create the target would silently turn a clone into a restore over whatever that volume
// already held. The existence check is what makes the refusal possible at all.
func (s *Service) createCloneTarget(ctx context.Context, client *engineClient,
	params VolumeCloneParams, driver string) error {
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/volumes/"+url.PathEscape(params.Target), nil)
	if err != nil {
		return err
	}
	if status >= 200 && status < 300 {
		return opError("volume_exists",
			"That volume already exists; cloning never writes into a volume that is already there.",
			nil, map[string]any{"volume": params.Target})
	}
	if status != http.StatusNotFound {
		return engineHTTPError("volume_clone_failed",
			"Docker Engine could not confirm the target volume is free.", status, body)
	}
	payload, err := json.Marshal(map[string]any{
		"Name": params.Target, "Driver": driver,
		"Labels": map[string]string{volumeCloneLabel: params.Name},
	})
	if err != nil {
		return opError("volume_clone_failed", "The volume creation request could not be built.", err, nil)
	}
	status, body, err = client.request(ctx, http.MethodPost,
		"/v"+client.apiVersion+"/volumes/create", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return engineHTTPError("volume_clone_failed",
			"Docker Engine rejected the target volume.", status, body)
	}
	return nil
}

// discardCloneTarget removes the volume a failed clone created, and reports the original
// failure. Removal runs on a context detached from the caller's, because a clone that failed
// by timing out would otherwise be unable to clean up after itself.
func (s *Service) discardCloneTarget(ctx context.Context, client *engineClient,
	target string, cause error) error {
	removeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), domainReadTimeout)
	defer cancel()
	values := url.Values{}
	values.Set("force", "true")
	status, _, err := client.request(removeCtx, http.MethodDelete,
		"/v"+client.apiVersion+"/volumes/"+url.PathEscape(target)+"?"+values.Encode(), nil)
	if err == nil && (status >= 200 && status < 300 || status == http.StatusNotFound) {
		return cause
	}
	// Worth its own code: the operator now has a volume holding part of another one, and
	// nothing else on screen would say so.
	return opError("volume_clone_incomplete",
		"The clone failed and the partly written target volume could not be removed.", cause,
		map[string]any{"volume": target})
}

// volumeEmpty discards a volume's contents while keeping the volume.
//
// Docker's archive endpoint writes files but cannot delete them, and the helper is never
// started, so there is nothing to run an `rm` with. Emptying is therefore a removal and a
// recreation of the same declaration: same name, driver, labels and options, so a Compose
// project still finds its volume and `down --volumes` still owns it.
func (s *Service) volumeEmpty(parent context.Context, params VolumeEmptyParams) (VolumeEmptyResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumeEmptyResult{}, err
	}
	if err := validateVolumeName(params.Name); err != nil {
		return VolumeEmptyResult{}, err
	}
	if !params.Confirmed {
		return VolumeEmptyResult{}, confirmationRequired("volume", params.Name, "empty")
	}

	release, err := acquireSlot(parent, s.volumeSlots, "volume_browse_busy",
		"Too many volume reads are already in flight.")
	if err != nil {
		return VolumeEmptyResult{}, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(parent, volumeBrowseTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "volumes.empty")
	if err != nil {
		return VolumeEmptyResult{}, err
	}
	declaration, err := s.inspectVolume(ctx, client, params.Name, "volume_empty_failed")
	if err != nil {
		return VolumeEmptyResult{}, err
	}
	// The count comes from the daemon rather than a caller-supplied flag, exactly as it does
	// for a write. It is not acknowledgeable here, though: Docker refuses to remove a volume a
	// container references at all, so there is no version of this that proceeds.
	inUse, err := s.volumeReferenceCount(ctx, client, params.Name)
	if err != nil {
		return VolumeEmptyResult{}, err
	}
	if inUse > 0 {
		return VolumeEmptyResult{}, opError("volume_in_use",
			"That volume is attached to a running container; stop the container before emptying it.",
			nil, map[string]any{"volume": params.Name, "containers": inUse})
	}
	// A helper of our own would hold a reference on the volume and make the removal fail; a
	// leaked one from an earlier request would do the same, with nothing on screen to explain
	// it. Sweeping first is cheap and turns that into a clean run.
	s.sweepVolumeHelpers(ctx, client)

	values := url.Values{}
	values.Set("force", "false")
	status, body, err := client.request(ctx, http.MethodDelete,
		"/v"+client.apiVersion+"/volumes/"+url.PathEscape(params.Name)+"?"+values.Encode(), nil)
	if err != nil {
		return VolumeEmptyResult{}, err
	}
	if status == http.StatusConflict {
		// A stopped container still holds a reference the running count above does not see.
		return VolumeEmptyResult{}, opError("volume_in_use",
			"Docker will not release that volume: a container still references it.",
			nil, map[string]any{"volume": params.Name, "status": status})
	}
	if status < 200 || status >= 300 {
		return VolumeEmptyResult{}, engineHTTPError("volume_empty_failed",
			"Docker Engine rejected the volume removal.", status, body)
	}

	recreated, err := s.recreateVolume(ctx, client, declaration)
	if err != nil {
		return VolumeEmptyResult{}, err
	}
	return VolumeEmptyResult{
		Context: contextName, Volume: params.Name, Recreated: recreated, ObservedAt: nowUTC(),
		Limitations: []string{
			"Docker cannot empty a volume in place, so this removed it and recreated it with the same name, driver, labels and options; its creation time and mount point are new.",
		},
	}, nil
}

// recreateVolume rebuilds the declaration an empty just removed. A failure here is reported
// as its own outcome: the data is gone either way, but a volume that no longer exists is a
// different problem from an empty one, and the operator needs to be told which they have.
func (s *Service) recreateVolume(ctx context.Context, client *engineClient,
	declaration engineVolume) (*VolumeProjection, error) {
	payload, err := json.Marshal(map[string]any{
		"Name": declaration.Name, "Driver": declaration.Driver,
		"DriverOpts": nonNilMap(declaration.Options), "Labels": nonNilMap(declaration.Labels),
	})
	if err != nil {
		return nil, opError("volume_empty_incomplete",
			"The volume was removed but the request to recreate it could not be built.", err,
			map[string]any{"volume": declaration.Name})
	}
	status, body, err := client.request(ctx, http.MethodPost,
		"/v"+client.apiVersion+"/volumes/create", bytes.NewReader(payload))
	if err != nil {
		return nil, opError("volume_empty_incomplete",
			"The volume was removed but Docker Engine could not be reached to recreate it.", err,
			map[string]any{"volume": declaration.Name, "driver": declaration.Driver,
				"labels": nonNilMap(declaration.Labels), "options": nonNilMap(declaration.Options)})
	}
	if status < 200 || status >= 300 {
		return nil, engineHTTPError("volume_empty_incomplete",
			"The volume was removed but Docker Engine rejected recreating it.", status, body)
	}
	var raw engineVolume
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, opError("volume_empty_invalid",
			"Docker Engine returned invalid volume creation JSON.", err, nil)
	}
	projected := projectVolume(raw)
	return &projected, nil
}

// inspectVolume reads a volume's declaration: what it is created from, rather than what it
// holds. Clone needs the driver, empty needs the whole declaration to put it back.
func (s *Service) inspectVolume(ctx context.Context, client *engineClient,
	volume, failureCode string) (engineVolume, error) {
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/volumes/"+url.PathEscape(volume), nil)
	if err != nil {
		return engineVolume{}, err
	}
	if status == http.StatusNotFound {
		return engineVolume{}, opError("volume_not_found", "That volume does not exist.", nil,
			map[string]any{"volume": volume})
	}
	if status < 200 || status >= 300 {
		return engineVolume{}, engineHTTPError(failureCode,
			"Docker Engine could not describe the volume.", status, body)
	}
	var declaration engineVolume
	if err := json.Unmarshal(body, &declaration); err != nil {
		return engineVolume{}, opError(failureCode,
			"Docker Engine returned invalid volume JSON.", err, nil)
	}
	return declaration, nil
}
