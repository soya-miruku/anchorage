package core

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// volumeCloneEngine is a Docker Engine that answers exactly the calls a clone or an empty
// makes, and records what it was asked to do. Staged rather than live: the operations create
// and destroy volumes, and a test that needed a daemon would be a test of this machine.
type volumeCloneEngine struct {
	mu sync.Mutex
	// volumes is the daemon's state: what exists, and what declaration it exists from.
	volumes map[string]map[string]any
	// archive is what the source helper's mount returns.
	archive []byte
	// uploaded is the archive the target helper received.
	uploaded []byte
	created  []map[string]any
	deleted  []string
	binds    []string
	running  int
	nextID   int
	// refuseUpload makes the target helper reject the write, standing in for any failure
	// partway through a copy.
	refuseUpload bool
}

func (engine *volumeCloneEngine) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path
		switch {
		case path == "/version":
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
		case path == "/v1.55/images/json":
			_, _ = writer.Write([]byte(`[{"Id":"sha256:helper","RepoTags":["scratch:latest"],"Size":10}]`))
		case path == "/v1.55/containers/json":
			filters := request.URL.Query().Get("filters")
			if strings.Contains(filters, volumeHelperLabel) {
				// The leak sweep: nothing left behind in these tests.
				_, _ = writer.Write([]byte(`[]`))
				return
			}
			body := "[]"
			if engine.running > 0 {
				body = `[{"State":"running"}]`
			}
			_, _ = writer.Write([]byte(body))
		case strings.HasPrefix(path, "/v1.55/volumes/") && request.Method == http.MethodGet:
			name := strings.TrimPrefix(path, "/v1.55/volumes/")
			declaration, exists := engine.volumes[name]
			if !exists {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"message":"no such volume"}`))
				return
			}
			_ = json.NewEncoder(writer).Encode(declaration)
		case path == "/v1.55/volumes/create":
			var payload map[string]any
			_ = json.NewDecoder(request.Body).Decode(&payload)
			engine.created = append(engine.created, payload)
			name, _ := payload["Name"].(string)
			engine.volumes[name] = map[string]any{
				"Name": name, "Driver": payload["Driver"], "Mountpoint": "/var/lib/docker/volumes/" + name,
				"Labels": payload["Labels"], "Options": payload["DriverOpts"], "Scope": "local",
			}
			writer.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(writer).Encode(engine.volumes[name])
		case strings.HasPrefix(path, "/v1.55/volumes/") && request.Method == http.MethodDelete:
			name := strings.TrimPrefix(path, "/v1.55/volumes/")
			engine.deleted = append(engine.deleted, name)
			delete(engine.volumes, name)
			writer.WriteHeader(http.StatusNoContent)
		case path == "/v1.55/containers/create":
			var payload struct {
				HostConfig struct {
					Binds []string `json:"Binds"`
				} `json:"HostConfig"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			engine.binds = append(engine.binds, payload.HostConfig.Binds...)
			engine.nextID++
			_, _ = writer.Write([]byte(`{"Id":"helper-` +
				string(rune('0'+engine.nextID)) + `","Warnings":[]}`))
		case strings.HasSuffix(path, "/archive") && request.Method == http.MethodGet:
			writer.Header().Set("Content-Type", "application/x-tar")
			_, _ = writer.Write(engine.archive)
		case strings.HasSuffix(path, "/archive") && request.Method == http.MethodPut:
			uploaded, _ := io.ReadAll(request.Body)
			engine.uploaded = uploaded
			if engine.refuseUpload {
				writer.WriteHeader(http.StatusInternalServerError)
				_, _ = writer.Write([]byte(`{"message":"no space left on device"}`))
				return
			}
			writer.WriteHeader(http.StatusOK)
		case strings.HasPrefix(path, "/v1.55/containers/") && request.Method == http.MethodDelete:
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"message":"not found"}`))
		}
	})
}

func newVolumeCloneService(t *testing.T, engine *volumeCloneEngine) *Service {
	t.Helper()
	socketPath, closeServer := startCustomDomainEngine(t, engine.handler())
	t.Cleanup(closeServer)
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	t.Cleanup(service.closeEngineClients)
	return service
}

// volumeArchive builds what Docker returns for the helper's mount point: entries rooted at the
// mount, which is the prefix a clone has to strip for the target to receive the volume itself.
func volumeArchive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	buffer := &bytes.Buffer{}
	writer := tar.NewWriter(buffer)
	prefix := strings.TrimPrefix(volumeHelperMount, "/")
	if err := writer.WriteHeader(&tar.Header{
		Name: prefix + "/", Typeflag: tar.TypeDir, Mode: 0o755,
	}); err != nil {
		t.Fatalf("write archive header: %v", err)
	}
	for name, content := range files {
		if err := writer.WriteHeader(&tar.Header{
			Name: prefix + "/" + name, Typeflag: tar.TypeReg,
			Mode: 0o644, Size: int64(len(content)),
		}); err != nil {
			t.Fatalf("write archive header: %v", err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatalf("write archive body: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
	return buffer.Bytes()
}

func TestVolumeCloneCopiesContentsIntoANewVolume(t *testing.T) {
	engine := &volumeCloneEngine{
		volumes: map[string]map[string]any{
			"project_data": {"Name": "project_data", "Driver": "local",
				"Labels": map[string]string{"com.docker.compose.project": "storefront"}},
		},
		archive: volumeArchive(t, map[string]string{"app.conf": "listen = 8080"}),
	}
	service := newVolumeCloneService(t, engine)

	result, err := service.volumeClone(context.Background(), VolumeCloneParams{
		Context: "default", Name: "project_data", Target: "project_data_copy",
	})
	if err != nil {
		t.Fatalf("volume clone: %v", err)
	}
	if result.Entries != 1 || result.SizeBytes != int64(len("listen = 8080")) {
		t.Fatalf("clone reported the wrong copy: %+v", result)
	}

	if len(engine.created) != 1 {
		t.Fatalf("expected exactly one volume to be created: %+v", engine.created)
	}
	created := engine.created[0]
	if created["Name"] != "project_data_copy" || created["Driver"] != "local" {
		t.Fatalf("the clone was not created from the source's driver: %+v", created)
	}
	labels, _ := created["Labels"].(map[string]any)
	if _, inherited := labels["com.docker.compose.project"]; inherited {
		// A Compose project label would enlist the clone in that project, and `down --volumes`
		// would then destroy the copy the operator took to keep.
		t.Fatalf("the source's own labels must not be copied: %+v", labels)
	}
	if labels[volumeCloneLabel] != "project_data" {
		t.Fatalf("the clone must record where it came from: %+v", labels)
	}

	// One helper per end, the source read-only and the target writable.
	if len(engine.binds) != 2 ||
		engine.binds[0] != "project_data:"+volumeHelperMount+":ro" ||
		engine.binds[1] != "project_data_copy:"+volumeHelperMount+":rw" {
		t.Fatalf("helper mounts wrong: %+v", engine.binds)
	}

	// What the target received is the volume's own contents, not a tree under the helper's
	// mount point: the prefix is stripped as the stream is rewritten.
	reader := tar.NewReader(bytes.NewReader(engine.uploaded))
	names := []string{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("read uploaded archive: %v", err)
		}
		names = append(names, header.Name)
	}
	if len(names) != 1 || names[0] != "app.conf" {
		t.Fatalf("uploaded archive is not rooted at the volume's contents: %+v", names)
	}
}

func TestVolumeCloneNeverWritesIntoAVolumeThatExists(t *testing.T) {
	engine := &volumeCloneEngine{
		volumes: map[string]map[string]any{
			"project_data": {"Name": "project_data", "Driver": "local"},
			"already_here": {"Name": "already_here", "Driver": "local"},
		},
		archive: volumeArchive(t, map[string]string{"app.conf": "x"}),
	}
	service := newVolumeCloneService(t, engine)

	// Docker's volume create answers 201 for a volume that already exists, so without the
	// check a clone would silently become a restore over data nobody named.
	_, err := service.volumeClone(context.Background(), VolumeCloneParams{
		Context: "default", Name: "project_data", Target: "already_here",
	})
	if got := AsOpError(err).Code; got != "volume_exists" {
		t.Fatalf("expected volume_exists, got %q (%v)", got, err)
	}
	if len(engine.created) != 0 || engine.uploaded != nil {
		t.Fatalf("nothing may be written when the target is taken: %+v", engine.created)
	}

	_, err = service.volumeClone(context.Background(), VolumeCloneParams{
		Context: "default", Name: "project_data", Target: "project_data",
	})
	if got := AsOpError(err).Code; got != "invalid_volume_target" {
		t.Fatalf("expected a self-clone to be rejected, got %q (%v)", got, err)
	}
	_, err = service.volumeClone(context.Background(), VolumeCloneParams{
		Context: "default", Name: "absent", Target: "project_data_copy",
	})
	if got := AsOpError(err).Code; got != "volume_not_found" {
		t.Fatalf("expected volume_not_found, got %q (%v)", got, err)
	}
	for _, name := range []string{"", "-rf", "../escape"} {
		if _, err := service.volumeClone(context.Background(), VolumeCloneParams{
			Context: "default", Name: "project_data", Target: name,
		}); AsOpError(err).Code != "invalid_volume_name" {
			t.Fatalf("target %q must be rejected as a name: %v", name, err)
		}
	}
}

func TestVolumeCloneReportsDriverOptionsItDidNotCopy(t *testing.T) {
	// Reusing a local volume's options would point the "clone" at the same bind or export as
	// the source, so the target is created bare and the difference is reported.
	engine := &volumeCloneEngine{
		volumes: map[string]map[string]any{
			"bound_data": {"Name": "bound_data", "Driver": "local",
				"Options": map[string]string{"type": "none", "device": "/srv/data", "o": "bind"}},
		},
		archive: volumeArchive(t, map[string]string{"app.conf": "x"}),
	}
	service := newVolumeCloneService(t, engine)

	result, err := service.volumeClone(context.Background(), VolumeCloneParams{
		Context: "default", Name: "bound_data", Target: "bound_data_copy",
	})
	if err != nil {
		t.Fatalf("volume clone: %v", err)
	}
	if len(result.Limitations) != 1 || !strings.Contains(result.Limitations[0], "driver options") {
		t.Fatalf("the uncopied options must be reported: %+v", result.Limitations)
	}
	if options := engine.created[0]["DriverOpts"]; options != nil {
		t.Fatalf("driver options must not be reused: %+v", options)
	}
}

func TestVolumeCloneDiscardsAPartlyWrittenTarget(t *testing.T) {
	engine := &volumeCloneEngine{
		volumes: map[string]map[string]any{
			"project_data": {"Name": "project_data", "Driver": "local"},
		},
		archive:      volumeArchive(t, map[string]string{"app.conf": "x"}),
		refuseUpload: true,
	}
	service := newVolumeCloneService(t, engine)

	_, err := service.volumeClone(context.Background(), VolumeCloneParams{
		Context: "default", Name: "project_data", Target: "project_data_copy",
	})
	if err == nil {
		t.Fatal("a rejected write must fail the clone")
	}
	// A volume holding half of another one, sitting in the list as though it were a copy, is
	// worse than no volume at all — and it did not exist before this call.
	if len(engine.deleted) != 1 || engine.deleted[0] != "project_data_copy" {
		t.Fatalf("the partly written target must be discarded: %+v", engine.deleted)
	}
	if _, survived := engine.volumes["project_data_copy"]; survived {
		t.Fatal("the target volume outlived the failed clone")
	}
}

func TestVolumeEmptyIsConfirmedAndRebuildsTheSameDeclaration(t *testing.T) {
	declaration := map[string]any{
		"Name": "project_data", "Driver": "local", "Scope": "local",
		"Labels":  map[string]string{"com.docker.compose.project": "storefront"},
		"Options": map[string]string{"type": "tmpfs"},
	}
	engine := &volumeCloneEngine{
		volumes: map[string]map[string]any{"project_data": declaration},
	}
	service := newVolumeCloneService(t, engine)

	// Emptying discards every byte and nothing restores it, so it is confirmed like every
	// other destructive volume verb.
	_, err := service.volumeEmpty(context.Background(), VolumeEmptyParams{
		Context: "default", Name: "project_data",
	})
	if got := AsOpError(err).Code; got != "confirmation_required" {
		t.Fatalf("expected confirmation_required, got %q (%v)", got, err)
	}
	if len(engine.deleted) != 0 {
		t.Fatalf("an unconfirmed empty must not touch the volume: %+v", engine.deleted)
	}

	result, err := service.volumeEmpty(context.Background(), VolumeEmptyParams{
		Context: "default", Name: "project_data", Confirmed: true,
	})
	if err != nil {
		t.Fatalf("volume empty: %v", err)
	}
	if len(engine.deleted) != 1 || engine.deleted[0] != "project_data" {
		t.Fatalf("the volume was not removed exactly once: %+v", engine.deleted)
	}
	if len(engine.created) != 1 {
		t.Fatalf("the volume was not recreated: %+v", engine.created)
	}
	// Same declaration, or a Compose project would no longer own its own volume.
	recreated := engine.created[0]
	if recreated["Name"] != "project_data" || recreated["Driver"] != "local" {
		t.Fatalf("identity changed: %+v", recreated)
	}
	labels, _ := recreated["Labels"].(map[string]any)
	if labels["com.docker.compose.project"] != "storefront" {
		t.Fatalf("labels must survive an empty: %+v", labels)
	}
	options, _ := recreated["DriverOpts"].(map[string]any)
	if options["type"] != "tmpfs" {
		t.Fatalf("driver options must survive an empty: %+v", options)
	}
	if result.Recreated == nil || result.Recreated.Name != "project_data" {
		t.Fatalf("the recreated volume must be reported: %+v", result)
	}
	if len(result.Limitations) != 1 || !strings.Contains(result.Limitations[0], "in place") {
		t.Fatalf("the mechanism must be stated: %+v", result.Limitations)
	}
}

func TestVolumeEmptyRefusesAVolumeAContainerIsUsing(t *testing.T) {
	engine := &volumeCloneEngine{
		volumes: map[string]map[string]any{
			"project_data": {"Name": "project_data", "Driver": "local"},
		},
		running: 1,
	}
	service := newVolumeCloneService(t, engine)

	// The count comes from the daemon, not from a caller-supplied flag — and unlike a write it
	// cannot be acknowledged, because Docker will not release a volume that is in use.
	_, err := service.volumeEmpty(context.Background(), VolumeEmptyParams{
		Context: "default", Name: "project_data", Confirmed: true,
	})
	typed := AsOpError(err)
	if typed.Code != "volume_in_use" {
		t.Fatalf("expected volume_in_use, got %q (%v)", typed.Code, err)
	}
	if typed.Details["containers"] != 1 {
		t.Fatalf("the refusal must say how many containers hold it: %+v", typed.Details)
	}
	if len(engine.deleted) != 0 {
		t.Fatalf("a volume in use must not be removed: %+v", engine.deleted)
	}
}

func TestVolumeHelperSweepSparesAHelperThisProcessOwns(t *testing.T) {
	// The sweep finds helpers by label, which matches live ones too. A clone runs two helpers
	// at once and two volume reads may overlap, so a live helper must survive the sweep the
	// next one performs — otherwise the container being streamed from is force-removed.
	var removed []string
	var lock sync.Mutex
	socketPath, closeServer := startCustomDomainEngine(t, http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			switch {
			case request.URL.Path == "/version":
				_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
			case request.URL.Path == "/v1.55/containers/json":
				_, _ = writer.Write([]byte(`[{"Id":"live-helper"},{"Id":"leaked-helper"}]`))
			case request.Method == http.MethodDelete:
				lock.Lock()
				removed = append(removed, strings.TrimPrefix(request.URL.Path, "/v1.55/containers/"))
				lock.Unlock()
				writer.WriteHeader(http.StatusNoContent)
			default:
				writer.WriteHeader(http.StatusNotFound)
			}
		}))
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	defer service.closeEngineClients()

	client, _, err := service.containerArchiveClient(context.Background(), "default", "volumes.files")
	if err != nil {
		t.Fatalf("engine client: %v", err)
	}
	release := service.holdVolumeHelper("live-helper")
	service.sweepVolumeHelpers(context.Background(), client)
	if len(removed) != 1 || removed[0] != "leaked-helper" {
		t.Fatalf("the sweep must remove only the leaked helper: %+v", removed)
	}

	// Once released the same helper is ordinary garbage again.
	release()
	service.sweepVolumeHelpers(context.Background(), client)
	if len(removed) != 3 {
		t.Fatalf("a released helper must be swept: %+v", removed)
	}
}
