package core

import (
	"archive/tar"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const fullImageID = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const untaggedImageID = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
const intermediateImageID = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

type recordedDomainRequest struct {
	Method string
	URI    string
	Body   string
}

func TestSystemSnapshotUsesExactEngineInfoAndDiskJSON(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()

	result, err := service.systemSnapshot(context.Background(), SystemSnapshotParams{
		Context: "default", IncludeDiskUsage: true,
	})
	if err != nil {
		t.Fatalf("system snapshot: %v", err)
	}
	if result.Source != "engine-api" || result.APIVersion != "1.55" || result.EndpointHash == "" {
		t.Fatalf("unexpected snapshot metadata: %#v", result)
	}
	if result.Engine.Name != "fixture-engine" || result.Engine.CPUs != 8 || result.Engine.MemoryBytes != 16_000_000_000 {
		t.Fatalf("unexpected engine projection: %#v", result.Engine)
	}
	if result.DiskUsage.LayersSizeBytes != 600 || len(result.DiskUsage.Images) != 1 ||
		len(result.DiskUsage.Containers) != 1 || len(result.DiskUsage.Volumes) != 1 ||
		len(result.DiskUsage.BuildCache) != 1 {
		t.Fatalf("unexpected disk projection: %#v", result.DiskUsage)
	}
	assertDomainRequestCount(t, requests, http.MethodGet, "/v1.55/info", 1)
	assertDomainRequestCount(t, requests, http.MethodGet, "/v1.55/system/df", 1)
}

func TestContainerInspectAndOneShotStatsUseImmutableID(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()

	inspect, err := service.containerInspect(context.Background(), ContainerInspectParams{
		Context: "default", ID: fullContainerID,
	})
	if err != nil {
		t.Fatalf("container inspect: %v", err)
	}
	if inspect.Container.ID != fullContainerID || inspect.Container.Name != "web" ||
		inspect.Container.State.Health != "healthy" || inspect.Container.Ports["80/tcp"][0].HostPort != "8080" {
		t.Fatalf("unexpected inspect projection: %#v", inspect.Container)
	}
	var document map[string]any
	if err := json.Unmarshal(inspect.Document, &document); err != nil || document["Id"] != fullContainerID {
		t.Fatalf("inspect document was not preserved: %v %#v", err, document)
	}

	stats, err := service.containerStats(context.Background(), ContainerStatsParams{
		Context: "default", ID: fullContainerID,
	})
	if err != nil {
		t.Fatalf("container stats: %v", err)
	}
	if stats.CPUPercent != 200 || stats.MemoryUsageBytes != 1000 || stats.MemoryWorkingSet != 900 ||
		stats.MemoryPercent != 45 || stats.NetworkRXBytes != 13 || stats.NetworkTXBytes != 24 ||
		stats.BlockReadBytes != 30 || stats.BlockWriteBytes != 40 || stats.PIDs != 7 {
		t.Fatalf("unexpected stats projection: %#v", stats)
	}
	statsURI := "/v1.55/containers/" + fullContainerID + "/stats?stream=false"
	assertDomainRequestCount(t, requests, http.MethodGet, statsURI, 1)

	_, err = service.containerStats(context.Background(), ContainerStatsParams{Context: "default", ID: "short"})
	if got := AsOpError(err).Code; got != "invalid_container_id" {
		t.Fatalf("expected immutable ID rejection, got %q", got)
	}
}

func TestImagesListRemoveAndPruneAreStructuredSingleSubmitMutations(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()

	list, err := service.imagesList(context.Background(), ImagesListParams{Context: "default"})
	if err != nil {
		t.Fatalf("images list: %v", err)
	}
	if len(list.Images) != 1 || list.Images[0].ID != fullImageID ||
		list.Images[0].SizeBytes != 500 || list.Images[0].Containers != 1 {
		t.Fatalf("unexpected images: %#v", list.Images)
	}

	_, err = service.imagesAction(context.Background(), ImagesActionParams{
		Context: "default", Action: "remove", ID: fullImageID, Reference: "fixture:latest",
	}, nil)
	if got := AsOpError(err).Code; got != "confirmation_required" {
		t.Fatalf("expected destructive confirmation, got %q", got)
	}

	var events []string
	removed, err := service.imagesAction(context.Background(), ImagesActionParams{
		Context: "default", Action: "remove", ID: fullImageID,
		Reference: "fixture:latest", Confirmed: true,
	}, func(event string, _ any) { events = append(events, event) })
	if err != nil {
		t.Fatalf("image remove: %v", err)
	}
	if removed.Receipt.Outcome != "succeeded" || len(removed.Deleted) != 1 ||
		removed.Deleted[0].Untagged != "fixture:latest" {
		t.Fatalf("unexpected image removal: %#v", removed)
	}
	if !containsString(events, "reconciliation.requested") {
		t.Fatalf("successful mutation did not request reconciliation: %#v", events)
	}
	assertDomainRequestCount(t, requests, http.MethodGet, "/v1.55/images/fixture:latest/json", 1)
	removeURI := "/v1.55/images/fixture:latest?force=false&noprune=false"
	assertDomainRequestCount(t, requests, http.MethodDelete, removeURI, 1)

	pruned, err := service.imagesAction(context.Background(), ImagesActionParams{
		Context: "default", Action: "prune", Confirmed: true,
		Filters: map[string][]string{"dangling": {"true"}},
	}, nil)
	if err != nil {
		t.Fatalf("image prune: %v", err)
	}
	if pruned.Prune == nil || pruned.Prune.SpaceReclaimed != 1234 ||
		len(pruned.Prune.ImagesDeleted) != 1 {
		t.Fatalf("unexpected image prune: %#v", pruned)
	}
	assertDomainPathCount(t, requests, http.MethodPost, "/v1.55/images/prune", 1)
}

func TestImagesListMatchesDockerDefaultAndAllViews(t *testing.T) {
	socketPath, closeServer := startCustomDomainEngine(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/version":
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
		case "/v1.55/images/json":
			if strings.Contains(request.URL.Query().Get("filters"), `"dangling":["true"]`) {
				_, _ = writer.Write([]byte(`[
					{"Id":"` + untaggedImageID + `","RepoTags":[],"RepoDigests":[]}
				]`))
			} else {
				_, _ = writer.Write([]byte(`[
					{"Id":"` + fullImageID + `","RepoTags":["fixture:latest"],"RepoDigests":[]},
					{"Id":"` + untaggedImageID + `","RepoTags":[],"RepoDigests":[]},
					{"Id":"` + intermediateImageID + `","RepoTags":[],"RepoDigests":[]}
				]`))
			}
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	all := false
	defaultView, err := service.imagesList(context.Background(), ImagesListParams{
		Context:         "default",
		All:             &all,
		IncludeDangling: true,
	})
	if err != nil {
		t.Fatalf("default images list: %v", err)
	}
	if len(defaultView.Images) != 2 ||
		defaultView.Images[0].ID != fullImageID ||
		defaultView.Images[1].ID != untaggedImageID {
		t.Fatalf("default view must retain tagged images and dangling leaves, but hide intermediates: %#v", defaultView.Images)
	}

	cliDefaultView, err := service.imagesList(context.Background(), ImagesListParams{
		Context: "default",
		All:     &all,
	})
	if err != nil {
		t.Fatalf("CLI-default images list: %v", err)
	}
	if len(cliDefaultView.Images) != 1 || cliDefaultView.Images[0].ID != fullImageID {
		t.Fatalf("all=false without includeDangling must retain Docker CLI default semantics: %#v", cliDefaultView.Images)
	}

	all = true
	allView, err := service.imagesList(context.Background(), ImagesListParams{
		Context: "default",
		All:     &all,
	})
	if err != nil {
		t.Fatalf("all images list: %v", err)
	}
	if len(allView.Images) != 3 ||
		allView.Images[0].ID != fullImageID ||
		allView.Images[1].ID != untaggedImageID ||
		allView.Images[2].ID != intermediateImageID {
		t.Fatalf("all view must preserve tagged, dangling, and intermediate full image IDs: %#v", allView.Images)
	}
}

func TestSubmittedImageMutationTimeoutIsUnknownAndNeverRetried(t *testing.T) {
	var lock sync.Mutex
	submissions := 0
	socketPath, closeServer := startCustomDomainEngine(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/version" {
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
			return
		}
		if request.Method == http.MethodGet && request.URL.Path == "/v1.55/images/fixture:latest/json" {
			_, _ = writer.Write([]byte(`{"Id":"` + fullImageID + `"}`))
			return
		}
		if request.Method == http.MethodDelete && request.URL.Path == "/v1.55/images/fixture:latest" {
			lock.Lock()
			submissions++
			lock.Unlock()
			<-request.Context().Done()
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer closeServer()
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	var events []string

	_, err := service.imagesAction(ctx, ImagesActionParams{
		Context: "default", Action: "remove", ID: fullImageID,
		Reference: "fixture:latest", Confirmed: true,
	}, func(event string, _ any) { events = append(events, event) })
	typed := AsOpError(err)
	if typed.Code != "mutation_outcome_unknown" {
		t.Fatalf("expected unknown mutation outcome, got %q (%v)", typed.Code, err)
	}
	receipt, ok := typed.Details["receipt"].(DomainOperationReceipt)
	if !ok || receipt.Outcome != "unknown" {
		t.Fatalf("unknown receipt missing from error: %#v", typed.Details)
	}
	lock.Lock()
	count := submissions
	lock.Unlock()
	if count != 1 {
		t.Fatalf("mutation was submitted %d times, want exactly once", count)
	}
	if !containsString(events, "reconciliation.required") {
		t.Fatalf("unknown mutation did not require reconciliation: %#v", events)
	}
}

func TestImageRemoveRejectsAReferenceThatReboundToAnotherImmutableID(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()

	_, err := service.imagesAction(context.Background(), ImagesActionParams{
		Context:   "default",
		Action:    "remove",
		ID:        untaggedImageID,
		Reference: "fixture:latest",
		Confirmed: true,
	}, nil)
	if got := AsOpError(err).Code; got != "image_reference_changed" {
		t.Fatalf("expected stale reference rejection, got %q (%v)", got, err)
	}
	assertDomainRequestCount(t, requests, http.MethodGet, "/v1.55/images/fixture:latest/json", 1)
	assertDomainRequestCount(t, requests, http.MethodDelete, "/v1.55/images/fixture:latest?force=false&noprune=false", 0)
}

func TestPruneBooleanFiltersAreStrict(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()

	_, err := service.imagesAction(context.Background(), ImagesActionParams{
		Context: "default", Action: "prune", Confirmed: true,
		Filters: map[string][]string{"dangling": {"yes"}},
	}, nil)
	if got := AsOpError(err).Code; got != "invalid_filters" {
		t.Fatalf("expected invalid image boolean filter, got %q (%v)", got, err)
	}

	_, err = service.volumesAction(context.Background(), VolumesActionParams{
		Context: "default", Action: "prune", Confirmed: true,
		Filters: map[string][]string{"all": {"true", "false"}},
	}, nil)
	if got := AsOpError(err).Code; got != "invalid_filters" {
		t.Fatalf("expected invalid volume boolean filter, got %q (%v)", got, err)
	}
}

func TestImagePullIsSessionBackedContextPinnedAndCancellable(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	type exitObservation struct {
		event  SessionExitedEvent
		events []string
	}
	var lock sync.Mutex
	events := []string{}
	exited := make(chan exitObservation, 1)

	result, err := service.imagesAction(context.Background(), ImagesActionParams{
		Context: "default", Action: "pull", Reference: "alpine:3.20",
	}, func(event string, payload any) {
		lock.Lock()
		events = append(events, event)
		var eventsAtExit []string
		if event == "session.exited" {
			eventsAtExit = append([]string(nil), events...)
		}
		lock.Unlock()
		if event == "session.exited" {
			exited <- exitObservation{
				event:  payload.(SessionExitedEvent),
				events: eventsAtExit,
			}
		}
	})
	if err != nil {
		t.Fatalf("image pull start: %v", err)
	}
	if result.Session == nil || result.Receipt.Outcome != "running" ||
		result.Session.Argv[0] != "--context" || result.Session.Argv[1] != "default" {
		t.Fatalf("unexpected pull session: %#v", result)
	}
	select {
	case observation := <-exited:
		if observation.event.ExitCode != 0 {
			t.Fatalf("pull session failed: %#v", observation.event)
		}
		completedIndex := -1
		reconciliationIndex := -1
		for index, event := range observation.events {
			switch event {
			case "operation.completed":
				completedIndex = index
			case "reconciliation.requested":
				reconciliationIndex = index
			}
		}
		exitIndex := len(observation.events) - 1
		if completedIndex < 0 || reconciliationIndex < 0 ||
			completedIndex >= reconciliationIndex || reconciliationIndex >= exitIndex {
			t.Fatalf("pull terminal events were not published before session exit: %#v", observation.events)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for pull session")
	}
}

func TestVolumesListCreateRemoveAndPruneAreStructuredSingleSubmitMutations(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()

	list, err := service.volumesList(context.Background(), VolumesListParams{Context: "default"})
	if err != nil {
		t.Fatalf("volumes list: %v", err)
	}
	if len(list.Volumes) != 1 || list.Volumes[0].Name != "fixture-data" ||
		list.Volumes[0].Usage == nil || list.Volumes[0].Usage.SizeBytes != 321 ||
		list.Volumes[0].Usage.RefCount != 1 {
		t.Fatalf("unexpected volumes: %#v", list.Volumes)
	}
	assertDomainRequestCount(t, requests, http.MethodGet, "/v1.55/system/df?type=volume", 1)

	created, err := service.volumesAction(context.Background(), VolumesActionParams{
		Context: "default", Action: "create", Name: "new-data", Driver: "local",
		Labels: map[string]string{"app": "anchorage"},
	}, nil)
	if err != nil {
		t.Fatalf("volume create: %v", err)
	}
	if created.Volume == nil || created.Volume.Name != "new-data" || created.Receipt.Outcome != "succeeded" {
		t.Fatalf("unexpected create result: %#v", created)
	}
	assertDomainRequestCount(t, requests, http.MethodPost, "/v1.55/volumes/create", 1)
	create := findDomainRequest(requests, http.MethodPost, "/v1.55/volumes/create")
	if !strings.Contains(create.Body, `"Name":"new-data"`) || !strings.Contains(create.Body, `"app":"anchorage"`) {
		t.Fatalf("volume create body missing typed fields: %s", create.Body)
	}

	_, err = service.volumesAction(context.Background(), VolumesActionParams{
		Context: "default", Action: "remove", Name: "fixture-data",
	}, nil)
	if got := AsOpError(err).Code; got != "confirmation_required" {
		t.Fatalf("expected volume confirmation, got %q", got)
	}
	removed, err := service.volumesAction(context.Background(), VolumesActionParams{
		Context: "default", Action: "remove", Name: "fixture-data", Confirmed: true,
	}, nil)
	if err != nil || removed.Receipt.Outcome != "succeeded" {
		t.Fatalf("volume remove: result=%#v err=%v", removed, err)
	}
	assertDomainRequestCount(t, requests, http.MethodDelete, "/v1.55/volumes/fixture-data?force=false", 1)

	pruned, err := service.volumesAction(context.Background(), VolumesActionParams{
		Context: "default", Action: "prune", Confirmed: true,
		Filters: map[string][]string{
			"all":   {"true"},
			"label": {"temporary=true"},
		},
	}, nil)
	if err != nil {
		t.Fatalf("volume prune: %v", err)
	}
	if pruned.Prune == nil || pruned.Prune.SpaceReclaimed != 987 ||
		len(pruned.Prune.VolumesDeleted) != 1 {
		t.Fatalf("unexpected prune result: %#v", pruned)
	}
	assertDomainPathCount(t, requests, http.MethodPost, "/v1.55/volumes/prune", 1)
	pruneRequest := findDomainRequest(
		requests,
		http.MethodPost,
		"/v1.55/volumes/prune?filters=%7B%22all%22%3A%5B%22true%22%5D%2C%22label%22%3A%5B%22temporary%3Dtrue%22%5D%7D",
	)
	if pruneRequest.Method == "" {
		t.Fatalf("volume prune did not preserve the all=true Engine filter: %#v", *requests)
	}
}

func TestStructuredNumericMethodsReportRemoteTransportLimitation(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()

	// The dashboard used to be entirely unavailable on any context without a local Engine
	// socket. It now degrades to `docker info` over the CLI and states what is missing
	// rather than showing nothing at all.
	snapshot, err := service.systemSnapshot(context.Background(), SystemSnapshotParams{Context: "remote"})
	if err != nil {
		t.Fatalf("remote snapshot should fall back to the CLI: %v", err)
	}
	if snapshot.Source != "cli-json" || snapshot.Engine.ServerVersion != "29.6.2" {
		t.Fatalf("unexpected remote snapshot: %#v", snapshot)
	}
	if len(snapshot.Limitations) == 0 {
		t.Fatal("remote snapshot must state what the CLI transport cannot provide")
	}

	_, err = service.containerStats(context.Background(), ContainerStatsParams{
		Context: "remote", ID: fullContainerID,
	})
	if got := AsOpError(err).Code; got != "context_transport_unsupported" {
		t.Fatalf("expected explicit stats transport limitation, got %q (%v)", got, err)
	}
}

func TestRemoteContextUsesExactCLIJSONAndPinnedMutationFallbacks(t *testing.T) {
	socketPath, closeServer, _ := startDomainEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)

	inspect, err := service.containerInspect(context.Background(), ContainerInspectParams{
		Context: "remote", ID: fullContainerID,
	})
	if err != nil || inspect.Source != "cli-json" || inspect.Container.Name != "remote-web" {
		t.Fatalf("remote inspect: result=%#v err=%v", inspect, err)
	}
	images, err := service.imagesList(context.Background(), ImagesListParams{Context: "remote"})
	if err != nil || images.Source != "cli-json" || len(images.Images) != 1 ||
		images.Images[0].ID != fullImageID || images.Images[0].Containers != 2 ||
		len(images.Limitations) == 0 {
		t.Fatalf("remote images: result=%#v err=%v", images, err)
	}
	volumes, err := service.volumesList(context.Background(), VolumesListParams{Context: "remote"})
	if err != nil || volumes.Source != "cli-json" || len(volumes.Volumes) != 1 ||
		volumes.Volumes[0].Name != "remote-data" || len(volumes.Limitations) == 0 {
		t.Fatalf("remote volumes: result=%#v err=%v", volumes, err)
	}
	removed, err := service.imagesAction(context.Background(), ImagesActionParams{
		Context: "remote", Action: "remove", ID: fullImageID,
		Reference: "fixture:latest", Confirmed: true,
	}, nil)
	if err != nil || removed.Receipt.Source != "cli" || removed.Receipt.Outcome != "succeeded" {
		t.Fatalf("remote image remove: result=%#v err=%v", removed, err)
	}
	imagePruned, err := service.imagesAction(context.Background(), ImagesActionParams{
		Context: "remote", Action: "prune", Confirmed: true,
		Filters: map[string][]string{"dangling": {"true"}},
	}, nil)
	if err != nil || imagePruned.Receipt.Source != "cli" || imagePruned.Receipt.Outcome != "succeeded" {
		t.Fatalf("remote image prune: result=%#v err=%v", imagePruned, err)
	}
	created, err := service.volumesAction(context.Background(), VolumesActionParams{
		Context: "remote", Action: "create", Name: "remote-created", Driver: "local",
	}, nil)
	if err != nil || created.Receipt.Source != "cli" || created.Receipt.Outcome != "succeeded" {
		t.Fatalf("remote volume create: result=%#v err=%v", created, err)
	}
	volumePruned, err := service.volumesAction(context.Background(), VolumesActionParams{
		Context: "remote", Action: "prune", Confirmed: true,
		Filters: map[string][]string{"all": {"true"}},
	}, nil)
	if err != nil || volumePruned.Receipt.Source != "cli" || volumePruned.Receipt.Outcome != "succeeded" {
		t.Fatalf("remote volume prune: result=%#v err=%v", volumePruned, err)
	}

	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read fake Docker log: %v", err)
	}
	for _, exact := range []string{
		"--context remote container inspect --format {{json .}} " + fullContainerID,
		"--context remote image ls --no-trunc --digests --all --format {{json .}}",
		"--context remote volume ls --format {{json .}}",
		"--context remote image inspect --format {{.Id}} fixture:latest",
		"--context remote image rm fixture:latest",
		"--context remote image prune --force",
		"--context remote volume create --driver local remote-created",
		"--context remote volume prune --force --all",
	} {
		if strings.Count(string(logData), exact) != 1 {
			t.Fatalf("expected one exact context-pinned call %q, log=%s", exact, logData)
		}
	}
}

func newDomainTestService(t *testing.T) (*Service, *[]recordedDomainRequest, func()) {
	t.Helper()
	socketPath, closeServer, requests := startDomainEngine(t)
	fakeDocker, _ := writeFakeDocker(t, socketPath)
	return newTestService(t, fakeDocker), requests, closeServer
}

func startDomainEngine(t *testing.T) (string, func(), *[]recordedDomainRequest) {
	t.Helper()
	socketDirectory, err := os.MkdirTemp("/tmp", "anchorage-domain-test-")
	if err != nil {
		t.Fatalf("create socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDirectory) })
	socketPath := filepath.Join(socketDirectory, "docker.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	var lock sync.Mutex
	requests := []recordedDomainRequest{}
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		lock.Lock()
		requests = append(requests, recordedDomainRequest{
			Method: request.Method, URI: request.URL.RequestURI(), Body: string(body),
		})
		lock.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.URL.Path == "/version":
			_, _ = writer.Write([]byte(`{"ApiVersion":"1.55","MinAPIVersion":"1.40"}`))
		case request.URL.Path == "/v1.55/info":
			_, _ = writer.Write([]byte(`{
				"ID":"engine-id","Name":"fixture-engine","ServerVersion":"29.6.2",
				"OSType":"linux","OperatingSystem":"Fixture Linux","Architecture":"x86_64",
				"KernelVersion":"6.0","NCPU":8,"MemTotal":16000000000,
				"Containers":3,"ContainersRunning":1,"ContainersPaused":1,"ContainersStopped":1,
				"Images":4,"Driver":"overlay2","DockerRootDir":"/var/lib/docker",
				"ExperimentalBuild":false,"LiveRestoreEnabled":true,
				"Swarm":{"LocalNodeState":"inactive"},"Warnings":[]
			}`))
		case request.URL.Path == "/v1.55/system/df":
			_, _ = writer.Write([]byte(`{
				"LayersSize":600,"BuilderSize":50,
				"Images":[{"Id":"` + fullImageID + `","RepoTags":["fixture:latest"],"RepoDigests":[],
					"Created":10,"Size":500,"SharedSize":100,"VirtualSize":500,"Containers":1}],
				"Containers":[{"Id":"` + fullContainerID + `","Image":"fixture:latest","ImageID":"` + fullImageID + `",
					"Names":["/web"],"Created":11,"SizeRw":12,"SizeRootFs":512,"State":"running","Status":"Up"}],
				"Volumes":[{"Name":"fixture-data","Driver":"local","Mountpoint":"/vol","CreatedAt":"2026-01-01T00:00:00Z",
					"Labels":{"app":"fixture"},"Scope":"local","Options":{},"UsageData":{"Size":321,"RefCount":1}}],
				"BuildCache":[{"ID":"cache","Parents":[],"Type":"regular","Description":"fixture","InUse":false,
					"Shared":false,"Size":50,"CreatedAt":"2026-01-01T00:00:00Z","UsageCount":1}]
			}`))
		case request.URL.Path == "/v1.55/containers/"+fullContainerID+"/json":
			_, _ = writer.Write([]byte(containerInspectFixture()))
		case request.URL.Path == "/v1.55/containers/"+fullContainerID+"/stats":
			_, _ = writer.Write([]byte(`{
				"read":"2026-01-01T00:00:01Z",
				"cpu_stats":{"cpu_usage":{"total_usage":300,"percpu_usage":[100,200]},"system_cpu_usage":1200,"online_cpus":2},
				"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":1000},
				"memory_stats":{"usage":1000,"limit":2000,"stats":{"inactive_file":100}},
				"networks":{"eth0":{"rx_bytes":10,"tx_bytes":20},"eth1":{"rx_bytes":3,"tx_bytes":4}},
				"blkio_stats":{"io_service_bytes_recursive":[{"op":"Read","value":30},{"op":"Write","value":40}]},
				"pids_stats":{"current":7}
			}`))
		case request.URL.Path == "/v1.55/images/json":
			_, _ = writer.Write([]byte(`[{"Id":"` + fullImageID + `","ParentId":"","RepoTags":["fixture:latest"],
				"RepoDigests":["fixture@sha256:cccc"],"Created":10,"Size":500,"SharedSize":100,
				"VirtualSize":500,"Containers":1,"Labels":{"app":"fixture"}}]`))
		case request.Method == http.MethodGet && request.URL.Path == "/v1.55/images/fixture:latest/json":
			_, _ = writer.Write([]byte(`{"Id":"` + fullImageID + `","RepoTags":["fixture:latest","fixture:stable"]}`))
		case request.Method == http.MethodDelete && request.URL.Path == "/v1.55/images/fixture:latest":
			_, _ = writer.Write([]byte(`[{"Untagged":"fixture:latest"}]`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/containers/create":
			_, _ = writer.Write([]byte(`{"Id":"` + fullContainerID + `","Warnings":[]}`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/containers/"+fullContainerID+"/start":
			writer.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodGet && request.URL.Path == "/v1.55/images/"+fullImageID+"/json":
			_, _ = writer.Write([]byte(`{"Id":"` + fullImageID + `","RepoTags":["fixture:latest"],
				"RepoDigests":[],"Comment":"built","Created":"2026-01-01T00:00:00Z","Author":"anchorage",
				"Architecture":"amd64","Os":"linux","Size":1048576,
				"Config":{"Labels":{"team":"platform"},"Env":["PATH=/usr/bin"],"Cmd":["nginx"],
				"WorkingDir":"/app","ExposedPorts":{"443/tcp":{},"80/tcp":{}}},
				"RootFS":{"Layers":["sha256:aaa","sha256:bbb"]}}`))
		case request.Method == http.MethodGet && request.URL.Path == "/v1.55/images/"+fullImageID+"/history":
			_, _ = writer.Write([]byte(`[
				{"Id":"layer-2","Created":200,"CreatedBy":"COPY app","Size":4096,"Tags":["fixture:latest"]},
				{"Id":"layer-1","Created":100,"CreatedBy":"ENV PATH","Size":0,"Tags":null}
			]`))
		case request.Method == http.MethodGet && request.URL.Path == "/v1.55/images/search":
			_, _ = writer.Write([]byte(`[
				{"name":"community/thing","description":"community","star_count":9000,"is_official":false},
				{"name":"nginx","description":"official nginx","star_count":100,"is_official":true},
				{"name":"other/thing","description":"other","star_count":50,"is_official":false}
			]`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/commit":
			_, _ = writer.Write([]byte(`{"Id":"` + fullImageID + `"}`))
		case request.Method == http.MethodPost &&
			strings.HasPrefix(request.URL.Path, "/v1.55/containers/"+fullContainerID+"/rename"):
			writer.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPost &&
			request.URL.Path == "/v1.55/containers/"+fullContainerID+"/update":
			_, _ = writer.Write([]byte(`{"Warnings":[]}`))
		case request.Method == http.MethodPut &&
			request.URL.Path == "/v1.55/containers/"+fullContainerID+"/archive":
			writer.WriteHeader(http.StatusOK)
		case request.Method == http.MethodGet &&
			request.URL.Path == "/v1.55/containers/"+fullContainerID+"/archive":
			// A real tar stream, as the Engine archive endpoint returns.
			writer.Header().Set("Content-Type", "application/x-tar")
			tw := tar.NewWriter(writer)
			queried := request.URL.Query().Get("path")
			if queried == "/etc/hosts" {
				body := []byte("127.0.0.1 localhost\n")
				_ = tw.WriteHeader(&tar.Header{
					Name: "hosts", Mode: 0o644, Size: int64(len(body)), ModTime: time.Unix(1, 0),
				})
				_, _ = tw.Write(body)
			} else {
				_ = tw.WriteHeader(&tar.Header{Name: "etc/", Mode: 0o755, Typeflag: tar.TypeDir, ModTime: time.Unix(1, 0)})
				_ = tw.WriteHeader(&tar.Header{Name: "etc/hosts", Mode: 0o644, Size: 4, ModTime: time.Unix(1, 0)})
				_, _ = tw.Write([]byte("abcd"))
				_ = tw.WriteHeader(&tar.Header{Name: "etc/ssl/", Mode: 0o755, Typeflag: tar.TypeDir, ModTime: time.Unix(1, 0)})
				// Nested: must not appear as a direct child of /etc.
				_ = tw.WriteHeader(&tar.Header{Name: "etc/ssl/cert.pem", Mode: 0o644, Size: 2, ModTime: time.Unix(1, 0)})
				_, _ = tw.Write([]byte("xy"))
			}
			_ = tw.Close()
		case request.Method == http.MethodGet &&
			request.URL.Path == "/v1.55/containers/"+fullContainerID+"/top":
			_, _ = writer.Write([]byte(`{"Titles":["PID","CMD"],"Processes":[["1","nginx"],["7","worker"]]}`))
		case request.Method == http.MethodGet &&
			request.URL.Path == "/v1.55/containers/"+fullContainerID+"/changes":
			_, _ = writer.Write([]byte(`[{"Path":"/var/log/app.log","Kind":0},{"Path":"/tmp/new","Kind":1},{"Path":"/etc/gone","Kind":2}]`))
		case request.Method == http.MethodGet && request.URL.Path == "/v1.55/networks":
			_, _ = writer.Write([]byte(`[
				{"Name":"bridge","Id":"aaaaaaaaaaaa1111","Driver":"bridge","Scope":"local"},
				{"Name":"app-net","Id":"bbbbbbbbbbbb2222","Driver":"bridge","Scope":"local",
				 "IPAM":{"Driver":"default","Config":[{"Subnet":"172.20.0.0/16","Gateway":"172.20.0.1"}]},
				 "Labels":{"com.docker.compose.project":"app"}}
			]`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/networks/create":
			_, _ = writer.Write([]byte(`{"Id":"cccccccccccc3333","Warning":""}`))
		case request.Method == http.MethodDelete && request.URL.Path == "/v1.55/networks/bbbbbbbbbbbb2222":
			writer.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/networks/prune":
			_, _ = writer.Write([]byte(`{"NetworksDeleted":["orphan-net"]}`))
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/connect"):
			writer.WriteHeader(http.StatusOK)
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/containers/prune":
			_, _ = writer.Write([]byte(`{"ContainersDeleted":["dead-one"],"SpaceReclaimed":10}`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/networks/prune":
			_, _ = writer.Write([]byte(`{"NetworksDeleted":["orphan-net"]}`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/build/prune":
			_, _ = writer.Write([]byte(`{"CachesDeleted":["cache-a"],"SpaceReclaimed":400}`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/images/prune":
			_, _ = writer.Write([]byte(`{"ImagesDeleted":[{"Deleted":"` + fullImageID + `"}],"SpaceReclaimed":1234}`))
		case request.Method == http.MethodGet && request.URL.Path == "/v1.55/volumes":
			_, _ = writer.Write([]byte(`{"Volumes":[{"Name":"fixture-data","Driver":"local","Mountpoint":"/vol",
				"CreatedAt":"2026-01-01T00:00:00Z","Labels":{"app":"fixture"},"Scope":"local",
				"Options":{},"UsageData":null}],"Warnings":[]}`))
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/volumes/create":
			_, _ = writer.Write([]byte(`{"Name":"new-data","Driver":"local","Mountpoint":"/new-data",
				"CreatedAt":"2026-01-01T00:00:00Z","Labels":{"app":"anchorage"},"Scope":"local","Options":{}}`))
		case request.Method == http.MethodDelete && request.URL.Path == "/v1.55/volumes/fixture-data":
			writer.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPost && request.URL.Path == "/v1.55/volumes/prune":
			_, _ = writer.Write([]byte(`{"VolumesDeleted":["old-data"],"SpaceReclaimed":987}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"message":"not found"}`))
		}
	})
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	closeServer := func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = listener.Close()
	}
	return socketPath, closeServer, &requests
}

func startCustomDomainEngine(t *testing.T, handler http.Handler) (string, func()) {
	t.Helper()
	socketDirectory, err := os.MkdirTemp("/tmp", "anchorage-custom-domain-test-")
	if err != nil {
		t.Fatalf("create socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDirectory) })
	socketPath := filepath.Join(socketDirectory, "docker.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	closeServer := func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = listener.Close()
	}
	return socketPath, closeServer
}

func containerInspectFixture() string {
	return `{
		"Id":"` + fullContainerID + `","Created":"2026-01-01T00:00:00Z","Path":"nginx","Args":["-g","daemon off;"],
		"Image":"` + fullImageID + `","Name":"/web","RestartCount":2,"Driver":"overlay2","Platform":"linux","LogPath":"/log",
		"State":{"Status":"running","Running":true,"Paused":false,"Restarting":false,"OOMKilled":false,
			"Dead":false,"Pid":42,"ExitCode":0,"Error":"","StartedAt":"2026-01-01T00:00:01Z",
			"FinishedAt":"0001-01-01T00:00:00Z","Health":{"Status":"healthy"}},
		"Config":{"Hostname":"web","User":"1000","Env":["A=B"],"Cmd":["nginx"],"Image":"fixture:latest",
			"WorkingDir":"/srv","Entrypoint":["/entrypoint"],"Labels":{"app":"web"}},
		"Mounts":[{"Type":"volume","Name":"fixture-data","Source":"/vol","Destination":"/data",
			"Driver":"local","Mode":"z","RW":true,"Propagation":""}],
		"NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]},
			"Networks":{"bridge":{"NetworkID":"network","EndpointID":"endpoint","Gateway":"172.17.0.1",
				"IPAddress":"172.17.0.2","MacAddress":"00:11:22:33:44:55"}}}
	}`
}

func assertDomainRequestCount(t *testing.T, requests *[]recordedDomainRequest, method, uri string, wanted int) {
	t.Helper()
	count := 0
	for _, request := range *requests {
		if request.Method == method && request.URI == uri {
			count++
		}
	}
	if count != wanted {
		t.Fatalf("request count for %s %s: got %d want %d; requests=%#v", method, uri, count, wanted, *requests)
	}
}

func assertDomainPathCount(t *testing.T, requests *[]recordedDomainRequest, method, path string, wanted int) {
	t.Helper()
	count := 0
	for _, request := range *requests {
		if request.Method == method && strings.SplitN(request.URI, "?", 2)[0] == path {
			count++
		}
	}
	if count != wanted {
		t.Fatalf("path count for %s %s: got %d want %d; requests=%#v", method, path, count, wanted, *requests)
	}
}

func findDomainRequest(requests *[]recordedDomainRequest, method, uri string) recordedDomainRequest {
	for _, request := range *requests {
		if request.Method == method && request.URI == uri {
			return request
		}
	}
	return recordedDomainRequest{}
}

// Per-image Size repeats every shared parent layer, so summing it overstates real usage.
// `docker system df` uses the daemon's deduplicated LayersSize and subtracts only the
// unshared bytes of images that still back a container.
func TestDiskUsageSummaryMatchesDockerSystemDf(t *testing.T) {
	raw := engineDiskUsage{
		LayersSize: 1000,
		Images: []engineImage{
			// In use. Unshared contribution is 300-200=100.
			{ID: "sha256:a", Size: 300, SharedSize: 200, Containers: 1},
			// Unused, and its 250 bytes overlap the image above.
			{ID: "sha256:b", Size: 250, SharedSize: 200, Containers: 0},
		},
		Containers: []engineDiskCtr{
			{ID: "running", SizeRw: 40, State: "running"},
			{ID: "stopped", SizeRw: 60, State: "exited"},
		},
		BuildCache: []engineBuildCache{
			{ID: "hot", Size: 70, InUse: true},
			{ID: "cold", Size: 30, InUse: false},
			{ID: "shared", Size: 500, Shared: true},
		},
	}
	projected := projectDiskUsage(raw)
	summary := projected.Summary

	if summary.Images.SizeBytes != 1000 {
		t.Fatalf("image total must be the deduplicated layer size, got %d", summary.Images.SizeBytes)
	}
	if naive := raw.Images[0].Size + raw.Images[1].Size; summary.Images.SizeBytes == naive {
		t.Fatalf("image total double-counted shared layers: %d", summary.Images.SizeBytes)
	}
	if summary.Images.ReclaimableBytes != 900 {
		t.Fatalf("image reclaimable = LayersSize - unshared-in-use = 900, got %d", summary.Images.ReclaimableBytes)
	}
	if summary.Images.TotalCount != 2 || summary.Images.ActiveCount != 1 {
		t.Fatalf("unexpected image counts: %#v", summary.Images)
	}

	if summary.Containers.SizeBytes != 100 || summary.Containers.ReclaimableBytes != 60 {
		t.Fatalf("unexpected container usage: %#v", summary.Containers)
	}
	if summary.Containers.ActiveCount != 1 {
		t.Fatalf("expected one running container, got %d", summary.Containers.ActiveCount)
	}

	// Shared build-cache records are excluded from both total and reclaimable, as docker does.
	if summary.BuildCache.SizeBytes != 100 || summary.BuildCache.ReclaimableBytes != 30 {
		t.Fatalf("unexpected build cache usage: %#v", summary.BuildCache)
	}
}

// Reclaimable must never render as a negative number if the daemon reports inconsistent sizes.
func TestDiskUsageSummaryClampsNegativeReclaimable(t *testing.T) {
	raw := engineDiskUsage{
		LayersSize: 10,
		Images: []engineImage{
			{ID: "sha256:a", Size: 900, SharedSize: 0, Containers: 2},
		},
	}
	if got := projectDiskUsage(raw).Summary.Images.ReclaimableBytes; got != 0 {
		t.Fatalf("expected clamped reclaimable, got %d", got)
	}
}

// Every structured RPC used to re-fork `docker context inspect`, build a fresh http.Transport,
// issue a throwaway GET /version and then drop all idle connections. At the 2s container poll
// that was ~30 docker process spawns per minute and no reused Engine connection at all.
func TestEngineEndpointAndClientAreReusedAcrossRequests(t *testing.T) {
	socketPath, closeServer, requests := startDomainEngine(t)
	defer closeServer()
	fakeDocker, logPath := writeFakeDocker(t, socketPath)
	service := newTestService(t, fakeDocker)
	defer service.closeEngineClients()

	countCalls := func(needle string) int {
		data, err := os.ReadFile(logPath)
		if err != nil {
			return 0
		}
		count := 0
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == needle {
				count++
			}
		}
		return count
	}
	countVersionRequests := func() int {
		count := 0
		for _, request := range *requests {
			if strings.HasSuffix(request.URI, "/version") {
				count++
			}
		}
		return count
	}

	for range 5 {
		if _, err := service.containerInspect(context.Background(), ContainerInspectParams{
			Context: "default", ID: fullContainerID,
		}); err != nil {
			t.Fatalf("inspect: %v", err)
		}
	}

	if got := countCalls("context inspect default"); got != 1 {
		t.Fatalf("expected the context endpoint to be resolved once across 5 requests, got %d", got)
	}
	if got := countVersionRequests(); got != 1 {
		t.Fatalf("expected one API version negotiation across 5 requests, got %d", got)
	}

	// A second context is a different endpoint and must get its own transport.
	first, err := service.resolveEngineEndpoint(context.Background(), "default")
	if err != nil {
		t.Fatalf("resolve default: %v", err)
	}
	clientA, err := service.engineClient(context.Background(), first)
	if err != nil {
		t.Fatalf("client for default: %v", err)
	}
	clientB, err := service.engineClient(context.Background(), first)
	if err != nil {
		t.Fatalf("second client for default: %v", err)
	}
	if clientA != clientB {
		t.Fatal("expected the cached engine client to be reused for the same endpoint")
	}
}

// /system/df is a full daemon-side disk walk (~7s on a real host) and used to run on every
// snapshot, including the ones triggered after each mutation, where nothing displayed it.
func TestSystemSnapshotSkipsDiskUsageUnlessRequested(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	result, err := service.systemSnapshot(context.Background(), SystemSnapshotParams{
		Context: "default",
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	for _, request := range *requests {
		if strings.Contains(request.URI, "/system/df") {
			t.Fatalf("disk usage was walked without being requested: %#v", request)
		}
	}
	if result.Engine.APIVersion == "" {
		t.Fatal("engine info must still be returned without disk usage")
	}
	found := false
	for _, limitation := range result.Limitations {
		if strings.Contains(limitation, "Disk usage was not requested") {
			found = true
		}
	}
	if !found {
		t.Fatalf("snapshot must state that disk usage was omitted: %#v", result.Limitations)
	}

	if _, err := service.systemSnapshot(context.Background(), SystemSnapshotParams{
		Context: "default", IncludeDiskUsage: true,
	}); err != nil {
		t.Fatalf("snapshot with disk usage: %v", err)
	}
	walked := false
	for _, request := range *requests {
		if strings.Contains(request.URI, "/system/df") {
			walked = true
		}
	}
	if !walked {
		t.Fatal("expected /system/df when disk usage is explicitly requested")
	}
}

// `docker system prune` is the most-used Docker maintenance command and had no route at all.
// The Engine has no single endpoint for it, so the core must issue the same per-resource
// prunes the CLI does, in the same order, with the same default semantics.
func TestSystemPruneMirrorsDockerSemantics(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	if _, err := service.systemAction(context.Background(), SystemActionParams{
		Context: "default", Action: "prune",
	}, func(string, any) {}); err == nil ||
		AsOpError(err).Code != "confirmation_required" {
		t.Fatalf("prune must require explicit confirmation, got %v", err)
	}

	result, err := service.systemAction(context.Background(), SystemActionParams{
		Context: "default", Action: "prune", Confirmed: true,
	}, func(string, any) {})
	if err != nil {
		t.Fatalf("system prune: %v", err)
	}

	var pruned []string
	for _, request := range *requests {
		if request.Method == http.MethodPost && strings.Contains(request.URI, "prune") {
			pruned = append(pruned, request.URI)
		}
	}
	// Containers first so the images and volumes they held become reclaimable, then networks,
	// then images, then build cache. Volumes are excluded unless explicitly requested.
	if len(pruned) != 4 {
		t.Fatalf("expected four prune stages, got %v", pruned)
	}
	if !strings.Contains(pruned[0], "/containers/prune") ||
		!strings.Contains(pruned[1], "/networks/prune") ||
		!strings.Contains(pruned[2], "/images/prune") ||
		!strings.Contains(pruned[3], "/build/prune") {
		t.Fatalf("unexpected prune order: %v", pruned)
	}
	// Default prune is untagged images only.
	if !strings.Contains(pruned[2], "dangling") || !strings.Contains(pruned[2], "true") {
		t.Fatalf("default prune must keep tagged images: %s", pruned[2])
	}
	for _, request := range *requests {
		if strings.Contains(request.URI, "/volumes/prune") {
			t.Fatal("volumes must not be pruned unless explicitly requested")
		}
	}
	if result.SpaceReclaimedBytes == 0 || len(result.Stages) != 4 {
		t.Fatalf("unexpected prune report: %#v", result)
	}

	// --all inverts the image filter, and --volumes adds the volume stage.
	before := len(*requests)
	if _, err := service.systemAction(context.Background(), SystemActionParams{
		Context: "default", Action: "prune", All: true, Volumes: true, Confirmed: true,
	}, func(string, any) {}); err != nil {
		t.Fatalf("system prune --all --volumes: %v", err)
	}
	var second []string
	for _, request := range (*requests)[before:] {
		if request.Method == http.MethodPost && strings.Contains(request.URI, "prune") {
			second = append(second, request.URI)
		}
	}
	if len(second) != 5 || !strings.Contains(second[4], "/volumes/prune") {
		t.Fatalf("expected a volume stage with --volumes, got %v", second)
	}
	if !strings.Contains(second[2], "false") {
		t.Fatalf("--all must request tagged unused images too: %s", second[2])
	}
}

// Networks were absent from the product entirely: no protocol method, no core case, no UI.
// They are one of Docker's four core object types alongside containers, images and volumes.
func TestNetworksListProjectsIPAMAndFlagsPredefined(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	result, err := service.networksList(context.Background(), NetworksListParams{Context: "default"})
	if err != nil {
		t.Fatalf("networks list: %v", err)
	}
	if len(result.Networks) != 2 {
		t.Fatalf("expected two networks, got %#v", result.Networks)
	}
	// Predefined networks sort last: they can never be removed, so they must not occupy the
	// top of the list.
	if result.Networks[0].Name != "app-net" || result.Networks[1].Name != "bridge" {
		t.Fatalf("unexpected network ordering: %#v", result.Networks)
	}
	if result.Networks[1].Predefined != true || result.Networks[0].Predefined != false {
		t.Fatalf("predefined flag is wrong: %#v", result.Networks)
	}
	app := result.Networks[0]
	if len(app.Subnets) != 1 || app.Subnets[0] != "172.20.0.0/16" ||
		len(app.Gateways) != 1 || app.Gateways[0] != "172.20.0.1" {
		t.Fatalf("IPAM was not projected: %#v", app)
	}
	if app.Labels["com.docker.compose.project"] != "app" {
		t.Fatalf("labels were not projected: %#v", app.Labels)
	}
	// The list endpoint cannot report attachments; unknown must stay unknown.
	if app.ContainerCount != -1 {
		t.Fatalf("attachment count must be unknown from the list endpoint, got %d", app.ContainerCount)
	}
}

func TestNetworksActionValidatesTargetsAndConfirmation(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()
	emit := func(string, any) {}

	// Removal is destructive and must be confirmed server-side, not just in the renderer.
	if _, err := service.networksAction(context.Background(), NetworksActionParams{
		Context: "default", Action: "remove", ID: "bbbbbbbbbbbb2222",
	}, emit); err == nil || AsOpError(err).Code != "confirmation_required" {
		t.Fatalf("remove must require confirmation, got %v", err)
	}
	// A name that could be read as a flag on the CLI transport must never be accepted.
	for _, name := range []string{"-rf", "", "bad name", "bad/name"} {
		if _, err := service.networksAction(context.Background(), NetworksActionParams{
			Context: "default", Action: "create", Name: name,
		}, emit); err == nil || AsOpError(err).Code != "invalid_network_name" {
			t.Fatalf("network name %q must be rejected, got %v", name, err)
		}
	}
	if _, err := service.networksAction(context.Background(), NetworksActionParams{
		Context: "default", Action: "remove", ID: "nothex!!!!!!", Confirmed: true,
	}, emit); err == nil || AsOpError(err).Code != "invalid_network_id" {
		t.Fatalf("non-hex network id must be rejected, got %v", err)
	}
	if _, err := service.networksAction(context.Background(), NetworksActionParams{
		Context: "default", Action: "detonate", Confirmed: true,
	}, emit); err == nil || AsOpError(err).Code != "unsupported_network_action" {
		t.Fatalf("unknown action must be rejected, got %v", err)
	}
	// connect/disconnect target a container by full immutable id.
	if _, err := service.networksAction(context.Background(), NetworksActionParams{
		Context: "default", Action: "connect", ID: "bbbbbbbbbbbb2222", ContainerID: "short",
	}, emit); err == nil || AsOpError(err).Code != "invalid_container_id" {
		t.Fatalf("connect must require a full container id, got %v", err)
	}
}

func TestNetworksCreateRemoveAndPruneRoundTrip(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()
	emit := func(string, any) {}

	created, err := service.networksAction(context.Background(), NetworksActionParams{
		Context: "default", Action: "create", Name: "app-net", Driver: "bridge",
		Subnet: "172.20.0.0/16", Gateway: "172.20.0.1",
	}, emit)
	if err != nil || created.Network == nil || created.Network.ID != "cccccccccccc3333" {
		t.Fatalf("create: result=%#v err=%v", created, err)
	}
	var createBody string
	for _, request := range *requests {
		if strings.HasSuffix(request.URI, "/networks/create") {
			createBody = request.Body
		}
	}
	if !strings.Contains(createBody, `"Subnet":"172.20.0.0/16"`) ||
		!strings.Contains(createBody, `"Gateway":"172.20.0.1"`) {
		t.Fatalf("IPAM config was not sent: %s", createBody)
	}

	if _, err := service.networksAction(context.Background(), NetworksActionParams{
		Context: "default", Action: "remove", ID: "bbbbbbbbbbbb2222", Confirmed: true,
	}, emit); err != nil {
		t.Fatalf("remove: %v", err)
	}

	pruned, err := service.networksAction(context.Background(), NetworksActionParams{
		Context: "default", Action: "prune", Confirmed: true,
	}, emit)
	if err != nil || pruned.Prune == nil || len(pruned.Prune.NetworksDeleted) != 1 {
		t.Fatalf("prune: result=%#v err=%v", pruned, err)
	}
}

// Container creation is a structured `docker run`: every field is validated and projected,
// so the create form cannot become a second unchecked command surface. Both primary CTAs in
// the product previously just opened a raw argv editor.
func TestContainersCreateProjectsPortsAndValidatesInput(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()
	emit := func(string, any) {}

	result, err := service.containersCreate(context.Background(), ContainersCreateParams{
		Context: "default", Image: "nginx:1.27", Name: "web",
		Ports:         map[string]string{"8080": "80"},
		Env:           []string{"TZ=Europe/London"},
		Binds:         []string{"/srv/site:/usr/share/nginx/html:ro"},
		RestartPolicy: "unless-stopped",
		Start:         true,
	}, emit)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if result.ID != fullContainerID || !result.Started {
		t.Fatalf("unexpected create result: %#v", result)
	}

	var body, uri string
	for _, request := range *requests {
		if strings.Contains(request.URI, "/containers/create") {
			body, uri = request.Body, request.URI
		}
	}
	if !strings.Contains(uri, "name=web") {
		t.Fatalf("name was not sent: %s", uri)
	}
	// A bare container port must be normalized to Docker's port/proto key form.
	if !strings.Contains(body, `"80/tcp"`) {
		t.Fatalf("port was not normalized to port/proto: %s", body)
	}
	if !strings.Contains(body, `"HostPort":"8080"`) {
		t.Fatalf("host binding missing: %s", body)
	}
	if !strings.Contains(body, `"Name":"unless-stopped"`) {
		t.Fatalf("restart policy missing: %s", body)
	}

	for name, params := range map[string]ContainersCreateParams{
		"flag-like image":   {Context: "default", Image: "-rf"},
		"bad name":          {Context: "default", Image: "nginx", Name: "bad name"},
		"bad restart":       {Context: "default", Image: "nginx", RestartPolicy: "sometimes"},
		"env without value": {Context: "default", Image: "nginx", Env: []string{"NOPE"}},
		"non-numeric port":  {Context: "default", Image: "nginx", Ports: map[string]string{"http": "80"}},
		"bad protocol":      {Context: "default", Image: "nginx", Ports: map[string]string{"8080": "80/carrier-pigeon"}},
	} {
		if _, err := service.containersCreate(context.Background(), params, emit); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}

	// Docker itself rejects this combination; catching it here gives a clearer error.
	if _, err := service.containersCreate(context.Background(), ContainersCreateParams{
		Context: "default", Image: "nginx", AutoRemove: true, RestartPolicy: "always",
	}, emit); err == nil || AsOpError(err).Code != "invalid_action_options" {
		t.Fatalf("auto-remove with a restart policy must be rejected, got %v", err)
	}
}

// The containers list showed a permanent em-dash in CPU and MEMORY because stats were only
// ever fetched for the single selected container. Batch sampling backs those columns.
func TestContainersStatsBatchIsolatesPerContainerFailures(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	// fullContainerID resolves; the second ID is well-formed but unknown to the fake engine.
	missing := strings.Repeat("b", 64)
	result, err := service.containersStatsBatch(context.Background(), ContainersStatsBatchParams{
		Context: "default", IDs: []string{fullContainerID, missing},
	})
	if err != nil {
		t.Fatalf("batch must not fail because one container did: %v", err)
	}
	if len(result.Samples) != 2 {
		t.Fatalf("expected one sample per requested id, got %#v", result.Samples)
	}
	// Order must track the request so the renderer can zip results to rows.
	if result.Samples[0].ID != fullContainerID || result.Samples[1].ID != missing {
		t.Fatalf("sample order did not follow the request: %#v", result.Samples)
	}
	if result.Samples[0].Stats == nil || result.Samples[0].Error != nil {
		t.Fatalf("known container should have stats: %#v", result.Samples[0])
	}
	if result.Samples[1].Error == nil || result.Samples[1].Stats != nil {
		t.Fatalf("unknown container should report its own error: %#v", result.Samples[1])
	}

	if _, err := service.containersStatsBatch(context.Background(), ContainersStatsBatchParams{
		Context: "default", IDs: []string{fullContainerID, fullContainerID},
	}); err == nil {
		t.Fatal("duplicate ids must be rejected")
	}
	oversized := make([]string, maxStatsBatch+1)
	for index := range oversized {
		oversized[index] = strings.Repeat(string(rune('a'+index%16)), 64)
	}
	if _, err := service.containersStatsBatch(context.Background(), ContainersStatsBatchParams{
		Context: "default", IDs: oversized,
	}); err == nil {
		t.Fatal("oversized batch must be rejected")
	}
	empty, err := service.containersStatsBatch(context.Background(), ContainersStatsBatchParams{
		Context: "default", IDs: []string{},
	})
	if err != nil || len(empty.Samples) != 0 {
		t.Fatalf("empty batch should be a no-op: %#v %v", empty, err)
	}
}

// The Images screen had no detail surface at all: an image's layers, size breakdown and
// provenance were only reachable by leaving the application.
func TestImagesInspectProjectsConfigurationAndHistory(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	result, err := service.imagesInspect(context.Background(), ImagesInspectParams{
		Context: "default", ID: fullImageID,
	})
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if result.Image.ID != fullImageID || result.Image.SizeBytes != 1048576 {
		t.Fatalf("unexpected image detail: %#v", result.Image)
	}
	if result.Image.Labels["team"] != "platform" || result.Image.WorkingDir != "/app" {
		t.Fatalf("config was not projected: %#v", result.Image)
	}
	// Exposed ports come from a map, so they must be ordered for a stable UI.
	if len(result.Image.ExposedPorts) != 2 ||
		result.Image.ExposedPorts[0] != "443/tcp" || result.Image.ExposedPorts[1] != "80/tcp" {
		t.Fatalf("exposed ports were not sorted: %#v", result.Image.ExposedPorts)
	}
	if len(result.Image.RootFSLayers) != 2 {
		t.Fatalf("rootfs layers missing: %#v", result.Image.RootFSLayers)
	}
	if len(result.History) != 2 {
		t.Fatalf("expected two history entries, got %#v", result.History)
	}
	// A zero-size history entry is metadata only and must be marked as such rather than
	// looking like a layer that genuinely contributes nothing.
	if result.History[0].EmptyLayer || !result.History[1].EmptyLayer {
		t.Fatalf("empty-layer marking is wrong: %#v", result.History)
	}
	if len(result.Document) == 0 {
		t.Fatal("raw inspect document must be retained")
	}

	if _, err := service.imagesInspect(context.Background(), ImagesInspectParams{
		Context: "default", ID: "not-a-digest",
	}); err == nil {
		t.Fatal("inspect must require a full sha256 image id")
	}
}

// The Files tab was fabricated in fixture mode and unavailable against real Docker. Listing
// walks tar headers from the archive endpoint rather than exec'ing `ls`, so it also works on
// scratch and distroless images that contain no shell.
func TestContainerFilesListsDirectChildrenOnly(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	result, err := service.containerFiles(context.Background(), ContainerFilesParams{
		Context: "default", ID: fullContainerID, Path: "/etc",
	})
	if err != nil {
		t.Fatalf("files: %v", err)
	}
	names := make([]string, 0, len(result.Entries))
	for _, entry := range result.Entries {
		names = append(names, entry.Name)
	}
	// ssl/cert.pem is nested and must not surface as a child of /etc.
	if len(names) != 2 || names[0] != "ssl" || names[1] != "hosts" {
		t.Fatalf("expected directories first then files, got %v", names)
	}
	if !result.Entries[0].IsDir || result.Entries[1].IsDir {
		t.Fatalf("directory flags are wrong: %#v", result.Entries)
	}
	if result.Entries[1].Path != "/etc/hosts" {
		t.Fatalf("child path was not joined: %#v", result.Entries[1])
	}
}

func TestContainerFileReadAndPathValidation(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	read, err := service.containerFileRead(context.Background(), ContainerFileReadParams{
		Context: "default", ID: fullContainerID, Path: "/etc/hosts",
	})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if read.Encoding != "utf-8" || !strings.Contains(read.Content, "localhost") {
		t.Fatalf("unexpected file content: %#v", read)
	}

	// The path becomes an Engine query parameter, so traversal and control characters must
	// never reach it.
	for _, bad := range []string{"relative/path", "/etc/../../root", "/etc/\nhosts", "/etc/\x00x"} {
		if _, err := service.containerFiles(context.Background(), ContainerFilesParams{
			Context: "default", ID: fullContainerID, Path: bad,
		}); err == nil || AsOpError(err).Code != "invalid_path" {
			t.Fatalf("path %q must be rejected, got %v", bad, err)
		}
	}
	// An empty path defaults to the root rather than erroring.
	if _, err := service.containerFiles(context.Background(), ContainerFilesParams{
		Context: "default", ID: fullContainerID,
	}); err != nil {
		t.Fatalf("empty path should default to /: %v", err)
	}
	if _, err := service.containerFileRead(context.Background(), ContainerFileReadParams{
		Context: "default", ID: fullContainerID, Path: "/",
	}); err == nil {
		t.Fatal("a directory must not be readable as a file")
	}
}

func TestContainerTopAndDiffProjectDockerSemantics(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	top, err := service.containerTop(context.Background(), ContainerInspectParams{
		Context: "default", ID: fullContainerID,
	})
	if err != nil || len(top.Titles) != 2 || len(top.Processes) != 2 {
		t.Fatalf("top: %#v %v", top, err)
	}
	if top.Processes[1].Values[1] != "worker" {
		t.Fatalf("process rows were not projected: %#v", top.Processes)
	}

	diff, err := service.containerDiff(context.Background(), ContainerInspectParams{
		Context: "default", ID: fullContainerID,
	})
	if err != nil || len(diff.Changes) != 3 {
		t.Fatalf("diff: %#v %v", diff, err)
	}
	// Docker's 0/1/2 must be projected to names the UI can render without a lookup table.
	byPath := map[string]string{}
	for _, change := range diff.Changes {
		byPath[change.Path] = change.Kind
	}
	if byPath["/var/log/app.log"] != "modified" || byPath["/tmp/new"] != "added" ||
		byPath["/etc/gone"] != "deleted" {
		t.Fatalf("change kinds were not projected: %#v", diff.Changes)
	}
}

// Upload is the other half of `docker cp`. The entry name becomes a tar path, so a separator
// or traversal segment would let a file escape the directory the user chose.
func TestContainerFileWriteRejectsEscapingNames(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	payload := base64.StdEncoding.EncodeToString([]byte("hello"))
	result, err := service.containerFileWrite(context.Background(), ContainerFileWriteParams{
		Context: "default", ID: fullContainerID, Path: "/tmp", Name: "note.txt", Content: payload,
	})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if result.Path != "/tmp/note.txt" || result.SizeBytes != 5 {
		t.Fatalf("unexpected upload result: %#v", result)
	}
	var uploaded *recordedDomainRequest
	for index := range *requests {
		if (*requests)[index].Method == http.MethodPut {
			uploaded = &(*requests)[index]
		}
	}
	if uploaded == nil || !strings.Contains(uploaded.URI, "path=%2Ftmp") {
		t.Fatalf("upload did not target the chosen directory: %#v", uploaded)
	}
	// The body must be a real tar containing exactly the one entry.
	reader := tar.NewReader(strings.NewReader(uploaded.Body))
	header, headerErr := reader.Next()
	if headerErr != nil || header.Name != "note.txt" || header.Size != 5 {
		t.Fatalf("upload body was not a single-entry tar: %#v %v", header, headerErr)
	}

	for _, name := range []string{"../escape", "sub/dir.txt", "", ".", "..", "a\\\\b"} {
		if _, err := service.containerFileWrite(context.Background(), ContainerFileWriteParams{
			Context: "default", ID: fullContainerID, Path: "/tmp", Name: name, Content: payload,
		}); err == nil || AsOpError(err).Code != "invalid_path" {
			t.Fatalf("upload name %q must be rejected, got %v", name, err)
		}
	}
	if _, err := service.containerFileWrite(context.Background(), ContainerFileWriteParams{
		Context: "default", ID: fullContainerID, Path: "/tmp", Name: "x", Content: "not base64!!",
	}); err == nil || AsOpError(err).Code != "invalid_content" {
		t.Fatal("non-base64 content must be rejected")
	}
}

// rename and update complete the container lifecycle. Both are allowlisted actions with
// option sets that must not leak into the other verbs.
func TestContainerRenameAndUpdateValidateTheirOwnOptions(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()
	emit := func(string, any) {}

	if _, err := service.containersAction(context.Background(), ContainersActionParams{
		Context: "default", ID: fullContainerID, Action: "rename",
		Options: ContainerActionOptions{Name: "renamed-api"},
	}, emit); err != nil {
		t.Fatalf("rename: %v", err)
	}
	var renamed bool
	for _, request := range *requests {
		if strings.Contains(request.URI, "/rename?name=renamed-api") {
			renamed = true
		}
	}
	if !renamed {
		t.Fatalf("rename did not send the new name: %#v", *requests)
	}

	before := len(*requests)
	if _, err := service.containersAction(context.Background(), ContainersActionParams{
		Context: "default", ID: fullContainerID, Action: "update",
		Options: ContainerActionOptions{MemoryBytes: 512 * 1024 * 1024, RestartPolicy: "always"},
	}, emit); err != nil {
		t.Fatalf("update: %v", err)
	}
	var updateBody string
	for _, request := range (*requests)[before:] {
		if strings.HasSuffix(request.URI, "/update") {
			updateBody = request.Body
		}
	}
	if !strings.Contains(updateBody, `"Memory":536870912`) ||
		!strings.Contains(updateBody, `"Name":"always"`) {
		t.Fatalf("update body did not carry the limits: %s", updateBody)
	}
	// Omitted fields must not be sent at all: zero means "leave unchanged", not "set to 0".
	if strings.Contains(updateBody, "CpuShares") {
		t.Fatalf("update sent an unset field: %s", updateBody)
	}

	for name, params := range map[string]ContainersActionParams{
		"rename with a flag-like name": {
			Context: "default", ID: fullContainerID, Action: "rename",
			Options: ContainerActionOptions{Name: "-rf"},
		},
		"name on a non-rename action": {
			Context: "default", ID: fullContainerID, Action: "start",
			Options: ContainerActionOptions{Name: "nope"},
		},
		"limits on a non-update action": {
			Context: "default", ID: fullContainerID, Action: "stop",
			Options: ContainerActionOptions{MemoryBytes: 1 << 30},
		},
		"memory below Docker's floor": {
			Context: "default", ID: fullContainerID, Action: "update",
			Options: ContainerActionOptions{MemoryBytes: 1024},
		},
		"unsupported restart policy": {
			Context: "default", ID: fullContainerID, Action: "update",
			Options: ContainerActionOptions{RestartPolicy: "sometimes"},
		},
	} {
		if _, err := service.containersAction(context.Background(), params, emit); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

// The Registry tab was fixture-only: in host mode it silently became a bare pull box while
// still being labelled "Registry search".
func TestImagesSearchRanksOfficialThenPopular(t *testing.T) {
	service, _, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()

	result, err := service.imagesSearch(context.Background(), ImagesSearchParams{
		Context: "default", Term: "nginx",
	})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	// Official first even though a community image has far more stars, then by popularity.
	names := []string{}
	for _, entry := range result.Results {
		names = append(names, entry.Name)
	}
	if len(names) != 3 || names[0] != "nginx" || names[1] != "community/thing" {
		t.Fatalf("unexpected ranking: %v", names)
	}

	for _, term := range []string{"", "   ", "bad\nterm"} {
		if _, err := service.imagesSearch(context.Background(), ImagesSearchParams{
			Context: "default", Term: term,
		}); err == nil || AsOpError(err).Code != "invalid_search_term" {
			t.Fatalf("term %q must be rejected, got %v", term, err)
		}
	}
}

func TestContainersCommitValidatesTargetReference(t *testing.T) {
	service, requests, closeServer := newDomainTestService(t)
	defer closeServer()
	defer service.closeEngineClients()
	emit := func(string, any) {}

	result, err := service.containersCommit(context.Background(), ContainersCommitParams{
		Context: "default", ID: fullContainerID, Repository: "team/api", Tag: "snapshot",
		Comment: "from anchorage", Pause: true,
	}, emit)
	if err != nil || result.ImageID != fullImageID {
		t.Fatalf("commit: %#v %v", result, err)
	}
	var uri string
	for _, request := range *requests {
		if strings.HasPrefix(request.URI, "/v1.55/commit") {
			uri = request.URI
		}
	}
	if !strings.Contains(uri, "repo=team%2Fapi") || !strings.Contains(uri, "tag=snapshot") ||
		!strings.Contains(uri, "pause=true") {
		t.Fatalf("commit did not carry its parameters: %s", uri)
	}

	// A leading '-' would let a repository be read as a flag on the CLI transport.
	if _, err := service.containersCommit(context.Background(), ContainersCommitParams{
		Context: "default", ID: fullContainerID, Repository: "-rf",
	}, emit); err == nil {
		t.Fatal("flag-like repository must be rejected")
	}
	if _, err := service.containersCommit(context.Background(), ContainersCommitParams{
		Context: "default", ID: fullContainerID, Repository: "",
	}, emit); err == nil {
		t.Fatal("empty repository must be rejected")
	}
}

// save/load/export write or read multi-gigabyte tars, so they run as sessions against a host
// file rather than streaming through the JSON transport. The path is argv-adjacent, so it is
// validated as strictly as any other untrusted input.
func TestArchivePathValidationRejectsUnsafeTargets(t *testing.T) {
	service := newSessionTestService(t)

	// The service's own allowlist root: an arbitrary temp dir is correctly outside it, which
	// is the point of the check.
	writable := service.defaultCWD
	if len(service.allowedCWDs) > 0 {
		writable = service.allowedCWDs[0]
	}
	existing := filepath.Join(writable, "image.tar")
	if err := os.WriteFile(existing, []byte("tar"), 0o600); err != nil {
		t.Fatalf("seed archive: %v", err)
	}

	// A path whose parent exists and is inside the allowlist is accepted for save.
	if _, err := service.validateArchivePath(filepath.Join(writable, "new.tar"), false, false); err != nil {
		t.Fatalf("writable target should be accepted: %v", err)
	}
	// load requires the file to already exist.
	if _, err := service.validateArchivePath(existing, true, false); err != nil {
		t.Fatalf("existing archive should be accepted for load: %v", err)
	}
	if _, err := service.validateArchivePath(filepath.Join(writable, "absent.tar"), true, false); err == nil {
		t.Fatal("load must reject a missing archive")
	}
	// A directory is not an archive.
	if _, err := service.validateArchivePath(writable, true, false); err == nil {
		t.Fatal("a directory must not be accepted as an archive file")
	}

	// `docker save --output` truncates, so replacing an existing file takes an explicit
	// decision. Without this an operator naming a real file by mistake loses it silently.
	if _, err := service.validateArchivePath(existing, false, false); err == nil {
		t.Fatal("save must refuse to overwrite an existing file without being told to")
	}
	if _, err := service.validateArchivePath(existing, false, true); err != nil {
		t.Fatalf("an acknowledged overwrite should be accepted: %v", err)
	}

	// The parent is canonicalized, so only a symlink in the FINAL position could redirect the
	// write. Lstat sees the link itself rather than following it.
	link := filepath.Join(writable, "link.tar")
	if err := os.Symlink(filepath.Join(writable, "elsewhere.tar"), link); err != nil {
		t.Fatalf("seed symlink: %v", err)
	}
	if _, err := service.validateArchivePath(link, false, true); err == nil {
		t.Fatal("a symlink target must be rejected even when overwrite is agreed")
	}
	// A device would let Docker write into a stream rather than a file.
	if _, err := service.validateArchivePath("/dev/null", false, true); err == nil {
		t.Fatal("a device node must not be accepted as an archive target")
	}

	for _, bad := range []string{
		"",                     // empty
		"relative/path.tar",    // not absolute
		"-oh-no.tar",           // could be read as a flag
		"/tmp/bad\nname.tar",   // control character
		"/tmp/bad\x00name.tar", // NUL
	} {
		if _, err := service.validateArchivePath(bad, false, false); err == nil {
			t.Fatalf("archive path %q must be rejected", bad)
		}
	}
}

func TestImageSaveAndLoadRequireTheirOwnOptions(t *testing.T) {
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "save", ArchivePath: "/tmp/x.tar",
	}); err == nil {
		t.Fatal("save must require a reference")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "save", Reference: "-rf", ArchivePath: "/tmp/x.tar",
	}); err == nil {
		t.Fatal("save must reject a flag-like reference")
	}
	// Options belonging to other actions must not leak in.
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "load", ArchivePath: "/tmp/x.tar", Confirmed: true,
	}); err == nil {
		t.Fatal("archive actions must reject confirmation options")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "load", ArchivePath: "/tmp/x.tar",
	}); err != nil {
		t.Fatalf("a plain load should validate: %v", err)
	}
}

func TestImageReferenceSplitsRepositoryFromTag(t *testing.T) {
	// A colon is only a tag separator in the final path segment. Treating a registry port as
	// a tag would send Docker a repository that does not exist.
	for _, testCase := range []struct {
		reference  string
		repository string
		tag        string
	}{
		{"alpine", "alpine", ""},
		{"alpine:3.20", "alpine", "3.20"},
		{"team/api:v1", "team/api", "v1"},
		{"registry.example:5000/team/api", "registry.example:5000/team/api", ""},
		{"registry.example:5000/team/api:v1", "registry.example:5000/team/api", "v1"},
		// A digest identifies a specific image and is not a tag the endpoint can set.
		{"team/api@sha256:" + strings.Repeat("a", 64), "team/api", ""},
	} {
		repository, tag := splitImageReference(testCase.reference)
		if repository != testCase.repository || tag != testCase.tag {
			t.Fatalf("%q split to (%q, %q), want (%q, %q)",
				testCase.reference, repository, tag, testCase.repository, testCase.tag)
		}
	}
}

func TestImageTagIsAddressedByImmutableIDOnly(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("b", 64)
	// A tag as the source would let the operation label whatever that tag points at now,
	// which need not be the image the operator was looking at.
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "tag", Reference: "team/api:v2",
	}); err == nil {
		t.Fatal("tag must require an immutable source image ID")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "tag", ID: imageID, Reference: "--force",
	}); err == nil {
		t.Fatal("tag must reject a flag-like target reference")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "tag", ID: imageID, Reference: "team/api:v2",
		ArchivePath: "/tmp/x.tar",
	}); err == nil {
		t.Fatal("tag must reject options belonging to another action")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "tag", ID: imageID, Reference: "team/api:v2",
	}); err != nil {
		t.Fatalf("a well-formed tag should validate: %v", err)
	}
}

func TestPushNamesTheRegistryItWouldPublishTo(t *testing.T) {
	// The destination is derived from the reference, never chosen separately, so a
	// confirmation that names the wrong host is worse than no confirmation at all.
	for _, testCase := range []struct{ reference, registry string }{
		{"alpine", "docker.io"},
		{"team/api:v1", "docker.io"},
		{"registry.example.com/team/api:v1", "registry.example.com"},
		{"localhost:5000/team/api", "localhost:5000"},
		{"ghcr.io/owner/name:tag", "ghcr.io"},
		{"registry.example:5000/team/api@sha256:" + strings.Repeat("a", 64), "registry.example:5000"},
	} {
		if got := registryHostForReference(testCase.reference); got != testCase.registry {
			t.Fatalf("%q resolves to %q, want %q", testCase.reference, got, testCase.registry)
		}
	}
}

func TestPushIsConfirmedAndTakesNoForeignOptions(t *testing.T) {
	// Pushing publishes to a remote that may be public; it cannot be taken back.
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "push", Reference: "team/api:v1",
	}); err == nil {
		t.Fatal("push must require confirmation")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "push", Reference: "--all", Confirmed: true,
	}); err == nil {
		t.Fatal("a flag-like reference must be rejected")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "push", Reference: "team/api:v1", Confirmed: true,
		ArchivePath: "/tmp/x.tar",
	}); err == nil {
		t.Fatal("push must reject options belonging to another action")
	}
	if err := validateImagesAction(ImagesActionParams{
		Context: "default", Action: "push", Reference: "team/api:v1", Confirmed: true,
	}); err != nil {
		t.Fatalf("a confirmed push should validate: %v", err)
	}
}
