package core

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	domainReadTimeout     = 60 * time.Second
	domainMutationTimeout = 5 * time.Minute
	// Captured CLI output is JSON-encoded into a single RPC response line, and the client
	// kills the core if that line exceeds 8 MiB. Stay far enough below it that JSON string
	// escaping cannot push a full-size capture over the framing limit.
	domainCLIOutputLimit = 4 * 1024 * 1024
	// /system/df is a full daemon-side disk walk and is deliberately given its own budget.
	diskUsageTimeout = 90 * time.Second
)

func (s *Service) systemSnapshot(parent context.Context, params SystemSnapshotParams) (SystemSnapshotResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return SystemSnapshotResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.systemSnapshotCLI(ctx, contextName, params.IncludeDiskUsage)
		}
		return SystemSnapshotResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.systemSnapshotCLI(ctx, contextName, params.IncludeDiskUsage)
		}
		return SystemSnapshotResult{}, err
	}

	status, infoBody, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/info", nil)
	if err != nil {
		return SystemSnapshotResult{}, err
	}
	if status < 200 || status >= 300 {
		return SystemSnapshotResult{}, engineHTTPError("system_info_failed", "Docker Engine rejected the system information request.", status, infoBody)
	}
	var info engineInfo
	if err := json.Unmarshal(infoBody, &info); err != nil {
		return SystemSnapshotResult{}, opError("system_info_invalid", "Docker Engine returned invalid system information JSON.", err, map[string]any{
			"context": contextName,
		})
	}

	var disk engineDiskUsage
	limitations := []string{}
	if params.IncludeDiskUsage {
		// Disk usage gets its own budget and degrades to a limitation. Previously a slow walk
		// failed the entire snapshot, so the whole dashboard went away rather than just the
		// disk figures.
		diskCtx, cancelDisk := context.WithTimeout(parent, diskUsageTimeout)
		status, diskBody, diskErr := client.request(diskCtx, http.MethodGet, "/v"+client.apiVersion+"/system/df", nil)
		cancelDisk()
		switch {
		case diskErr != nil:
			limitations = append(limitations, "Disk usage is unavailable: "+AsOpError(diskErr).Message)
		case status < 200 || status >= 300:
			limitations = append(limitations, "Docker Engine rejected the disk usage request.")
		default:
			if err := json.Unmarshal(diskBody, &disk); err != nil {
				limitations = append(limitations, "Docker Engine returned invalid disk usage JSON.")
				disk = engineDiskUsage{}
			}
		}
	} else {
		limitations = append(limitations, "Disk usage was not requested for this snapshot.")
	}

	return SystemSnapshotResult{
		Context: contextName, Source: "engine-api", APIVersion: client.apiVersion,
		Engine: projectEngineInfo(info, client), DiskUsage: projectDiskUsage(disk),
		ObservedAt: nowUTC(), EndpointHash: endpoint.endpointHash,
		Limitations: append(
			[]string{"Engine /info and /system/df are sequential observations, not an atomic daemon snapshot."},
			limitations...,
		),
	}, nil
}

type engineInfo struct {
	ID                 string   `json:"ID"`
	Name               string   `json:"Name"`
	ServerVersion      string   `json:"ServerVersion"`
	OSType             string   `json:"OSType"`
	OperatingSystem    string   `json:"OperatingSystem"`
	Architecture       string   `json:"Architecture"`
	KernelVersion      string   `json:"KernelVersion"`
	NCPU               int      `json:"NCPU"`
	MemTotal           int64    `json:"MemTotal"`
	Containers         int      `json:"Containers"`
	ContainersRunning  int      `json:"ContainersRunning"`
	ContainersPaused   int      `json:"ContainersPaused"`
	ContainersStopped  int      `json:"ContainersStopped"`
	Images             int      `json:"Images"`
	Driver             string   `json:"Driver"`
	DockerRootDir      string   `json:"DockerRootDir"`
	ExperimentalBuild  bool     `json:"ExperimentalBuild"`
	LiveRestoreEnabled bool     `json:"LiveRestoreEnabled"`
	Warnings           []string `json:"Warnings"`
	Swarm              struct {
		LocalNodeState string `json:"LocalNodeState"`
	} `json:"Swarm"`
}

type engineDiskUsage struct {
	LayersSize  int64              `json:"LayersSize"`
	BuilderSize int64              `json:"BuilderSize"`
	Images      []engineImage      `json:"Images"`
	Containers  []engineDiskCtr    `json:"Containers"`
	Volumes     []engineVolume     `json:"Volumes"`
	BuildCache  []engineBuildCache `json:"BuildCache"`
}

type engineImage struct {
	ID          string            `json:"Id"`
	ParentID    string            `json:"ParentId"`
	RepoTags    []string          `json:"RepoTags"`
	RepoDigests []string          `json:"RepoDigests"`
	Created     int64             `json:"Created"`
	Size        int64             `json:"Size"`
	SharedSize  int64             `json:"SharedSize"`
	VirtualSize int64             `json:"VirtualSize"`
	Containers  int64             `json:"Containers"`
	Labels      map[string]string `json:"Labels"`
}

type engineDiskCtr struct {
	ID         string   `json:"Id"`
	Image      string   `json:"Image"`
	ImageID    string   `json:"ImageID"`
	Names      []string `json:"Names"`
	Created    int64    `json:"Created"`
	SizeRw     int64    `json:"SizeRw"`
	SizeRootFS int64    `json:"SizeRootFs"`
	State      string   `json:"State"`
	Status     string   `json:"Status"`
}

type engineVolume struct {
	Name       string            `json:"Name"`
	Driver     string            `json:"Driver"`
	Mountpoint string            `json:"Mountpoint"`
	CreatedAt  string            `json:"CreatedAt"`
	Status     map[string]any    `json:"Status"`
	Labels     map[string]string `json:"Labels"`
	Scope      string            `json:"Scope"`
	Options    map[string]string `json:"Options"`
	UsageData  *struct {
		Size     int64 `json:"Size"`
		RefCount int64 `json:"RefCount"`
	} `json:"UsageData"`
}

type engineBuildCache struct {
	ID          string   `json:"ID"`
	Parent      string   `json:"Parent"`
	Parents     []string `json:"Parents"`
	Type        string   `json:"Type"`
	Description string   `json:"Description"`
	InUse       bool     `json:"InUse"`
	Shared      bool     `json:"Shared"`
	Size        int64    `json:"Size"`
	CreatedAt   string   `json:"CreatedAt"`
	LastUsedAt  string   `json:"LastUsedAt"`
	UsageCount  int64    `json:"UsageCount"`
}

func projectEngineInfo(raw engineInfo, client *engineClient) EngineSummary {
	// client is nil on the CLI-JSON fallback, where no Engine version was negotiated.
	apiVersion, minAPIVersion := "", ""
	if client != nil {
		apiVersion, minAPIVersion = client.apiVersion, client.serverMin
	}
	return EngineSummary{
		ID: raw.ID, Name: raw.Name, ServerVersion: raw.ServerVersion,
		APIVersion: apiVersion, MinAPIVersion: minAPIVersion,
		OSType: raw.OSType, OperatingSystem: raw.OperatingSystem,
		Architecture: raw.Architecture, KernelVersion: raw.KernelVersion,
		CPUs: raw.NCPU, MemoryBytes: raw.MemTotal, Containers: raw.Containers,
		ContainersRunning: raw.ContainersRunning, ContainersPaused: raw.ContainersPaused,
		ContainersStopped: raw.ContainersStopped, Images: raw.Images, Driver: raw.Driver,
		DockerRootDir: raw.DockerRootDir, Experimental: raw.ExperimentalBuild,
		LiveRestoreEnabled: raw.LiveRestoreEnabled, SwarmState: raw.Swarm.LocalNodeState,
		Warnings: nonNilStrings(raw.Warnings),
	}
}

func projectDiskUsage(raw engineDiskUsage) SystemDiskUsage {
	result := SystemDiskUsage{
		LayersSizeBytes: raw.LayersSize, BuilderSizeBytes: raw.BuilderSize,
		Images: []ImageDiskUsage{}, Containers: []ContainerDiskUsage{},
		Volumes: []VolumeProjection{}, BuildCache: []BuildCacheUsage{},
	}
	for _, item := range raw.Images {
		result.Images = append(result.Images, ImageDiskUsage{
			ID: item.ID, RepoTags: nonNilStrings(item.RepoTags), RepoDigests: nonNilStrings(item.RepoDigests),
			Created: item.Created, SizeBytes: item.Size, SharedBytes: item.SharedSize,
			VirtualBytes: item.VirtualSize, Containers: item.Containers,
		})
	}
	for _, item := range raw.Containers {
		result.Containers = append(result.Containers, ContainerDiskUsage{
			ID: item.ID, Image: item.Image, ImageID: item.ImageID, Names: nonNilStrings(item.Names),
			Created: item.Created, WritableBytes: item.SizeRw, RootFSBytes: item.SizeRootFS,
			State: item.State, Status: item.Status,
		})
	}
	for _, item := range raw.Volumes {
		result.Volumes = append(result.Volumes, projectVolume(item))
	}
	for _, item := range raw.BuildCache {
		result.BuildCache = append(result.BuildCache, BuildCacheUsage{
			ID: item.ID, Parent: item.Parent, Parents: nonNilStrings(item.Parents), Type: item.Type,
			Description: item.Description, InUse: item.InUse, Shared: item.Shared, SizeBytes: item.Size,
			CreatedAt: item.CreatedAt, LastUsedAt: item.LastUsedAt, UsageCount: item.UsageCount,
		})
	}
	sort.Slice(result.Images, func(i, j int) bool { return result.Images[i].ID < result.Images[j].ID })
	sort.Slice(result.Containers, func(i, j int) bool { return result.Containers[i].ID < result.Containers[j].ID })
	sortVolumes(result.Volumes)
	sort.Slice(result.BuildCache, func(i, j int) bool { return result.BuildCache[i].ID < result.BuildCache[j].ID })
	result.Summary = summarizeDiskUsage(raw, result)
	return result
}

// summarizeDiskUsage reproduces `docker system df` exactly. Image totals come from the
// daemon's deduplicated LayersSize; reclaimable subtracts only the unshared bytes of images
// that still back a container. Summing per-image Size instead would double-count every
// shared parent layer.
func summarizeDiskUsage(raw engineDiskUsage, projected SystemDiskUsage) SystemDiskUsageSummary {
	summary := SystemDiskUsageSummary{}

	summary.Images.TotalCount = int64(len(raw.Images))
	summary.Images.SizeBytes = raw.LayersSize
	var imagesUsed int64
	for _, item := range raw.Images {
		if item.Containers == 0 {
			continue
		}
		summary.Images.ActiveCount++
		if item.Size < 0 || item.SharedSize < 0 {
			continue
		}
		imagesUsed += item.Size - item.SharedSize
	}
	summary.Images.ReclaimableBytes = raw.LayersSize - imagesUsed

	summary.Containers.TotalCount = int64(len(raw.Containers))
	for _, item := range raw.Containers {
		summary.Containers.SizeBytes += item.SizeRw
		if strings.EqualFold(item.State, "running") {
			summary.Containers.ActiveCount++
			continue
		}
		summary.Containers.ReclaimableBytes += item.SizeRw
	}

	summary.Volumes.TotalCount = int64(len(projected.Volumes))
	for _, item := range projected.Volumes {
		if item.Usage == nil || item.Usage.SizeBytes < 0 {
			continue
		}
		summary.Volumes.SizeBytes += item.Usage.SizeBytes
		if item.Usage.RefCount > 0 {
			summary.Volumes.ActiveCount++
			continue
		}
		summary.Volumes.ReclaimableBytes += item.Usage.SizeBytes
	}

	summary.BuildCache.TotalCount = int64(len(raw.BuildCache))
	for _, item := range raw.BuildCache {
		if item.Shared {
			continue
		}
		summary.BuildCache.SizeBytes += item.Size
		if item.InUse {
			summary.BuildCache.ActiveCount++
			continue
		}
		summary.BuildCache.ReclaimableBytes += item.Size
	}

	for _, category := range []*DiskUsageCategory{
		&summary.Images, &summary.Containers, &summary.Volumes, &summary.BuildCache,
	} {
		if category.ReclaimableBytes < 0 {
			category.ReclaimableBytes = 0
		}
	}
	return summary
}

func (s *Service) containerInspect(parent context.Context, params ContainerInspectParams) (ContainerInspectResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainerInspectResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainerInspectResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.containerInspectCLI(ctx, contextName, params.ID)
		}
		return ContainerInspectResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.containerInspectCLI(ctx, contextName, params.ID)
		}
		return ContainerInspectResult{}, err
	}
	path := "/v" + client.apiVersion + "/containers/" + url.PathEscape(params.ID) + "/json"
	status, body, err := client.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return ContainerInspectResult{}, err
	}
	if status < 200 || status >= 300 {
		return ContainerInspectResult{}, engineHTTPError("container_inspect_failed", "Docker Engine rejected the container inspect request.", status, body)
	}
	projected, err := decodeContainerInspect(body, contextName)
	if err != nil {
		return ContainerInspectResult{}, err
	}
	return ContainerInspectResult{
		Context: contextName, Source: "engine-api", APIVersion: client.apiVersion,
		Container: projected, Document: cloneJSON(body), ObservedAt: nowUTC(),
		EndpointHash: endpoint.endpointHash,
	}, nil
}

type engineContainerInspect struct {
	ID           string   `json:"Id"`
	Created      string   `json:"Created"`
	Path         string   `json:"Path"`
	Args         []string `json:"Args"`
	Image        string   `json:"Image"`
	Name         string   `json:"Name"`
	RestartCount int      `json:"RestartCount"`
	Driver       string   `json:"Driver"`
	Platform     string   `json:"Platform"`
	LogPath      string   `json:"LogPath"`
	State        struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		Paused     bool   `json:"Paused"`
		Restarting bool   `json:"Restarting"`
		OOMKilled  bool   `json:"OOMKilled"`
		Dead       bool   `json:"Dead"`
		Pid        int    `json:"Pid"`
		ExitCode   int    `json:"ExitCode"`
		Error      string `json:"Error"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Hostname   string            `json:"Hostname"`
		User       string            `json:"User"`
		Env        []string          `json:"Env"`
		Cmd        []string          `json:"Cmd"`
		Image      string            `json:"Image"`
		WorkingDir string            `json:"WorkingDir"`
		Entrypoint []string          `json:"Entrypoint"`
		Labels     map[string]string `json:"Labels"`
	} `json:"Config"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Driver      string `json:"Driver"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
		Propagation string `json:"Propagation"`
	} `json:"Mounts"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
		Networks map[string]struct {
			NetworkID  string `json:"NetworkID"`
			EndpointID string `json:"EndpointID"`
			Gateway    string `json:"Gateway"`
			IPAddress  string `json:"IPAddress"`
			MacAddress string `json:"MacAddress"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

func decodeContainerInspect(body []byte, contextName string) (ContainerInspectProjection, error) {
	var raw engineContainerInspect
	if err := json.Unmarshal(body, &raw); err != nil {
		return ContainerInspectProjection{}, opError("container_inspect_invalid", "Docker returned invalid container inspect JSON.", err, map[string]any{
			"context": contextName,
		})
	}
	if err := validateContainerID(raw.ID); err != nil {
		return ContainerInspectProjection{}, opError("container_inspect_invalid", "Docker inspect did not return a full immutable container ID.", err, map[string]any{
			"context": contextName,
		})
	}
	health := ""
	if raw.State.Health != nil {
		health = raw.State.Health.Status
	}
	projected := ContainerInspectProjection{
		ID: raw.ID, Name: strings.TrimPrefix(raw.Name, "/"), Created: raw.Created, Path: raw.Path,
		Args: nonNilStrings(raw.Args), ImageID: raw.Image, Driver: raw.Driver, Platform: raw.Platform,
		RestartCount: raw.RestartCount, LogPath: raw.LogPath,
		State: ContainerStateProjection{
			Status: raw.State.Status, Running: raw.State.Running, Paused: raw.State.Paused,
			Restarting: raw.State.Restarting, OOMKilled: raw.State.OOMKilled, Dead: raw.State.Dead,
			PID: raw.State.Pid, ExitCode: raw.State.ExitCode, Error: raw.State.Error,
			StartedAt: raw.State.StartedAt, FinishedAt: raw.State.FinishedAt, Health: health,
		},
		Image: raw.Config.Image, Hostname: raw.Config.Hostname, User: raw.Config.User,
		WorkingDir: raw.Config.WorkingDir, Entrypoint: nonNilStrings(raw.Config.Entrypoint),
		Command: nonNilStrings(raw.Config.Cmd), Environment: nonNilStrings(raw.Config.Env),
		Labels: nonNilMap(raw.Config.Labels), Mounts: []ContainerMountProjection{},
		Ports: map[string][]PortBinding{}, Networks: map[string]NetworkProjection{},
	}
	for _, item := range raw.Mounts {
		projected.Mounts = append(projected.Mounts, ContainerMountProjection{
			Type: item.Type, Name: item.Name, Source: item.Source, Destination: item.Destination,
			Driver: item.Driver, Mode: item.Mode, RW: item.RW, Propagation: item.Propagation,
		})
	}
	sort.Slice(projected.Mounts, func(i, j int) bool {
		return projected.Mounts[i].Destination < projected.Mounts[j].Destination
	})
	for key, bindings := range raw.NetworkSettings.Ports {
		projected.Ports[key] = []PortBinding{}
		for _, binding := range bindings {
			projected.Ports[key] = append(projected.Ports[key], PortBinding{
				HostIP: binding.HostIP, HostPort: binding.HostPort,
			})
		}
	}
	for key, network := range raw.NetworkSettings.Networks {
		projected.Networks[key] = NetworkProjection{
			NetworkID: network.NetworkID, EndpointID: network.EndpointID, Gateway: network.Gateway,
			IPAddress: network.IPAddress, MacAddress: network.MacAddress,
		}
	}
	return projected, nil
}

func (s *Service) containerInspectCLI(ctx context.Context, contextName, id string) (ContainerInspectResult, error) {
	args := withContext(contextName, "container", "inspect", "--format", "{{json .}}", id)
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
	if err != nil {
		return ContainerInspectResult{}, err
	}
	if result.timedOut {
		return ContainerInspectResult{}, opError("container_inspect_timeout", "Docker CLI container inspection timed out.", context.DeadlineExceeded, map[string]any{
			"context": contextName,
		})
	}
	if result.exitCode != 0 {
		return ContainerInspectResult{}, opError("container_inspect_failed", "Docker CLI rejected the container inspect request.", nil, map[string]any{
			"context": contextName, "exitCode": result.exitCode, "stderr": string(result.stderr),
		})
	}
	document := bytes.TrimSpace(result.stdout)
	projected, err := decodeContainerInspect(document, contextName)
	if err != nil {
		return ContainerInspectResult{}, err
	}
	return ContainerInspectResult{
		Context: contextName, Source: "cli-json", Container: projected,
		Document: cloneJSON(document), ObservedAt: nowUTC(),
	}, nil
}

func (s *Service) containerStats(parent context.Context, params ContainerStatsParams) (ContainerStatsResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainerStatsResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainerStatsResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ContainerStatsResult{}, nativeTransportRequired("containers.stats", contextName, err)
		}
		return ContainerStatsResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ContainerStatsResult{}, nativeTransportRequired("containers.stats", contextName, err)
		}
		return ContainerStatsResult{}, err
	}
	values := url.Values{}
	values.Set("stream", "false")
	// Deliberately no one-shot: one-shot skips the daemon's second collection cycle, which
	// leaves precpu_stats zeroed. projectContainerStats would then divide by the container's
	// whole lifetime and report a lifetime average instead of a live rate. stream=false alone
	// makes the daemon wait one extra cycle and populate precpu_stats.
	path := "/v" + client.apiVersion + "/containers/" + url.PathEscape(params.ID) + "/stats?" + values.Encode()
	status, body, err := client.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return ContainerStatsResult{}, err
	}
	if status < 200 || status >= 300 {
		return ContainerStatsResult{}, engineHTTPError("container_stats_failed", "Docker Engine rejected the stats request.", status, body)
	}
	projected, err := projectContainerStats(body, contextName, params.ID)
	if err != nil {
		return ContainerStatsResult{}, err
	}
	projected.Source = "engine-api"
	projected.APIVersion = client.apiVersion
	projected.EndpointHash = endpoint.endpointHash
	projected.ObservedAt = nowUTC()
	return projected, nil
}

type engineStats struct {
	Read     string `json:"read"`
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RXBytes uint64 `json:"rx_bytes"`
		TXBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	BlkioStats struct {
		IOServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
	PidsStats struct {
		Current uint64 `json:"current"`
	} `json:"pids_stats"`
}

func projectContainerStats(body []byte, contextName, id string) (ContainerStatsResult, error) {
	var raw engineStats
	if err := json.Unmarshal(body, &raw); err != nil {
		return ContainerStatsResult{}, opError("container_stats_invalid", "Docker Engine returned invalid container stats JSON.", err, map[string]any{
			"context": contextName, "containerId": id,
		})
	}
	cpuDelta := positiveDelta(raw.CPUStats.CPUUsage.TotalUsage, raw.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := positiveDelta(raw.CPUStats.SystemCPUUsage, raw.PreCPUStats.SystemCPUUsage)
	online := raw.CPUStats.OnlineCPUs
	if online == 0 {
		online = uint32(len(raw.CPUStats.CPUUsage.PercpuUsage))
	}
	cpuPercent := float64(0)
	if systemDelta > 0 && cpuDelta > 0 && online > 0 {
		cpuPercent = float64(cpuDelta) / float64(systemDelta) * float64(online) * 100
	}
	workingSet := raw.MemoryStats.Usage
	inactive := raw.MemoryStats.Stats["inactive_file"]
	if inactive == 0 {
		inactive = raw.MemoryStats.Stats["total_inactive_file"]
	}
	if inactive < workingSet {
		workingSet -= inactive
	}
	memoryPercent := float64(0)
	if raw.MemoryStats.Limit > 0 {
		memoryPercent = float64(workingSet) / float64(raw.MemoryStats.Limit) * 100
	}
	var networkRX, networkTX, blockRead, blockWrite uint64
	for _, network := range raw.Networks {
		networkRX += network.RXBytes
		networkTX += network.TXBytes
	}
	for _, entry := range raw.BlkioStats.IOServiceBytesRecursive {
		switch strings.ToLower(entry.Op) {
		case "read":
			blockRead += entry.Value
		case "write":
			blockWrite += entry.Value
		}
	}
	return ContainerStatsResult{
		Context: contextName, ContainerID: id, ReadAt: raw.Read, CPUPercent: cpuPercent,
		CPUUsageTotal: raw.CPUStats.CPUUsage.TotalUsage, CPUUsageDelta: cpuDelta,
		SystemUsageDelta: systemDelta, OnlineCPUs: online,
		MemoryUsageBytes: raw.MemoryStats.Usage, MemoryWorkingSet: workingSet,
		MemoryLimitBytes: raw.MemoryStats.Limit, MemoryPercent: memoryPercent,
		NetworkRXBytes: networkRX, NetworkTXBytes: networkTX,
		BlockReadBytes: blockRead, BlockWriteBytes: blockWrite, PIDs: raw.PidsStats.Current,
		Document: cloneJSON(body),
	}, nil
}

func (s *Service) imagesList(parent context.Context, params ImagesListParams) (ImagesListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ImagesListResult{}, err
	}
	all := true
	if params.All != nil {
		all = *params.All
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.imagesListCLI(ctx, contextName, all, params.IncludeDangling)
		}
		return ImagesListResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.imagesListCLI(ctx, contextName, all, params.IncludeDangling)
		}
		return ImagesListResult{}, err
	}
	values := url.Values{}
	values.Set("all", strconv.FormatBool(all))
	values.Set("shared-size", "true")
	path := "/v" + client.apiVersion + "/images/json?" + values.Encode()
	status, body, err := client.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return ImagesListResult{}, err
	}
	if status < 200 || status >= 300 {
		return ImagesListResult{}, engineHTTPError("images_list_failed", "Docker Engine rejected the image list request.", status, body)
	}
	var raw []engineImage
	if err := json.Unmarshal(body, &raw); err != nil {
		return ImagesListResult{}, opError("images_list_invalid", "Docker Engine returned invalid image list JSON.", err, map[string]any{
			"context": contextName,
		})
	}
	danglingIDs := map[string]bool{}
	if !all && params.IncludeDangling {
		danglingValues := url.Values{}
		danglingValues.Set("all", "false")
		danglingValues.Set("shared-size", "true")
		danglingFilters, _ := json.Marshal(map[string][]string{"dangling": {"true"}})
		danglingValues.Set("filters", string(danglingFilters))
		danglingPath := "/v" + client.apiVersion + "/images/json?" + danglingValues.Encode()
		danglingStatus, danglingBody, danglingErr := client.request(ctx, http.MethodGet, danglingPath, nil)
		if danglingErr != nil {
			return ImagesListResult{}, danglingErr
		}
		if danglingStatus < 200 || danglingStatus >= 300 {
			return ImagesListResult{}, engineHTTPError(
				"images_dangling_list_failed",
				"Docker Engine rejected the dangling-image list request.",
				danglingStatus,
				danglingBody,
			)
		}
		var dangling []engineImage
		if err := json.Unmarshal(danglingBody, &dangling); err != nil {
			return ImagesListResult{}, opError(
				"images_dangling_list_invalid",
				"Docker Engine returned invalid dangling-image JSON.",
				err,
				map[string]any{"context": contextName},
			)
		}
		for _, item := range dangling {
			danglingIDs[item.ID] = true
		}
		raw = append(raw, dangling...)
	}
	images := make([]ImageProjection, 0, len(raw))
	seen := make(map[string]bool, len(raw))
	for _, item := range raw {
		// The unfiltered Engine all=false response includes untagged
		// intermediate layers that Docker's normal image view hides. Keep
		// tagged top-level images from that response, then merge the dedicated
		// dangling=true leaf query above.
		if !all && len(item.RepoTags) == 0 && !danglingIDs[item.ID] {
			continue
		}
		if seen[item.ID] {
			continue
		}
		seen[item.ID] = true
		images = append(images, projectImage(item))
	}
	sortImages(images)
	return ImagesListResult{
		Context: contextName, Source: "engine-api", APIVersion: client.apiVersion,
		Images: images, ObservedAt: nowUTC(), EndpointHash: endpoint.endpointHash,
		Limitations: []string{},
	}, nil
}

func projectImage(item engineImage) ImageProjection {
	return ImageProjection{
		ID: item.ID, ParentID: item.ParentID, RepoTags: nonNilStrings(item.RepoTags),
		RepoDigests: nonNilStrings(item.RepoDigests), Created: item.Created, SizeBytes: item.Size,
		SharedBytes: item.SharedSize, VirtualBytes: item.VirtualSize, Containers: item.Containers,
		Labels: nonNilMap(item.Labels),
	}
}

func (s *Service) imagesListCLI(
	ctx context.Context,
	contextName string,
	all bool,
	includeDangling bool,
) (ImagesListResult, error) {
	runList := func(extra ...string) (commandResult, error) {
		args := withContext(contextName, "image", "ls", "--no-trunc", "--digests")
		args = append(args, extra...)
		args = append(args, "--format", "{{json .}}")
		result, err := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
		if err != nil {
			return result, err
		}
		if result.timedOut {
			return result, opError("images_list_timeout", "Docker CLI image listing timed out.", context.DeadlineExceeded, map[string]any{"context": contextName})
		}
		if result.exitCode != 0 {
			return result, opError("images_list_failed", "Docker CLI rejected the image list request.", nil, map[string]any{
				"context": contextName, "exitCode": result.exitCode, "stderr": string(result.stderr),
			})
		}
		return result, nil
	}
	extra := []string{}
	if all {
		extra = append(extra, "--all")
	}
	result, err := runList(extra...)
	if err != nil {
		return ImagesListResult{}, err
	}
	outputs := [][]byte{result.stdout}
	if !all && includeDangling {
		dangling, danglingErr := runList("--filter", "dangling=true")
		if danglingErr != nil {
			return ImagesListResult{}, danglingErr
		}
		outputs = append(outputs, dangling.stdout)
	}
	images := []ImageProjection{}
	indexByID := map[string]int{}
	for outputIndex, output := range outputs {
		for lineNumber, line := range splitJSONLines(output) {
			var row struct {
				ID         string `json:"ID"`
				Repository string `json:"Repository"`
				Tag        string `json:"Tag"`
				Digest     string `json:"Digest"`
				CreatedAt  string `json:"CreatedAt"`
				Size       string `json:"Size"`
				Containers string `json:"Containers"`
			}
			if err := json.Unmarshal(line, &row); err != nil {
				return ImagesListResult{}, opError("images_list_invalid", "Docker CLI returned an invalid image row.", err, map[string]any{
					"context": contextName, "line": lineNumber + 1, "query": outputIndex + 1,
				})
			}
			tags := []string{}
			if row.Repository != "" && row.Repository != "<none>" && row.Tag != "" && row.Tag != "<none>" {
				tags = append(tags, row.Repository+":"+row.Tag)
			}
			digests := []string{}
			if row.Repository != "" && row.Repository != "<none>" && row.Digest != "" && row.Digest != "<none>" {
				digests = append(digests, row.Repository+"@"+row.Digest)
			}
			if index, exists := indexByID[row.ID]; exists {
				images[index].RepoTags = appendUnique(images[index].RepoTags, tags...)
				images[index].RepoDigests = appendUnique(images[index].RepoDigests, digests...)
				continue
			}
			containerCount := int64(-1)
			if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(row.Containers), 10, 64); parseErr == nil && parsed >= 0 {
				containerCount = parsed
			}
			indexByID[row.ID] = len(images)
			images = append(images, ImageProjection{
				ID: row.ID, RepoTags: tags, RepoDigests: digests, Labels: map[string]string{},
				SizeDisplay: row.Size, CreatedDisplay: row.CreatedAt, Containers: containerCount,
			})
		}
	}
	sortImages(images)
	return ImagesListResult{
		Context: contextName, Source: "cli-json", Images: images, ObservedAt: nowUTC(),
		Limitations: []string{"Remote CLI JSON exposes display-formatted size and creation values; exact byte and epoch fields are unavailable. Image usage remains unknown when the CLI omits or cannot parse its Containers field."},
	}, nil
}

func (s *Service) volumesList(parent context.Context, params VolumesListParams) (VolumesListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumesListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.volumesListCLI(ctx, contextName)
		}
		return VolumesListResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.volumesListCLI(ctx, contextName)
		}
		return VolumesListResult{}, err
	}
	status, body, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/volumes", nil)
	if err != nil {
		return VolumesListResult{}, err
	}
	if status < 200 || status >= 300 {
		return VolumesListResult{}, engineHTTPError("volumes_list_failed", "Docker Engine rejected the volume list request.", status, body)
	}
	var raw struct {
		Volumes  []engineVolume `json:"Volumes"`
		Warnings []string       `json:"Warnings"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return VolumesListResult{}, opError("volumes_list_invalid", "Docker Engine returned invalid volume list JSON.", err, map[string]any{
			"context": contextName,
		})
	}
	limitations := []string{}
	usageStatus, usageBody, usageErr := client.request(
		ctx,
		http.MethodGet,
		"/v"+client.apiVersion+"/system/df?type=volume",
		nil,
	)
	if usageErr == nil && usageStatus >= 200 && usageStatus < 300 {
		var diskUsage struct {
			Volumes []engineVolume `json:"Volumes"`
		}
		if unmarshalErr := json.Unmarshal(usageBody, &diskUsage); unmarshalErr == nil {
			usageByName := make(map[string]*struct {
				Size     int64 `json:"Size"`
				RefCount int64 `json:"RefCount"`
			}, len(diskUsage.Volumes))
			for index := range diskUsage.Volumes {
				item := &diskUsage.Volumes[index]
				if item.UsageData != nil {
					usageByName[item.Name] = item.UsageData
				}
			}
			for index := range raw.Volumes {
				if usage, ok := usageByName[raw.Volumes[index].Name]; ok {
					raw.Volumes[index].UsageData = usage
				}
			}
		} else {
			limitations = append(limitations, "Volume usage is unknown because Docker returned invalid /system/df volume data.")
		}
	} else {
		limitations = append(limitations, "Volume usage is unknown because Docker did not provide /system/df volume data.")
	}
	volumes := make([]VolumeProjection, 0, len(raw.Volumes))
	for _, item := range raw.Volumes {
		volumes = append(volumes, projectVolume(item))
	}
	sortVolumes(volumes)
	return VolumesListResult{
		Context: contextName, Source: "engine-api", APIVersion: client.apiVersion,
		Volumes: volumes, Warnings: nonNilStrings(raw.Warnings), ObservedAt: nowUTC(),
		EndpointHash: endpoint.endpointHash, Limitations: limitations,
	}, nil
}

func projectVolume(item engineVolume) VolumeProjection {
	projected := VolumeProjection{
		Name: item.Name, Driver: item.Driver, Mountpoint: item.Mountpoint, CreatedAt: item.CreatedAt,
		Scope: item.Scope, Labels: nonNilMap(item.Labels), Options: nonNilMap(item.Options), Status: item.Status,
	}
	if projected.Status == nil {
		projected.Status = map[string]any{}
	}
	if item.UsageData != nil {
		projected.Usage = &VolumeUsageData{SizeBytes: item.UsageData.Size, RefCount: item.UsageData.RefCount}
	}
	return projected
}

func (s *Service) volumesListCLI(ctx context.Context, contextName string) (VolumesListResult, error) {
	args := withContext(contextName, "volume", "ls", "--format", "{{json .}}")
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
	if err != nil {
		return VolumesListResult{}, err
	}
	if result.timedOut {
		return VolumesListResult{}, opError("volumes_list_timeout", "Docker CLI volume listing timed out.", context.DeadlineExceeded, map[string]any{"context": contextName})
	}
	if result.exitCode != 0 {
		return VolumesListResult{}, opError("volumes_list_failed", "Docker CLI rejected the volume list request.", nil, map[string]any{
			"context": contextName, "exitCode": result.exitCode, "stderr": string(result.stderr),
		})
	}
	volumes := []VolumeProjection{}
	for lineNumber, line := range splitJSONLines(result.stdout) {
		var row struct {
			Name       string `json:"Name"`
			Driver     string `json:"Driver"`
			Scope      string `json:"Scope"`
			Mountpoint string `json:"Mountpoint"`
			Labels     string `json:"Labels"`
			Size       string `json:"Size"`
		}
		if err := json.Unmarshal(line, &row); err != nil {
			return VolumesListResult{}, opError("volumes_list_invalid", "Docker CLI returned an invalid volume row.", err, map[string]any{
				"context": contextName, "line": lineNumber + 1,
			})
		}
		volumes = append(volumes, VolumeProjection{
			Name: row.Name, Driver: row.Driver, Scope: row.Scope, Mountpoint: row.Mountpoint,
			Labels: map[string]string{}, Options: map[string]string{}, Status: map[string]any{},
			LabelsText: row.Labels, SizeDisplay: row.Size,
		})
	}
	sortVolumes(volumes)
	return VolumesListResult{
		Context: contextName, Source: "cli-json", Volumes: volumes, Warnings: []string{},
		ObservedAt:  nowUTC(),
		Limitations: []string{"Remote CLI JSON exposes labels and size as display strings; exact usage bytes and structured labels are unavailable."},
	}, nil
}

func (s *Service) imagesAction(parent context.Context, params ImagesActionParams, emit EventEmitter) (ImagesActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ImagesActionResult{}, err
	}
	params.Context = contextName
	if err := validateImagesAction(params); err != nil {
		return ImagesActionResult{}, err
	}
	if params.Action == "pull" {
		return s.imagePull(parent, params, emit)
	}
	if params.Action == "push" {
		return s.imagePush(parent, params, emit)
	}
	if params.Action == "save" || params.Action == "load" {
		return s.imageArchive(parent, params, emit)
	}
	operationID, err := operationID()
	if err != nil {
		return ImagesActionResult{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	resourceID := params.ID
	if params.Action == "prune" {
		resourceID = "images"
	}
	receipt := newDomainReceipt(operationID, contextName, "image", resourceID, params.Action, "engine-api")

	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			receipt.Source = "cli"
			emitDomainStarted(emit, "images.action", receipt)
			return s.imagesActionCLI(parent, params, receipt, emit)
		}
		emitDomainStarted(emit, "images.action", receipt)
		return ImagesActionResult{}, failDomainMutation(receipt, err, emit)
	}
	receipt.EndpointHash = endpoint.endpointHash
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			receipt.Source = "cli"
			receipt.EndpointHash = ""
			emitDomainStarted(emit, "images.action", receipt)
			return s.imagesActionCLI(parent, params, receipt, emit)
		}
		emitDomainStarted(emit, "images.action", receipt)
		return ImagesActionResult{}, failDomainMutation(receipt, err, emit)
	}
	emitDomainStarted(emit, "images.action", receipt)

	method := http.MethodDelete
	path := ""
	switch params.Action {
	case "remove":
		// Target the immutable ID directly when no tag was selected. The tag re-resolution
		// below exists to stop a stale UI row deleting the wrong image; an ID cannot go stale
		// in that way, so there is nothing to verify.
		if params.Reference == "" {
			values := url.Values{}
			values.Set("force", strconv.FormatBool(params.Force))
			values.Set("noprune", strconv.FormatBool(params.NoPrune))
			path = "/v" + client.apiVersion + "/images/" + url.PathEscape(params.ID) + "?" + values.Encode()
			break
		}
		inspectPath := "/v" + client.apiVersion + "/images/" + url.PathEscape(params.Reference) + "/json"
		inspectStatus, inspectBody, inspectErr := client.request(ctx, http.MethodGet, inspectPath, nil)
		if inspectErr != nil {
			return ImagesActionResult{}, failDomainMutation(receipt, inspectErr, emit)
		}
		if inspectStatus < 200 || inspectStatus >= 300 {
			return ImagesActionResult{}, failDomainMutation(receipt,
				engineHTTPError("image_reference_inspect_failed",
					"Docker Engine could not verify the selected image reference before removal.",
					inspectStatus, inspectBody), emit)
		}
		var inspected struct {
			ID string `json:"Id"`
		}
		if err := json.Unmarshal(inspectBody, &inspected); err != nil {
			return ImagesActionResult{}, failDomainMutation(receipt,
				opError("image_reference_inspect_invalid",
					"Docker Engine returned invalid image identity JSON.", err, nil), emit)
		}
		if !strings.EqualFold(inspected.ID, params.ID) {
			return ImagesActionResult{}, failDomainMutation(receipt,
				opError("image_reference_changed",
					"The selected tag no longer refers to the image shown. Refresh before removing it.",
					nil, map[string]any{
						"expectedImageId": params.ID,
						"observedImageId": inspected.ID,
						"reference":       params.Reference,
					}), emit)
		}
		values := url.Values{}
		values.Set("force", strconv.FormatBool(params.Force))
		values.Set("noprune", strconv.FormatBool(params.NoPrune))
		path = "/v" + client.apiVersion + "/images/" + url.PathEscape(params.Reference) + "?" + values.Encode()
	case "prune":
		method = http.MethodPost
		path = "/v" + client.apiVersion + "/images/prune?" + encodedFilters(params.Filters)
	case "tag":
		// Tagging is addressed by immutable ID, not by an existing tag. A tag can be moved to
		// another image between the list being rendered and the operator acting on it, so
		// naming the source by tag would risk labelling whatever it points at now.
		method = http.MethodPost
		repository, tag := splitImageReference(params.Reference)
		values := url.Values{}
		values.Set("repo", repository)
		if tag != "" {
			values.Set("tag", tag)
		}
		path = "/v" + client.apiVersion + "/images/" + url.PathEscape(params.ID) + "/tag?" + values.Encode()
	}
	status, body, requestErr := client.request(ctx, method, path, nil)
	receipt.HTTPStatus = status
	if requestErr != nil {
		return ImagesActionResult{}, failSubmittedMutation(receipt, requestErr, emit)
	}
	if status < 200 || status >= 300 {
		return ImagesActionResult{}, failDomainMutation(receipt,
			engineHTTPError("image_action_failed", "Docker Engine rejected the image mutation.", status, body), emit)
	}
	result := ImagesActionResult{Action: params.Action}
	switch params.Action {
	case "remove":
		if err := json.Unmarshal(body, &result.Deleted); err != nil {
			return ImagesActionResult{}, failAcknowledgedMutation(receipt,
				opError("image_action_invalid", "Docker Engine returned invalid image removal JSON.", err, nil), emit)
		}
	case "prune":
		var raw struct {
			ImagesDeleted  []ImageDeleteRecord `json:"ImagesDeleted"`
			SpaceReclaimed uint64              `json:"SpaceReclaimed"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return ImagesActionResult{}, failAcknowledgedMutation(receipt,
				opError("image_action_invalid", "Docker Engine returned invalid image prune JSON.", err, nil), emit)
		}
		result.Prune = &ImagePruneResult{
			ImagesDeleted: nonNilImageDeletes(raw.ImagesDeleted), SpaceReclaimed: raw.SpaceReclaimed,
		}
	}
	succeedDomainMutation(&receipt, emit)
	result.Receipt = receipt
	return result, nil
}

// sessionReceiptEmitter wraps an emitter so a session-backed verb also reports domain
// receipts.
//
// Only image pull did this. Compose lifecycle verbs, image save/load and container export
// passed their emitter straight through, so their receipts existed solely in the RPC result
// with outcome "running" — anything driven off operation.* (audit, reconciliation) never saw
// a `compose down`, an `image load`, or a host-file-writing export finish or fail. A verb
// whose completion is invisible to the audit path is worse than one that is slow.
func sessionReceiptEmitter(emit EventEmitter, method, contextName, domain, resource, action,
	failureCode, failureMessage string) EventEmitter {
	operationID := ""
	return func(event string, payload any) {
		switch event {
		case "session.started":
			if typed, ok := payload.(SessionStartedEvent); ok {
				operationID = typed.SessionID
				emitDomainStarted(emit, method, DomainOperationReceipt{
					OperationID: operationID, Context: contextName, Domain: domain,
					ResourceID: resource, Action: action, Source: "cli-session",
					Outcome: "running", StartedAt: typed.StartedAt,
				})
			}
		case "session.exited":
			if typed, ok := payload.(SessionExitedEvent); ok {
				receipt := DomainOperationReceipt{
					OperationID: operationID, Context: contextName, Domain: domain,
					ResourceID: resource, Action: action, Source: "cli-session",
					Outcome: "failed", ExitCode: &typed.ExitCode, StartedAt: typed.StartedAt,
					CompletedAt: typed.ExitedAt, DurationMs: typed.DurationMs,
				}
				var failure error
				reconcile := false
				switch {
				case typed.ExitCode == 0 && !typed.Canceled && !typed.TimedOut:
					receipt.Outcome = "succeeded"
				case typed.Canceled || typed.TimedOut:
					// The verb may have partly applied before it was cut short, so the outcome
					// is genuinely unknown rather than failed.
					receipt.Outcome = "unknown"
					failure = opError("mutation_outcome_unknown", failureMessage+
						" ended before a successful Docker exit; reconciliation is required.",
						nil, map[string]any{"receipt": receipt})
					reconcile = true
				default:
					failure = opError(failureCode, failureMessage+" failed.", nil,
						map[string]any{"receipt": receipt})
				}
				emitDomainCompleted(emit, receipt, failure)
				emitReconciliation(emit, receipt, reconcile)
			}
		}
		if emit != nil {
			emit(event, payload)
		}
	}
}

// registryHostForReference reports where a reference would be pushed.
//
// Docker's own rule: the first path segment is a registry only when it looks like a host —
// it contains a dot or a port, or is localhost. Otherwise the reference belongs to Docker
// Hub. Getting this wrong in a confirmation would name the wrong destination, which for a
// publish is the difference between an internal registry and a public one.
func registryHostForReference(reference string) string {
	value := reference
	if at := strings.Index(value, "@"); at >= 0 {
		value = value[:at]
	}
	segments := strings.Split(value, "/")
	if len(segments) > 1 {
		candidate := segments[0]
		if strings.Contains(candidate, ".") || strings.Contains(candidate, ":") ||
			candidate == "localhost" {
			return candidate
		}
	}
	return "docker.io"
}

// imagePush publishes an image to its registry.
//
// A session rather than a request: a push uploads layers and routinely runs for minutes.
// Credentials are never handled here — the Docker CLI resolves them from the operator's own
// configuration and credential helpers, so nothing secret crosses this boundary or is stored.
func (s *Service) imagePush(parent context.Context, params ImagesActionParams, emit EventEmitter) (ImagesActionResult, error) {
	cwd := params.Cwd
	if cwd == "" && len(s.allowedCWDs) > 0 {
		cwd = s.allowedCWDs[0]
	}
	registry := registryHostForReference(params.Reference)
	session, err := s.sessions.start(context.WithoutCancel(parent), SessionStartParams{
		Context: params.Context, Argv: []string{"image", "push", params.Reference},
		Cwd: cwd, Mode: "pipes",
		TimeoutSeconds:    params.TimeoutSeconds,
		OutputWindowBytes: params.OutputWindowBytes,
		MaxOutputBytes:    params.MaxOutputBytes,
	}, sessionReceiptEmitter(emit, "images.action", params.Context, "image", params.Reference,
		"push", "image_push_failed", "Image push"))
	if err != nil {
		return ImagesActionResult{}, err
	}
	receipt := DomainOperationReceipt{
		OperationID: session.SessionID, Context: params.Context, Domain: "image",
		ResourceID: params.Reference, Action: "push", Source: "cli-session",
		Outcome: "running", StartedAt: session.StartedAt,
	}
	return ImagesActionResult{
		Action: "push", Receipt: receipt, Session: &session, Registry: registry,
	}, nil
}

func (s *Service) imagePull(parent context.Context, params ImagesActionParams, emit EventEmitter) (ImagesActionResult, error) {
	if params.Cwd == "" && len(s.allowedCWDs) > 0 {
		params.Cwd = s.allowedCWDs[0]
	}
	var operationID string
	wrappedEmit := func(event string, payload any) {
		if event == "session.started" {
			if typed, ok := payload.(SessionStartedEvent); ok {
				operationID = typed.SessionID
				emitDomainStarted(emit, "images.action", DomainOperationReceipt{
					OperationID: operationID, Context: params.Context, Domain: "image",
					ResourceID: params.Reference, Action: "pull", Source: "cli-session",
					Outcome: "running", StartedAt: typed.StartedAt,
				})
			}
		}
		if event == "session.exited" {
			if typed, ok := payload.(SessionExitedEvent); ok {
				receipt := DomainOperationReceipt{
					OperationID: operationID, Context: params.Context, Domain: "image",
					ResourceID: params.Reference, Action: "pull", Source: "cli-session",
					Outcome: "failed", ExitCode: &typed.ExitCode,
					StartedAt: typed.StartedAt, CompletedAt: typed.ExitedAt, DurationMs: typed.DurationMs,
				}
				var pullErr error
				reconciliationRequired := false
				if typed.ExitCode == 0 && !typed.Canceled && !typed.TimedOut {
					receipt.Outcome = "succeeded"
				} else if typed.Canceled || typed.TimedOut {
					receipt.Outcome = "unknown"
					pullErr = opError("mutation_outcome_unknown",
						"The image pull session ended before a successful Docker exit; reconciliation is required.",
						nil, map[string]any{"receipt": receipt})
					reconciliationRequired = true
				} else {
					pullErr = opError("image_pull_failed", "Docker CLI image pull failed.", nil, map[string]any{
						"receipt": receipt,
					})
				}
				emitDomainCompleted(emit, receipt, pullErr)
				emitReconciliation(emit, receipt, reconciliationRequired)
			}
		}
		if emit != nil {
			emit(event, payload)
		}
	}
	// Same rule as session.start: an image pull outlives the images.action request that
	// began it, and is controlled through session.cancel and its own timeout. Inheriting the
	// request context would kill the pull the moment images.action returned.
	session, err := s.sessions.start(context.WithoutCancel(parent), SessionStartParams{
		Context: params.Context, Argv: []string{"image", "pull", params.Reference},
		Cwd: params.Cwd, Mode: "pipes", TimeoutSeconds: params.TimeoutSeconds,
		OutputWindowBytes: params.OutputWindowBytes, MaxOutputBytes: params.MaxOutputBytes,
	}, wrappedEmit)
	if err != nil {
		return ImagesActionResult{}, err
	}
	if operationID == "" {
		operationID = session.SessionID
	}
	receipt := DomainOperationReceipt{
		OperationID: operationID, Context: params.Context, Domain: "image",
		ResourceID: params.Reference, Action: "pull", Source: "cli-session",
		Outcome: "running", StartedAt: session.StartedAt,
	}
	return ImagesActionResult{Action: "pull", Receipt: receipt, Session: &session}, nil
}

func (s *Service) imagesActionCLI(parent context.Context, params ImagesActionParams, receipt DomainOperationReceipt, emit EventEmitter) (ImagesActionResult, error) {
	receipt.Source = "cli"
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()

	// Built without the context prefix so it can go through runDockerValidated, which applies
	// the same argv checks as operator-supplied argv and then pins the context itself.
	args := []string{"image"}
	switch params.Action {
	case "remove":
		// No tag selected: the immutable ID is the target and cannot be re-pointed, so the
		// reference re-resolution guard below does not apply.
		if params.Reference == "" {
			args = append(args, "rm")
			if params.Force {
				args = append(args, "--force")
			}
			if params.NoPrune {
				args = append(args, "--no-prune")
			}
			args = append(args, params.ID)
			break
		}
		inspect, inspectErr := s.runDockerValidated(ctx, params.Context,
			[]string{"image", "inspect", "--format", "{{.Id}}", params.Reference},
			domainCLIOutputLimit)
		if inspectErr != nil {
			return ImagesActionResult{}, failDomainMutation(receipt, inspectErr, emit)
		}
		if inspect.timedOut || errors.Is(ctx.Err(), context.Canceled) {
			return ImagesActionResult{}, failDomainMutation(receipt,
				opError("image_reference_inspect_timeout",
					"Docker CLI timed out while verifying the selected image reference.", context.DeadlineExceeded, nil), emit)
		}
		if inspect.exitCode != 0 {
			return ImagesActionResult{}, failDomainMutation(receipt,
				opError("image_reference_inspect_failed",
					"Docker CLI could not verify the selected image reference before removal.", nil,
					map[string]any{"exitCode": inspect.exitCode, "stderr": string(inspect.stderr)}), emit)
		}
		observedID := strings.TrimSpace(string(inspect.stdout))
		if !strings.EqualFold(observedID, params.ID) {
			return ImagesActionResult{}, failDomainMutation(receipt,
				opError("image_reference_changed",
					"The selected tag no longer refers to the image shown. Refresh before removing it.",
					nil, map[string]any{
						"expectedImageId": params.ID,
						"observedImageId": observedID,
						"reference":       params.Reference,
					}), emit)
		}
		args = append(args, "rm")
		if params.Force {
			args = append(args, "--force")
		}
		if params.NoPrune {
			args = append(args, "--no-prune")
		}
		args = append(args, params.Reference)
	case "tag":
		// `docker image tag <source> <target>`; the source is the immutable ID for the same
		// reason the Engine path uses it — a tag can move out from under the operator.
		args = append(args, "tag", params.ID, params.Reference)
	case "prune":
		args = append(args, "prune", "--force")
		for _, key := range sortedMapKeys(params.Filters) {
			for _, value := range params.Filters[key] {
				if key == "dangling" {
					if value == "false" {
						args = append(args, "--all")
					}
					continue
				}
				args = append(args, "--filter", key+"="+value)
			}
		}
	}
	result, runErr := s.runDockerValidated(ctx, params.Context, args, domainCLIOutputLimit)
	receipt.Stdout = string(result.stdout)
	receipt.Stderr = string(result.stderr)
	exitCode := result.exitCode
	receipt.ExitCode = &exitCode
	if runErr != nil {
		return ImagesActionResult{}, failDomainMutation(receipt, runErr, emit)
	}
	if result.timedOut || errors.Is(ctx.Err(), context.Canceled) {
		return ImagesActionResult{}, failSubmittedMutation(receipt, context.DeadlineExceeded, emit)
	}
	if result.exitCode != 0 {
		return ImagesActionResult{}, failDomainMutation(receipt,
			opError("image_action_failed", "Docker CLI rejected the image mutation.", nil, nil), emit)
	}
	succeedDomainMutation(&receipt, emit)
	return ImagesActionResult{Action: params.Action, Receipt: receipt}, nil
}

func (s *Service) volumesAction(parent context.Context, params VolumesActionParams, emit EventEmitter) (VolumesActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return VolumesActionResult{}, err
	}
	params.Context = contextName
	if err := validateVolumesAction(params); err != nil {
		return VolumesActionResult{}, err
	}
	operationID, err := operationID()
	if err != nil {
		return VolumesActionResult{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	resourceID := params.Name
	if params.Action == "prune" {
		resourceID = "volumes"
	}
	receipt := newDomainReceipt(operationID, contextName, "volume", resourceID, params.Action, "engine-api")
	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			receipt.Source = "cli"
			emitDomainStarted(emit, "volumes.action", receipt)
			return s.volumesActionCLI(parent, params, receipt, emit)
		}
		emitDomainStarted(emit, "volumes.action", receipt)
		return VolumesActionResult{}, failDomainMutation(receipt, err, emit)
	}
	receipt.EndpointHash = endpoint.endpointHash
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			receipt.Source = "cli"
			receipt.EndpointHash = ""
			emitDomainStarted(emit, "volumes.action", receipt)
			return s.volumesActionCLI(parent, params, receipt, emit)
		}
		emitDomainStarted(emit, "volumes.action", receipt)
		return VolumesActionResult{}, failDomainMutation(receipt, err, emit)
	}
	emitDomainStarted(emit, "volumes.action", receipt)

	method := http.MethodPost
	path := ""
	var requestBody io.Reader
	switch params.Action {
	case "create":
		payload, marshalErr := json.Marshal(map[string]any{
			"Name": params.Name, "Driver": params.Driver,
			"DriverOpts": nonNilMap(params.DriverOpts), "Labels": nonNilMap(params.Labels),
		})
		if marshalErr != nil {
			return VolumesActionResult{}, failDomainMutation(receipt, marshalErr, emit)
		}
		requestBody = bytes.NewReader(payload)
		path = "/v" + client.apiVersion + "/volumes/create"
	case "remove":
		method = http.MethodDelete
		values := url.Values{}
		values.Set("force", strconv.FormatBool(params.Force))
		path = "/v" + client.apiVersion + "/volumes/" + url.PathEscape(params.Name) + "?" + values.Encode()
	case "prune":
		path = "/v" + client.apiVersion + "/volumes/prune?" + encodedFilters(params.Filters)
	}
	status, body, requestErr := client.request(ctx, method, path, requestBody)
	receipt.HTTPStatus = status
	if requestErr != nil {
		return VolumesActionResult{}, failSubmittedMutation(receipt, requestErr, emit)
	}
	if status < 200 || status >= 300 {
		return VolumesActionResult{}, failDomainMutation(receipt,
			engineHTTPError("volume_action_failed", "Docker Engine rejected the volume mutation.", status, body), emit)
	}
	result := VolumesActionResult{Action: params.Action}
	switch params.Action {
	case "create":
		var raw engineVolume
		if err := json.Unmarshal(body, &raw); err != nil {
			return VolumesActionResult{}, failAcknowledgedMutation(receipt,
				opError("volume_action_invalid", "Docker Engine returned invalid volume creation JSON.", err, nil), emit)
		}
		projected := projectVolume(raw)
		result.Volume = &projected
	case "prune":
		var raw struct {
			VolumesDeleted []string `json:"VolumesDeleted"`
			SpaceReclaimed uint64   `json:"SpaceReclaimed"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return VolumesActionResult{}, failAcknowledgedMutation(receipt,
				opError("volume_action_invalid", "Docker Engine returned invalid volume prune JSON.", err, nil), emit)
		}
		result.Prune = &VolumePruneResult{
			VolumesDeleted: nonNilStrings(raw.VolumesDeleted), SpaceReclaimed: raw.SpaceReclaimed,
		}
	}
	succeedDomainMutation(&receipt, emit)
	result.Receipt = receipt
	return result, nil
}

func (s *Service) volumesActionCLI(parent context.Context, params VolumesActionParams, receipt DomainOperationReceipt, emit EventEmitter) (VolumesActionResult, error) {
	receipt.Source = "cli"
	args := withContext(params.Context, "volume")
	switch params.Action {
	case "create":
		args = append(args, "create")
		if params.Driver != "" {
			args = append(args, "--driver", params.Driver)
		}
		for _, key := range sortedMapKeys(params.DriverOpts) {
			args = append(args, "--opt", key+"="+params.DriverOpts[key])
		}
		for _, key := range sortedMapKeys(params.Labels) {
			args = append(args, "--label", key+"="+params.Labels[key])
		}
		args = append(args, params.Name)
	case "remove":
		args = append(args, "rm")
		if params.Force {
			args = append(args, "--force")
		}
		args = append(args, params.Name)
	case "prune":
		args = append(args, "prune", "--force")
		for _, key := range sortedMapKeys(params.Filters) {
			for _, value := range params.Filters[key] {
				if key == "all" {
					if value == "true" {
						args = append(args, "--all")
					}
					continue
				}
				args = append(args, "--filter", key+"="+value)
			}
		}
	}
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	result, runErr := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
	receipt.Stdout = string(result.stdout)
	receipt.Stderr = string(result.stderr)
	exitCode := result.exitCode
	receipt.ExitCode = &exitCode
	if runErr != nil {
		return VolumesActionResult{}, failDomainMutation(receipt, runErr, emit)
	}
	if result.timedOut || errors.Is(ctx.Err(), context.Canceled) {
		return VolumesActionResult{}, failSubmittedMutation(receipt, context.DeadlineExceeded, emit)
	}
	if result.exitCode != 0 {
		return VolumesActionResult{}, failDomainMutation(receipt,
			opError("volume_action_failed", "Docker CLI rejected the volume mutation.", nil, nil), emit)
	}
	succeedDomainMutation(&receipt, emit)
	return VolumesActionResult{Action: params.Action, Receipt: receipt}, nil
}

func validateImagesAction(params ImagesActionParams) error {
	switch params.Action {
	case "remove":
		if err := validateImageID(params.ID); err != nil {
			return err
		}
		// Reference is optional. A dangling image has no repo tag at all, so requiring one made
		// every untagged image structurally unremovable. When it is absent the immutable ID is
		// the target directly and there is no tag to re-resolve.
		if params.Reference != "" {
			if err := validateImageReference(params.Reference); err != nil {
				return err
			}
		}
		if !params.Confirmed {
			target := params.Reference
			if target == "" {
				target = params.ID
			}
			return confirmationRequired("image", target, params.Action)
		}
		if len(params.Filters) > 0 || params.Cwd != "" ||
			params.TimeoutSeconds != 0 || params.OutputWindowBytes != 0 || params.MaxOutputBytes != 0 {
			return opError("invalid_action_options", "Image remove received options for another action.", nil, nil)
		}
	case "tag":
		// Addressed by immutable ID, like remove: a tag can be moved between the list being
		// rendered and the operator acting on it, so a tag is not a safe way to name a source.
		if err := validateImageID(params.ID); err != nil {
			return err
		}
		if err := validateImageReference(params.Reference); err != nil {
			return err
		}
		if repository, _ := splitImageReference(params.Reference); repository == "" {
			return opError("invalid_image_reference", "Image tag requires a repository.", nil, nil)
		}
		if params.Force || params.NoPrune || params.Confirmed || len(params.Filters) > 0 ||
			params.ArchivePath != "" || params.Cwd != "" || params.TimeoutSeconds != 0 ||
			params.OutputWindowBytes != 0 || params.MaxOutputBytes != 0 {
			return opError("invalid_action_options", "Image tag received options for another action.", nil, nil)
		}
	case "save", "load":
		// Path validation happens in the handler, which owns the existence and overwrite
		// checks. `confirmed` belongs to the destructive Docker-side verbs; an archive write is
		// gated by `overwrite` instead, which names the specific thing being agreed to.
		if params.Confirmed || len(params.Filters) > 0 {
			return opError("invalid_action_options", "Image archive actions received options for another action.", nil, nil)
		}
		if params.Action == "load" && params.Overwrite {
			return opError("invalid_action_options",
				"Image load reads an archive and never writes one.", nil, nil)
		}
		if params.Action == "save" && params.Reference == "" {
			return opError("invalid_action_options", "Image save requires a reference.", nil, nil)
		}
		// load learns its images from the archive. Accepting a reference here and ignoring it
		// made the core the most permissive layer, which is the wrong direction: both JS
		// validators and the schema already reject it.
		if params.Action == "load" && params.Reference != "" {
			return opError("invalid_action_options",
				"Image load reads its images from the archive and takes no reference.", nil, nil)
		}
		if params.Reference != "" {
			if err := validateImageReference(params.Reference); err != nil {
				return err
			}
		}
	case "prune":
		if !params.Confirmed {
			return confirmationRequired("image", "images", params.Action)
		}
		if err := validateFilters(params.Filters, map[string]bool{
			"dangling": true, "until": true, "label": true, "label!": true,
		}); err != nil {
			return err
		}
		if err := validateBooleanFilter(params.Filters, "dangling"); err != nil {
			return err
		}
		if params.ID != "" || params.Reference != "" || params.Force || params.NoPrune ||
			params.Cwd != "" || params.TimeoutSeconds != 0 || params.OutputWindowBytes != 0 || params.MaxOutputBytes != 0 {
			return opError("invalid_action_options", "Image prune received options for another action.", nil, nil)
		}
	case "push":
		if err := validateImageReference(params.Reference); err != nil {
			return err
		}
		// Pushing publishes an image to a remote that may be public, and the destination is
		// derived from the reference rather than chosen separately — so the wrong tag is a
		// disclosure, not just a failed command. It is confirmed like any other verb whose
		// effect cannot be taken back.
		if !params.Confirmed {
			return confirmationRequired("image", params.Reference, params.Action)
		}
		if params.ID != "" || params.Force || params.NoPrune || len(params.Filters) > 0 ||
			params.ArchivePath != "" || params.Overwrite {
			return opError("invalid_action_options", "Image push received options for another action.", nil, nil)
		}
	case "pull":
		if err := validateImageReference(params.Reference); err != nil {
			return err
		}
		if params.ID != "" || params.Force || params.NoPrune || len(params.Filters) > 0 || params.Confirmed {
			return opError("invalid_action_options", "Image pull received options for another action.", nil, nil)
		}
		if params.TimeoutSeconds < 0 || params.TimeoutSeconds > 86400 {
			return opError("invalid_timeout", "Image pull timeout must be between 0 and 86400 seconds.", nil, nil)
		}
	default:
		return opError("unsupported_image_action", "Image action is not in the mutation allowlist.", nil, map[string]any{"action": params.Action})
	}
	return nil
}

func validateVolumesAction(params VolumesActionParams) error {
	switch params.Action {
	case "create":
		if err := validateVolumeName(params.Name); err != nil {
			return err
		}
		if len(params.Driver) > 4096 || strings.ContainsAny(params.Driver, "\x00\r\n") {
			return opError("invalid_action_options", "Volume driver is too long or contains control characters.", nil, nil)
		}
		if err := validateStringMap(params.DriverOpts, "driverOpts"); err != nil {
			return err
		}
		if err := validateStringMap(params.Labels, "labels"); err != nil {
			return err
		}
		if params.Force || len(params.Filters) > 0 || params.Confirmed {
			return opError("invalid_action_options", "Volume create received options for another action.", nil, nil)
		}
	case "remove":
		if err := validateVolumeName(params.Name); err != nil {
			return err
		}
		if !params.Confirmed {
			return confirmationRequired("volume", params.Name, params.Action)
		}
		if params.Driver != "" || len(params.DriverOpts) > 0 || len(params.Labels) > 0 || len(params.Filters) > 0 {
			return opError("invalid_action_options", "Volume remove received options for another action.", nil, nil)
		}
	case "prune":
		if !params.Confirmed {
			return confirmationRequired("volume", "volumes", params.Action)
		}
		if err := validateFilters(params.Filters, map[string]bool{"label": true, "label!": true, "all": true}); err != nil {
			return err
		}
		if err := validateBooleanFilter(params.Filters, "all"); err != nil {
			return err
		}
		if params.Name != "" || params.Driver != "" || len(params.DriverOpts) > 0 || len(params.Labels) > 0 || params.Force {
			return opError("invalid_action_options", "Volume prune received options for another action.", nil, nil)
		}
	default:
		return opError("unsupported_volume_action", "Volume action is not in the mutation allowlist.", nil, map[string]any{"action": params.Action})
	}
	return nil
}

func validateImageID(id string) error {
	if !strings.HasPrefix(id, "sha256:") || len(id) != len("sha256:")+64 {
		return opError("invalid_image_id", "A full immutable sha256 image ID is required.", nil, map[string]any{"length": len(id)})
	}
	for _, char := range id[len("sha256:"):] {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return opError("invalid_image_id", "Image ID digest must be hexadecimal.", nil, nil)
		}
	}
	return nil
}

func validateImageReference(reference string) error {
	if reference == "" || len(reference) > 2048 || strings.HasPrefix(reference, "-") ||
		strings.ContainsAny(reference, "\x00\r\n\t ") {
		return opError("invalid_image_reference", "Image reference must be a single non-option Docker reference.", nil, nil)
	}
	return nil
}

// splitImageReference separates a Docker reference into the repository and tag the Engine's
// tag endpoint wants as separate query parameters. A colon only introduces a tag when it
// appears in the final path segment — `registry.example:5000/team/api` is a host and port,
// not a tag — and a digest is not a tag at all.
func splitImageReference(reference string) (string, string) {
	lastSlash := strings.LastIndex(reference, "/")
	final := reference[lastSlash+1:]
	if at := strings.Index(final, "@"); at >= 0 {
		return reference[:lastSlash+1] + final[:at], ""
	}
	colon := strings.LastIndex(final, ":")
	if colon < 0 {
		return reference, ""
	}
	return reference[:lastSlash+1] + final[:colon], final[colon+1:]
}

func validateVolumeName(name string) error {
	if len(name) == 0 || len(name) > 255 {
		return opError("invalid_volume_name", "Volume name must contain between 1 and 255 characters.", nil, nil)
	}
	for index, char := range name {
		valid := char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' ||
			char >= '0' && char <= '9' || index > 0 && (char == '_' || char == '.' || char == '-')
		if !valid {
			return opError("invalid_volume_name", "Volume name contains unsupported characters.", nil, nil)
		}
	}
	return nil
}

func validateFilters(filters map[string][]string, allowed map[string]bool) error {
	if len(filters) > 32 {
		return opError("invalid_filters", "Too many prune filter keys were supplied.", nil, nil)
	}
	for key, values := range filters {
		if !allowed[key] {
			return opError("invalid_filters", "Prune filter key is not in the allowlist.", nil, map[string]any{"filter": key})
		}
		if len(values) == 0 || len(values) > 64 {
			return opError("invalid_filters", "Each prune filter requires between 1 and 64 values.", nil, map[string]any{"filter": key})
		}
		for _, value := range values {
			if len(value) == 0 || len(value) > 4096 || strings.ContainsAny(value, "\x00\r\n") {
				return opError("invalid_filters", "Prune filter value is empty, too long, or contains control characters.", nil, map[string]any{"filter": key})
			}
		}
	}
	return nil
}

func validateBooleanFilter(filters map[string][]string, key string) error {
	values, exists := filters[key]
	if !exists {
		return nil
	}
	if len(values) != 1 || values[0] != "true" && values[0] != "false" {
		return opError(
			"invalid_filters",
			"Boolean prune filters require exactly one literal true or false value.",
			nil,
			map[string]any{"filter": key},
		)
	}
	return nil
}

func validateStringMap(values map[string]string, field string) error {
	if len(values) > 256 {
		return opError("invalid_action_options", "Action map contains too many entries.", nil, map[string]any{"field": field})
	}
	for key, value := range values {
		if key == "" || len(key) > 4096 || len(value) > 65536 ||
			strings.ContainsAny(key, "\x00\r\n") || strings.ContainsAny(value, "\x00\r\n") {
			return opError("invalid_action_options", "Action map contains an invalid key or value.", nil, map[string]any{"field": field})
		}
	}
	return nil
}

func confirmationRequired(domain, resource, action string) error {
	return opError("confirmation_required", "Destructive mutation requires confirmed=true.", nil, map[string]any{
		"domain": domain, "resourceId": resource, "action": action,
	})
}

func nativeTransportRequired(method, contextName string, cause error) error {
	return opError("context_transport_unsupported",
		"This structured method requires a directly reachable Unix Docker Engine endpoint for the selected context.",
		cause, map[string]any{
			"method": method, "context": contextName,
			"reason": "The Docker CLI does not expose equivalent exact numeric fields as structured JSON for this method.",
		})
}

func newDomainReceipt(operationID, contextName, domain, resourceID, action, source string) DomainOperationReceipt {
	return DomainOperationReceipt{
		OperationID: operationID, Context: contextName, Domain: domain, ResourceID: resourceID,
		Action: action, Source: source, Outcome: "pending", StartedAt: nowUTC(),
	}
}

func finishDomainReceipt(receipt *DomainOperationReceipt) {
	completed := time.Now().UTC()
	receipt.CompletedAt = completed.Format(time.RFC3339Nano)
	started, err := time.Parse(time.RFC3339Nano, receipt.StartedAt)
	if err == nil {
		receipt.DurationMs = completed.Sub(started).Milliseconds()
	}
}

func emitDomainStarted(emit EventEmitter, method string, receipt DomainOperationReceipt) {
	if emit == nil {
		return
	}
	emit("operation.started", map[string]any{
		"operationId": receipt.OperationID, "method": method, "context": receipt.Context,
		"domain": receipt.Domain, "resourceId": receipt.ResourceID, "action": receipt.Action,
		"source": receipt.Source, "startedAt": receipt.StartedAt,
	})
}

func emitDomainCompleted(emit EventEmitter, receipt DomainOperationReceipt, err error) {
	if emit == nil {
		return
	}
	payload := map[string]any{"receipt": receipt}
	if err != nil {
		payload["error"] = AsOpError(err)
	}
	emit("operation.completed", payload)
}

func emitReconciliation(emit EventEmitter, receipt DomainOperationReceipt, required bool) {
	if emit == nil {
		return
	}
	event := "reconciliation.requested"
	reason := "mutation_completed"
	if required {
		event = "reconciliation.required"
		reason = "mutation_outcome_unknown"
	}
	emit(event, map[string]any{
		"operationId": receipt.OperationID, "context": receipt.Context, "domain": receipt.Domain,
		"resourceId": receipt.ResourceID, "action": receipt.Action, "reason": reason,
	})
}

func succeedDomainMutation(receipt *DomainOperationReceipt, emit EventEmitter) {
	receipt.Outcome = "succeeded"
	finishDomainReceipt(receipt)
	emitDomainCompleted(emit, *receipt, nil)
	emitReconciliation(emit, *receipt, false)
}

func failDomainMutation(receipt DomainOperationReceipt, cause error, emit EventEmitter) error {
	receipt.Outcome = "failed"
	finishDomainReceipt(&receipt)
	typed := AsOpError(cause)
	details := cloneDetails(typed.Details)
	details["receipt"] = receipt
	err := opError(typed.Code, typed.Message, cause, details)
	emitDomainCompleted(emit, receipt, err)
	return err
}

func failSubmittedMutation(receipt DomainOperationReceipt, cause error, emit EventEmitter) error {
	typed := AsOpError(cause)
	receipt.Outcome = "failed"
	code := typed.Code
	message := typed.Message
	if errors.Is(cause, context.DeadlineExceeded) || errors.Is(cause, context.Canceled) || typed.Code == "engine_timeout" {
		receipt.Outcome = "unknown"
		code = "mutation_outcome_unknown"
		message = "The mutation request ended after submission; its outcome is unknown and reconciliation is required."
	}
	finishDomainReceipt(&receipt)
	err := opError(code, message, cause, map[string]any{"receipt": receipt})
	emitDomainCompleted(emit, receipt, err)
	if receipt.Outcome == "unknown" {
		emitReconciliation(emit, receipt, true)
	}
	return err
}

func failAcknowledgedMutation(receipt DomainOperationReceipt, cause error, emit EventEmitter) error {
	receipt.Outcome = "unknown"
	finishDomainReceipt(&receipt)
	typed := AsOpError(cause)
	err := opError("mutation_outcome_unknown",
		"Docker acknowledged the mutation, but its result could not be decoded; reconciliation is required.",
		cause, map[string]any{
			"receipt": receipt, "responseError": typed,
		})
	emitDomainCompleted(emit, receipt, err)
	emitReconciliation(emit, receipt, true)
	return err
}

func cloneDetails(source map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range source {
		result[key] = value
	}
	return result
}

func encodedFilters(filters map[string][]string) string {
	data, _ := json.Marshal(filters)
	values := url.Values{}
	values.Set("filters", string(data))
	return values.Encode()
}

func appendFilterFlags(args []string, filters map[string][]string) []string {
	for _, key := range sortedMapKeys(filters) {
		for _, value := range filters[key] {
			args = append(args, "--filter", key+"="+value)
		}
	}
	return args
}

func appendUnique(values []string, additions ...string) []string {
	seen := make(map[string]bool, len(values)+len(additions))
	for _, value := range values {
		seen[value] = true
	}
	for _, value := range additions {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		values = append(values, value)
	}
	return values
}

func sortedMapKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortImages(images []ImageProjection) {
	sort.Slice(images, func(i, j int) bool {
		left := images[i].ID
		right := images[j].ID
		if len(images[i].RepoTags) > 0 {
			left = images[i].RepoTags[0] + "\x00" + left
		}
		if len(images[j].RepoTags) > 0 {
			right = images[j].RepoTags[0] + "\x00" + right
		}
		return left < right
	})
}

func sortVolumes(volumes []VolumeProjection) {
	sort.Slice(volumes, func(i, j int) bool { return volumes[i].Name < volumes[j].Name })
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nonNilMap(values map[string]string) map[string]string {
	if values == nil {
		return map[string]string{}
	}
	return values
}

func nonNilImageDeletes(values []ImageDeleteRecord) []ImageDeleteRecord {
	if values == nil {
		return []ImageDeleteRecord{}
	}
	return values
}

func splitJSONLines(data []byte) [][]byte {
	lines := [][]byte{}
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) > 0 {
			lines = append(lines, line)
		}
	}
	return lines
}

func cloneJSON(data []byte) json.RawMessage {
	return json.RawMessage(bytes.Clone(data))
}

func positiveDelta(current, previous uint64) uint64 {
	if current <= previous {
		return 0
	}
	return current - previous
}

func (r DomainOperationReceipt) String() string {
	return fmt.Sprintf("%s/%s/%s", r.Domain, r.Action, r.OperationID)
}

// systemPrune reproduces `docker system prune`. The Engine has no single endpoint for it;
// the CLI issues one prune per resource, so this does the same and reports each stage
// separately rather than collapsing them into one opaque total.
//
// Order matches Docker's: containers first (which frees the images and volumes they held),
// then networks, then images, then build cache, with volumes last and only on request.
func (s *Service) systemAction(parent context.Context, params SystemActionParams, emit EventEmitter) (SystemActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return SystemActionResult{}, err
	}
	if params.Action != "prune" {
		return SystemActionResult{}, opError("unsupported_system_action",
			"System action is not in the mutation allowlist.", nil,
			map[string]any{"action": params.Action})
	}
	if !params.Confirmed {
		return SystemActionResult{}, confirmationRequired("system", "system", params.Action)
	}

	operationID, err := operationID()
	if err != nil {
		return SystemActionResult{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	receipt := newDomainReceipt(operationID, contextName, "system", "system", "prune", "engine-api")

	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return SystemActionResult{}, nativeTransportRequired("system.action", contextName, err)
		}
		emitDomainStarted(emit, "system.action", receipt)
		return SystemActionResult{}, failDomainMutation(receipt, err, emit)
	}
	receipt.EndpointHash = endpoint.endpointHash
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return SystemActionResult{}, nativeTransportRequired("system.action", contextName, err)
		}
		emitDomainStarted(emit, "system.action", receipt)
		return SystemActionResult{}, failDomainMutation(receipt, err, emit)
	}
	emitDomainStarted(emit, "system.action", receipt)

	type pruneTarget struct {
		resource string
		path     string
		// deletedField names the array the daemon returns for this resource.
		deletedField string
	}
	targets := []pruneTarget{
		{resource: "containers", path: "/containers/prune", deletedField: "ContainersDeleted"},
		{resource: "networks", path: "/networks/prune", deletedField: "NetworksDeleted"},
	}
	imagePath := "/images/prune?" + encodedFilters(map[string][]string{
		// dangling=false is Docker's `--all`; dangling=true is the default untagged-only prune.
		"dangling": {strconv.FormatBool(!params.All)},
	})
	targets = append(targets,
		pruneTarget{resource: "images", path: imagePath, deletedField: "ImagesDeleted"},
		pruneTarget{resource: "build-cache", path: "/build/prune", deletedField: "CachesDeleted"},
	)
	if params.Volumes {
		targets = append(targets, pruneTarget{
			resource: "volumes", path: "/volumes/prune", deletedField: "VolumesDeleted",
		})
	}

	result := SystemActionResult{
		Context: contextName, Action: "prune", Source: "engine-api",
		Stages: []SystemPruneStage{}, ObservedAt: nowUTC(),
	}
	for _, target := range targets {
		stage := SystemPruneStage{Resource: target.resource, Deleted: []string{}}
		status, body, requestErr := client.request(
			ctx, http.MethodPost, "/v"+client.apiVersion+target.path, nil,
		)
		switch {
		case requestErr != nil:
			stage.Error = AsOpError(requestErr).Message
		case status < 200 || status >= 300:
			stage.Error = engineHTTPError("system_prune_failed",
				"Docker Engine rejected the prune request.", status, body).Error()
		default:
			stage.Deleted, stage.SpaceReclaimed = decodePruneReport(body, target.deletedField)
			result.SpaceReclaimedBytes += stage.SpaceReclaimed
		}
		result.Stages = append(result.Stages, stage)
	}

	// A stage failure is reported rather than thrown: the stages that did run already
	// mutated the daemon, so the caller must reconcile either way.
	succeedDomainMutation(&receipt, emit)
	result.Receipt = receipt
	return result, nil
}

// decodePruneReport reads the two shapes Docker's prune endpoints return: a list of deleted
// identifiers under a resource-specific key, and SpaceReclaimed.
func decodePruneReport(body []byte, deletedField string) ([]string, uint64) {
	var report map[string]json.RawMessage
	if err := json.Unmarshal(body, &report); err != nil {
		return []string{}, 0
	}
	deleted := []string{}
	if raw, ok := report[deletedField]; ok {
		var names []string
		if err := json.Unmarshal(raw, &names); err == nil {
			deleted = nonNilStrings(names)
		} else {
			// Image prune returns objects with Untagged/Deleted rather than plain strings.
			var records []struct {
				Untagged string `json:"Untagged"`
				Deleted  string `json:"Deleted"`
			}
			if err := json.Unmarshal(raw, &records); err == nil {
				for _, record := range records {
					if record.Untagged != "" {
						deleted = append(deleted, record.Untagged)
						continue
					}
					if record.Deleted != "" {
						deleted = append(deleted, record.Deleted)
					}
				}
			}
		}
	}
	var reclaimed uint64
	if raw, ok := report["SpaceReclaimed"]; ok {
		_ = json.Unmarshal(raw, &reclaimed)
	}
	return deleted, reclaimed
}

// Docker's three predefined networks cannot be removed; the daemon rejects the attempt.
var predefinedNetworks = map[string]bool{"bridge": true, "host": true, "none": true}

type engineNetwork struct {
	Name       string            `json:"Name"`
	ID         string            `json:"Id"`
	Created    string            `json:"Created"`
	Scope      string            `json:"Scope"`
	Driver     string            `json:"Driver"`
	EnableIPv6 bool              `json:"EnableIPv6"`
	Internal   bool              `json:"Internal"`
	Attachable bool              `json:"Attachable"`
	Ingress    bool              `json:"Ingress"`
	Labels     map[string]string `json:"Labels"`
	Options    map[string]string `json:"Options"`
	IPAM       struct {
		Driver string `json:"Driver"`
		Config []struct {
			Subnet  string `json:"Subnet"`
			Gateway string `json:"Gateway"`
		} `json:"Config"`
	} `json:"IPAM"`
	Containers map[string]json.RawMessage `json:"Containers"`
}

func projectNetwork(raw engineNetwork) NetworkSummary {
	summary := NetworkSummary{
		ID: raw.ID, Name: raw.Name, Driver: raw.Driver, Scope: raw.Scope,
		Created: raw.Created, Internal: raw.Internal, Attachable: raw.Attachable,
		Ingress: raw.Ingress, EnableIPv6: raw.EnableIPv6,
		IPAMDriver: raw.IPAM.Driver,
		Subnets:    []string{}, Gateways: []string{},
		Labels: nonNilMap(raw.Labels), Options: nonNilMap(raw.Options),
		Predefined: predefinedNetworks[raw.Name],
		// The list endpoint does not report attachments; only inspect does.
		ContainerCount: -1,
	}
	for _, config := range raw.IPAM.Config {
		if config.Subnet != "" {
			summary.Subnets = append(summary.Subnets, config.Subnet)
		}
		if config.Gateway != "" {
			summary.Gateways = append(summary.Gateways, config.Gateway)
		}
	}
	if raw.Containers != nil {
		summary.ContainerCount = len(raw.Containers)
	}
	return summary
}

func (s *Service) networksList(parent context.Context, params NetworksListParams) (NetworksListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return NetworksListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.networksListCLI(ctx, contextName)
		}
		return NetworksListResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.networksListCLI(ctx, contextName)
		}
		return NetworksListResult{}, err
	}
	status, body, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/networks", nil)
	if err != nil {
		return NetworksListResult{}, err
	}
	if status < 200 || status >= 300 {
		return NetworksListResult{}, engineHTTPError("networks_list_failed", "Docker Engine rejected the network list request.", status, body)
	}
	var raw []engineNetwork
	if err := json.Unmarshal(body, &raw); err != nil {
		return NetworksListResult{}, opError("networks_list_invalid", "Docker Engine returned invalid network JSON.", err, map[string]any{
			"context": contextName,
		})
	}
	networks := make([]NetworkSummary, 0, len(raw))
	for _, item := range raw {
		networks = append(networks, projectNetwork(item))
	}
	sortNetworks(networks)
	return NetworksListResult{
		Context: contextName, Source: "engine-api", APIVersion: client.apiVersion,
		Networks: networks, ObservedAt: nowUTC(), EndpointHash: endpoint.endpointHash,
		Limitations: []string{"The network list endpoint does not report container attachments; open a network to inspect them."},
	}, nil
}

func (s *Service) networksListCLI(ctx context.Context, contextName string) (NetworksListResult, error) {
	args := withContext(contextName, "network", "ls", "--format", "{{json .}}", "--no-trunc")
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, domainCLIOutputLimit)
	if err != nil {
		return NetworksListResult{}, err
	}
	if result.exitCode != 0 {
		return NetworksListResult{}, opError("networks_list_failed", "Docker CLI could not list networks.", nil, map[string]any{
			"exitCode": result.exitCode, "stderr": string(result.stderr),
		})
	}
	networks := []NetworkSummary{}
	for _, line := range splitJSONLines(result.stdout) {
		var row struct {
			ID     string `json:"ID"`
			Name   string `json:"Name"`
			Driver string `json:"Driver"`
			Scope  string `json:"Scope"`
			IPv6   string `json:"IPv6"`
			Labels string `json:"Labels"`
		}
		if err := json.Unmarshal(line, &row); err != nil {
			continue
		}
		networks = append(networks, NetworkSummary{
			ID: row.ID, Name: row.Name, Driver: row.Driver, Scope: row.Scope,
			EnableIPv6: strings.EqualFold(row.IPv6, "true"),
			Subnets:    []string{}, Gateways: []string{},
			Labels: map[string]string{}, Options: map[string]string{},
			Predefined: predefinedNetworks[row.Name], ContainerCount: -1,
		})
	}
	sortNetworks(networks)
	return NetworksListResult{
		Context: contextName, Source: "cli-json", Networks: networks, ObservedAt: nowUTC(),
		Limitations: []string{"Remote CLI JSON does not expose IPAM subnets, options or structured labels."},
	}, nil
}

func sortNetworks(networks []NetworkSummary) {
	sort.Slice(networks, func(i, j int) bool {
		// Predefined networks last: they are never actionable and would otherwise sit at the
		// top of every list.
		if networks[i].Predefined != networks[j].Predefined {
			return !networks[i].Predefined
		}
		return networks[i].Name < networks[j].Name
	})
}

func validateNetworksAction(params NetworksActionParams) error {
	switch params.Action {
	case "create":
		if err := validateNetworkName(params.Name); err != nil {
			return err
		}
		if params.ID != "" || params.ContainerID != "" || params.Force || len(params.Filters) > 0 {
			return opError("invalid_action_options", "Network create received options for another action.", nil, nil)
		}
		if err := validateStringMap(params.Labels, "labels"); err != nil {
			return err
		}
		if err := validateStringMap(params.Options, "options"); err != nil {
			return err
		}
	case "remove":
		if err := validateNetworkID(params.ID); err != nil {
			return err
		}
		if !params.Confirmed {
			return confirmationRequired("network", params.ID, params.Action)
		}
	case "prune":
		if !params.Confirmed {
			return confirmationRequired("network", "networks", params.Action)
		}
		if params.ID != "" || params.Name != "" || params.ContainerID != "" {
			return opError("invalid_action_options", "Network prune received options for another action.", nil, nil)
		}
		if err := validateFilters(params.Filters, map[string]bool{"until": true, "label": true}); err != nil {
			return err
		}
	case "connect", "disconnect":
		if err := validateNetworkID(params.ID); err != nil {
			return err
		}
		if err := validateContainerID(params.ContainerID); err != nil {
			return err
		}
	default:
		return opError("unsupported_network_action", "Network action is not in the mutation allowlist.", nil, map[string]any{
			"action": params.Action,
		})
	}
	return nil
}

// Docker network names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*. A leading '-' is rejected explicitly
// so a name can never be read as a flag on the CLI transport.
func validateNetworkName(name string) error {
	if name == "" || len(name) > 255 {
		return opError("invalid_network_name", "Network name must be between 1 and 255 characters.", nil, nil)
	}
	for index, r := range name {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if index > 0 {
			valid = valid || r == '_' || r == '.' || r == '-'
		}
		if !valid {
			return opError("invalid_network_name", "Network name contains an unsupported character.", nil, map[string]any{
				"name": name,
			})
		}
	}
	return nil
}

func validateNetworkID(id string) error {
	if len(id) < 12 || len(id) > 64 {
		return opError("invalid_network_id", "Network ID must be a 12 to 64 character hexadecimal identifier.", nil, nil)
	}
	for _, r := range id {
		isHex := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
		if !isHex {
			return opError("invalid_network_id", "Network ID must be hexadecimal.", nil, map[string]any{"id": id})
		}
	}
	return nil
}

func (s *Service) networksAction(parent context.Context, params NetworksActionParams, emit EventEmitter) (NetworksActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return NetworksActionResult{}, err
	}
	params.Context = contextName
	if err := validateNetworksAction(params); err != nil {
		return NetworksActionResult{}, err
	}
	operationID, err := operationID()
	if err != nil {
		return NetworksActionResult{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	resourceID := params.ID
	switch params.Action {
	case "create":
		resourceID = params.Name
	case "prune":
		resourceID = "networks"
	}
	receipt := newDomainReceipt(operationID, contextName, "network", resourceID, params.Action, "engine-api")

	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return NetworksActionResult{}, nativeTransportRequired("networks.action", contextName, err)
		}
		emitDomainStarted(emit, "networks.action", receipt)
		return NetworksActionResult{}, failDomainMutation(receipt, err, emit)
	}
	receipt.EndpointHash = endpoint.endpointHash
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return NetworksActionResult{}, nativeTransportRequired("networks.action", contextName, err)
		}
		emitDomainStarted(emit, "networks.action", receipt)
		return NetworksActionResult{}, failDomainMutation(receipt, err, emit)
	}
	emitDomainStarted(emit, "networks.action", receipt)

	base := "/v" + client.apiVersion + "/networks"
	method := http.MethodPost
	path := ""
	var payload io.Reader
	switch params.Action {
	case "create":
		body := map[string]any{
			"Name": params.Name, "CheckDuplicate": true,
			"Internal": params.Internal, "Attachable": params.Attachable,
			"EnableIPv6": params.EnableIPv6,
		}
		if params.Driver != "" {
			body["Driver"] = params.Driver
		}
		if params.Subnet != "" || params.Gateway != "" {
			config := map[string]string{}
			if params.Subnet != "" {
				config["Subnet"] = params.Subnet
			}
			if params.Gateway != "" {
				config["Gateway"] = params.Gateway
			}
			body["IPAM"] = map[string]any{"Config": []map[string]string{config}}
		}
		if len(params.Labels) > 0 {
			body["Labels"] = params.Labels
		}
		if len(params.Options) > 0 {
			body["Options"] = params.Options
		}
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return NetworksActionResult{}, failDomainMutation(receipt, marshalErr, emit)
		}
		payload = bytes.NewReader(encoded)
		path = base + "/create"
	case "remove":
		method = http.MethodDelete
		path = base + "/" + url.PathEscape(params.ID)
	case "prune":
		path = base + "/prune?" + encodedFilters(params.Filters)
	case "connect", "disconnect":
		body := map[string]any{"Container": params.ContainerID}
		if params.Action == "disconnect" {
			body["Force"] = params.Force
		}
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return NetworksActionResult{}, failDomainMutation(receipt, marshalErr, emit)
		}
		payload = bytes.NewReader(encoded)
		path = base + "/" + url.PathEscape(params.ID) + "/" + params.Action
	}

	status, body, requestErr := client.request(ctx, method, path, payload)
	receipt.HTTPStatus = status
	if requestErr != nil {
		return NetworksActionResult{}, failSubmittedMutation(receipt, requestErr, emit)
	}
	if status < 200 || status >= 300 {
		return NetworksActionResult{}, failDomainMutation(receipt,
			engineHTTPError("network_action_failed", "Docker Engine rejected the network mutation.", status, body), emit)
	}

	result := NetworksActionResult{Action: params.Action}
	switch params.Action {
	case "create":
		var created struct {
			ID string `json:"Id"`
		}
		if err := json.Unmarshal(body, &created); err == nil && created.ID != "" {
			result.Network = &NetworkSummary{
				ID: created.ID, Name: params.Name, Driver: params.Driver,
				Subnets: []string{}, Gateways: []string{},
				Labels: nonNilMap(params.Labels), Options: nonNilMap(params.Options),
				ContainerCount: 0,
			}
		}
	case "prune":
		var report struct {
			NetworksDeleted []string `json:"NetworksDeleted"`
		}
		_ = json.Unmarshal(body, &report)
		result.Prune = &NetworkPruneResult{NetworksDeleted: nonNilStrings(report.NetworksDeleted)}
	}
	succeedDomainMutation(&receipt, emit)
	result.Receipt = receipt
	return result, nil
}

var containerNamePattern = func(name string) bool {
	// Docker: [a-zA-Z0-9][a-zA-Z0-9_.-]*
	if name == "" || len(name) > 255 {
		return false
	}
	for index, r := range name {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if index > 0 {
			ok = ok || r == '_' || r == '.' || r == '-'
		}
		if !ok {
			return false
		}
	}
	return true
}

var allowedRestartPolicies = map[string]bool{
	"": true, "no": true, "always": true, "unless-stopped": true, "on-failure": true,
}

func validateContainersCreate(params ContainersCreateParams) error {
	reference := strings.TrimSpace(params.Image)
	if err := validateImageReference(reference); err != nil {
		return err
	}
	if params.Name != "" && !containerNamePattern(params.Name) {
		return opError("invalid_container_name", "Container name contains an unsupported character.", nil, map[string]any{
			"name": params.Name,
		})
	}
	if !allowedRestartPolicies[params.RestartPolicy] {
		return opError("invalid_restart_policy", "Restart policy is not supported.", nil, map[string]any{
			"restartPolicy": params.RestartPolicy,
		})
	}
	if params.AutoRemove && params.RestartPolicy != "" && params.RestartPolicy != "no" {
		return opError("invalid_action_options", "Auto-remove cannot be combined with a restart policy.", nil, nil)
	}
	if len(params.Command) > 256 || len(params.Env) > 512 || len(params.Binds) > 128 ||
		len(params.Ports) > 128 {
		return opError("invalid_action_options", "Container creation received too many entries.", nil, nil)
	}
	for _, entry := range params.Env {
		if !strings.Contains(entry, "=") {
			return opError("invalid_environment", "Environment entries must be KEY=VALUE.", nil, map[string]any{
				"entry": entry,
			})
		}
	}
	for host, target := range params.Ports {
		if !isNumericPort(host) {
			return opError("invalid_port", "Host port must be numeric.", nil, map[string]any{"hostPort": host})
		}
		port, proto, found := strings.Cut(target, "/")
		if !isNumericPort(port) || (found && proto != "tcp" && proto != "udp" && proto != "sctp") {
			return opError("invalid_port", "Container port must be a number with an optional tcp/udp/sctp protocol.", nil, map[string]any{
				"containerPort": target,
			})
		}
	}
	if params.Network != "" && !containerNamePattern(params.Network) {
		return opError("invalid_network_name", "Network name contains an unsupported character.", nil, nil)
	}
	return validateStringMap(params.Labels, "labels")
}

func isNumericPort(value string) bool {
	if value == "" || len(value) > 5 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// containersCreate is a structured `docker run`. It deliberately does not accept arbitrary
// argv: every field is validated and projected into the Engine's create body, so the create
// form cannot become a second, unchecked command surface.
func (s *Service) containersCreate(parent context.Context, params ContainersCreateParams, emit EventEmitter) (ContainersCreateResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainersCreateResult{}, err
	}
	if err := validateContainersCreate(params); err != nil {
		return ContainersCreateResult{}, err
	}
	operationID, err := operationID()
	if err != nil {
		return ContainersCreateResult{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	receipt := newDomainReceipt(operationID, contextName, "container", params.Name, "create", "engine-api")

	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ContainersCreateResult{}, nativeTransportRequired("containers.create", contextName, err)
		}
		emitDomainStarted(emit, "containers.create", receipt)
		return ContainersCreateResult{}, failDomainMutation(receipt, err, emit)
	}
	receipt.EndpointHash = endpoint.endpointHash
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ContainersCreateResult{}, nativeTransportRequired("containers.create", contextName, err)
		}
		emitDomainStarted(emit, "containers.create", receipt)
		return ContainersCreateResult{}, failDomainMutation(receipt, err, emit)
	}
	emitDomainStarted(emit, "containers.create", receipt)

	exposed := map[string]struct{}{}
	bindings := map[string][]map[string]string{}
	for host, target := range params.Ports {
		key := target
		if !strings.Contains(key, "/") {
			key += "/tcp"
		}
		exposed[key] = struct{}{}
		bindings[key] = append(bindings[key], map[string]string{"HostPort": host})
	}

	hostConfig := map[string]any{}
	if len(bindings) > 0 {
		hostConfig["PortBindings"] = bindings
	}
	if len(params.Binds) > 0 {
		hostConfig["Binds"] = params.Binds
	}
	if params.AutoRemove {
		hostConfig["AutoRemove"] = true
	}
	if params.RestartPolicy != "" && params.RestartPolicy != "no" {
		hostConfig["RestartPolicy"] = map[string]any{"Name": params.RestartPolicy}
	}
	if params.Network != "" {
		hostConfig["NetworkMode"] = params.Network
	}

	body := map[string]any{"Image": strings.TrimSpace(params.Image)}
	if len(params.Command) > 0 {
		body["Cmd"] = params.Command
	}
	if len(params.Env) > 0 {
		body["Env"] = params.Env
	}
	if len(params.Labels) > 0 {
		body["Labels"] = params.Labels
	}
	if len(exposed) > 0 {
		body["ExposedPorts"] = exposed
	}
	if len(hostConfig) > 0 {
		body["HostConfig"] = hostConfig
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return ContainersCreateResult{}, failDomainMutation(receipt, err, emit)
	}

	path := "/v" + client.apiVersion + "/containers/create"
	if params.Name != "" {
		path += "?name=" + url.QueryEscape(params.Name)
	}
	status, responseBody, requestErr := client.request(ctx, http.MethodPost, path, bytes.NewReader(encoded))
	receipt.HTTPStatus = status
	if requestErr != nil {
		return ContainersCreateResult{}, failSubmittedMutation(receipt, requestErr, emit)
	}
	if status < 200 || status >= 300 {
		return ContainersCreateResult{}, failDomainMutation(receipt,
			engineHTTPError("container_create_failed", "Docker Engine rejected the container creation.", status, responseBody), emit)
	}
	var created struct {
		ID       string   `json:"Id"`
		Warnings []string `json:"Warnings"`
	}
	if err := json.Unmarshal(responseBody, &created); err != nil || created.ID == "" {
		return ContainersCreateResult{}, failDomainMutation(receipt,
			opError("container_create_invalid", "Docker Engine returned an invalid creation result.", err, nil), emit)
	}
	receipt.ResourceID = created.ID

	result := ContainersCreateResult{
		Context: contextName, ID: created.ID, Warnings: nonNilStrings(created.Warnings),
	}
	if params.Start {
		startStatus, startBody, startErr := client.request(
			ctx, http.MethodPost, "/v"+client.apiVersion+"/containers/"+created.ID+"/start", nil,
		)
		if startErr != nil {
			// The container exists; report that plainly rather than pretending creation failed.
			return result, failSubmittedMutation(receipt, startErr, emit)
		}
		if startStatus < 200 || startStatus >= 300 {
			return result, failDomainMutation(receipt,
				engineHTTPError("container_start_failed", "The container was created but could not be started.", startStatus, startBody), emit)
		}
		result.Started = true
	}
	succeedDomainMutation(&receipt, emit)
	result.Receipt = receipt
	return result, nil
}

const (
	// A containers list can be hundreds long; sampling every one on a poll would hammer the
	// daemon. The renderer sends only the rows it is actually showing.
	maxStatsBatch = 64
	// Each sample is an independent Engine request that spends almost all of its time waiting:
	// stream=false makes the daemon hold the connection for a full collection cycle so
	// precpu_stats is populated (without which CPU% would be a lifetime average). The fan-out
	// is therefore latency-bound, not CPU-bound, and a wider window is what keeps a batch
	// inside one poll interval.
	statsBatchConcurrency = 16
)

// containersStatsBatch samples several containers concurrently, reporting per-container
// failures rather than failing the whole batch. One container disappearing mid-poll must not
// blank the metrics for every other row.
func (s *Service) containersStatsBatch(parent context.Context, params ContainersStatsBatchParams) (ContainersStatsBatchResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainersStatsBatchResult{}, err
	}
	if len(params.IDs) == 0 {
		return ContainersStatsBatchResult{
			Context: contextName, Source: "engine-api",
			Samples: []ContainerStatsSample{}, ObservedAt: nowUTC(),
		}, nil
	}
	if len(params.IDs) > maxStatsBatch {
		return ContainersStatsBatchResult{}, opError("invalid_action_options",
			"Container stats batch exceeds the supported size.", nil,
			map[string]any{"requested": len(params.IDs), "maximum": maxStatsBatch})
	}
	seen := map[string]bool{}
	for _, id := range params.IDs {
		if err := validateContainerID(id); err != nil {
			return ContainersStatsBatchResult{}, err
		}
		if seen[id] {
			return ContainersStatsBatchResult{}, opError("invalid_action_options",
				"Container stats batch contains a duplicate ID.", nil, map[string]any{"id": id})
		}
		seen[id] = true
	}

	samples := make([]ContainerStatsSample, len(params.IDs))
	gate := make(chan struct{}, statsBatchConcurrency)
	var wait sync.WaitGroup
	for index, id := range params.IDs {
		wait.Add(1)
		go func(index int, id string) {
			defer wait.Done()
			gate <- struct{}{}
			defer func() { <-gate }()
			stats, err := s.containerStats(parent, ContainerStatsParams{Context: contextName, ID: id})
			if err != nil {
				samples[index] = ContainerStatsSample{ID: id, Error: AsOpError(err)}
				return
			}
			samples[index] = ContainerStatsSample{ID: id, Stats: &stats}
		}(index, id)
	}
	wait.Wait()

	return ContainersStatsBatchResult{
		Context: contextName, Source: "engine-api", Samples: samples, ObservedAt: nowUTC(),
	}, nil
}

// systemSnapshotCLI backs the dashboard on contexts that do not expose a local Engine socket
// (remote/SSH). It uses `docker info` and, when asked, `docker system df`, both in JSON.
// Previously the whole dashboard was simply unavailable on those contexts.
func (s *Service) systemSnapshotCLI(ctx context.Context, contextName string, includeDiskUsage bool) (SystemSnapshotResult, error) {
	infoArgs := withContext(contextName, "info", "--format", "{{json .}}")
	infoResult, err := s.docker.run(ctx, infoArgs, s.defaultCWD, nil, domainCLIOutputLimit)
	if err != nil {
		return SystemSnapshotResult{}, err
	}
	if infoResult.exitCode != 0 {
		return SystemSnapshotResult{}, opError("system_info_failed",
			"Docker CLI could not read system information.", nil,
			map[string]any{"exitCode": infoResult.exitCode, "stderr": string(infoResult.stderr)})
	}
	var info engineInfo
	if err := json.Unmarshal(infoResult.stdout, &info); err != nil {
		return SystemSnapshotResult{}, opError("system_info_invalid",
			"Docker CLI returned invalid system information JSON.", err, nil)
	}

	limitations := []string{
		"Remote CLI JSON is used because this context does not expose a local Engine socket; per-record disk detail is unavailable.",
	}
	var disk engineDiskUsage
	if includeDiskUsage {
		dfArgs := withContext(contextName, "system", "df", "--format", "{{json .}}")
		dfCtx, cancelDF := context.WithTimeout(ctx, diskUsageTimeout)
		dfResult, dfErr := s.docker.run(dfCtx, dfArgs, s.defaultCWD, nil, domainCLIOutputLimit)
		cancelDF()
		if dfErr != nil || dfResult.exitCode != 0 {
			limitations = append(limitations, "Disk usage is unavailable on this context.")
		} else {
			// `docker system df --format {{json .}}` reports human-readable totals rather than
			// the Engine's per-record byte arrays, so only the aggregate is recoverable.
			var summary struct {
				Images     string `json:"Images"`
				Containers string `json:"Containers"`
				Volumes    string `json:"Volumes"`
				BuildCache string `json:"BuildCache"`
			}
			if err := json.Unmarshal(dfResult.stdout, &summary); err != nil {
				limitations = append(limitations, "Disk usage JSON could not be parsed on this context.")
			} else {
				limitations = append(limitations,
					"Disk usage totals come from CLI display strings; exact byte counts are unavailable.")
			}
		}
	} else {
		limitations = append(limitations, "Disk usage was not requested for this snapshot.")
	}

	return SystemSnapshotResult{
		Context: contextName, Source: "cli-json", Engine: projectEngineInfo(info, nil),
		DiskUsage: projectDiskUsage(disk), ObservedAt: nowUTC(), Limitations: limitations,
	}, nil
}

type engineImageInspect struct {
	ID            string   `json:"Id"`
	RepoTags      []string `json:"RepoTags"`
	RepoDigests   []string `json:"RepoDigests"`
	Parent        string   `json:"Parent"`
	Comment       string   `json:"Comment"`
	Created       string   `json:"Created"`
	DockerVersion string   `json:"DockerVersion"`
	Author        string   `json:"Author"`
	Architecture  string   `json:"Architecture"`
	OS            string   `json:"Os"`
	Size          int64    `json:"Size"`
	Config        struct {
		Labels       map[string]string   `json:"Labels"`
		Env          []string            `json:"Env"`
		Entrypoint   []string            `json:"Entrypoint"`
		Cmd          []string            `json:"Cmd"`
		WorkingDir   string              `json:"WorkingDir"`
		ExposedPorts map[string]struct{} `json:"ExposedPorts"`
	} `json:"Config"`
	RootFS struct {
		Layers []string `json:"Layers"`
	} `json:"RootFS"`
}

type engineImageHistory struct {
	ID        string   `json:"Id"`
	Created   int64    `json:"Created"`
	CreatedBy string   `json:"CreatedBy"`
	Tags      []string `json:"Tags"`
	Size      int64    `json:"Size"`
	Comment   string   `json:"Comment"`
}

// imagesInspect returns an image's configuration and its layer history. Both are read-only
// and cheap; the Images screen previously had no detail surface at all, so an image's size
// breakdown, layers and provenance were only reachable by leaving the application.
func (s *Service) imagesInspect(parent context.Context, params ImagesInspectParams) (ImagesInspectResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ImagesInspectResult{}, err
	}
	if err := validateImageID(params.ID); err != nil {
		return ImagesInspectResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ImagesInspectResult{}, nativeTransportRequired("images.inspect", contextName, err)
		}
		return ImagesInspectResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ImagesInspectResult{}, nativeTransportRequired("images.inspect", contextName, err)
		}
		return ImagesInspectResult{}, err
	}

	base := "/v" + client.apiVersion + "/images/" + url.PathEscape(params.ID)
	status, body, err := client.request(ctx, http.MethodGet, base+"/json", nil)
	if err != nil {
		return ImagesInspectResult{}, err
	}
	if status < 200 || status >= 300 {
		return ImagesInspectResult{}, engineHTTPError("image_inspect_failed",
			"Docker Engine rejected the image inspect request.", status, body)
	}
	var raw engineImageInspect
	if err := json.Unmarshal(body, &raw); err != nil {
		return ImagesInspectResult{}, opError("image_inspect_invalid",
			"Docker Engine returned invalid image JSON.", err, nil)
	}

	ports := []string{}
	for port := range raw.Config.ExposedPorts {
		ports = append(ports, port)
	}
	sort.Strings(ports)

	detail := ImageDetail{
		ID: raw.ID, RepoTags: nonNilStrings(raw.RepoTags), RepoDigests: nonNilStrings(raw.RepoDigests),
		Parent: raw.Parent, Comment: raw.Comment, Created: raw.Created,
		DockerVersion: raw.DockerVersion, Author: raw.Author,
		Architecture: raw.Architecture, OS: raw.OS, SizeBytes: raw.Size,
		Labels: nonNilMap(raw.Config.Labels), Env: nonNilStrings(raw.Config.Env),
		Entrypoint: nonNilStrings(raw.Config.Entrypoint), Command: nonNilStrings(raw.Config.Cmd),
		WorkingDir: raw.Config.WorkingDir, ExposedPorts: ports,
		RootFSLayers: nonNilStrings(raw.RootFS.Layers),
	}

	// History is supplementary: an image whose history the daemon will not serve should still
	// render its configuration rather than failing the whole request.
	history := []ImageLayer{}
	historyStatus, historyBody, historyErr := client.request(ctx, http.MethodGet, base+"/history", nil)
	if historyErr == nil && historyStatus >= 200 && historyStatus < 300 {
		var rawHistory []engineImageHistory
		if err := json.Unmarshal(historyBody, &rawHistory); err == nil {
			for _, entry := range rawHistory {
				history = append(history, ImageLayer{
					ID: entry.ID, Created: entry.Created, CreatedBy: entry.CreatedBy,
					SizeBytes: entry.Size, Comment: entry.Comment,
					Tags: nonNilStrings(entry.Tags), EmptyLayer: entry.Size == 0,
				})
			}
		}
	}

	return ImagesInspectResult{
		Context: contextName, Source: "engine-api", Image: detail, History: history,
		Document: cloneJSON(body), ObservedAt: nowUTC(),
	}, nil
}

const (
	// A directory listing is capped so browsing "/" cannot stream an entire filesystem.
	maxFileEntries = 500
	// Single-file reads are bounded; this is a browser, not a download manager.
	maxFileReadBytes = 1 * 1024 * 1024
	// The archive endpoint returns a directory's whole subtree. Entries that are not direct
	// children never reach the entry cap, so without a separate bound a listing of a shallow
	// directory could stream an entire volume through the socket.
	maxArchiveDescendants = 20000

	// Browsing creates and removes a helper container, so it is slower than a plain read.
	volumeBrowseTimeout = 90 * time.Second
	// A backup copies the whole volume to disk, which is bounded by size rather than latency.
	volumeBackupTimeout = 30 * time.Minute
)

// normalizeContainerPath rejects anything that is not a clean absolute path. The value
// becomes a query parameter for the Engine archive API, so traversal and control characters
// must never reach it.
func normalizeContainerPath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = "/"
	}
	if !strings.HasPrefix(value, "/") {
		return "", opError("invalid_path", "Container path must be absolute.", nil, map[string]any{"path": raw})
	}
	if len(value) > 4096 {
		return "", opError("invalid_path", "Container path is too long.", nil, nil)
	}
	for _, r := range value {
		if r == 0 || r == '\n' || r == '\r' {
			return "", opError("invalid_path", "Container path contains a control character.", nil, nil)
		}
	}
	cleaned := path.Clean(value)
	// path.Clean resolves ".." lexically; anything that escapes the root is rejected outright
	// rather than silently normalised.
	if strings.Contains(value, "..") && cleaned != value {
		return "", opError("invalid_path", "Container path must not contain relative segments.", nil, map[string]any{"path": raw})
	}
	return cleaned, nil
}

func (s *Service) containerArchiveClient(parent context.Context, contextName, method string) (*engineClient, contextEndpoint, error) {
	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return nil, contextEndpoint{}, nativeTransportRequired(method, contextName, err)
		}
		return nil, contextEndpoint{}, err
	}
	client, err := s.engineClient(parent, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return nil, contextEndpoint{}, nativeTransportRequired(method, contextName, err)
		}
		return nil, contextEndpoint{}, err
	}
	return client, endpoint, nil
}

// containerFiles lists a directory inside a container.
//
// It reads the Engine archive endpoint and walks only the tar headers, which means it works
// on scratch and distroless images that contain no shell at all — an `exec ls` implementation
// would simply fail on those. The stream is abandoned once the entry cap is reached.
// listArchiveChildren walks the tar stream Docker returns for a path and yields that path's
// direct children. Extracted so the volume browser can use it too: a volume is read by
// mounting it into a helper container and listing the mount, which is exactly this operation
// against a different container. Walking tar headers rather than exec'ing `ls` is what makes
// it work on images with no shell — and a volume helper is never started at all.
func listArchiveChildren(ctx context.Context, client *engineClient, containerID, target string) ([]ContainerFileEntry, bool, error) {
	values := url.Values{}
	values.Set("path", target)
	requestPath := "/v" + client.apiVersion + "/containers/" + url.PathEscape(containerID) +
		"/archive?" + values.Encode()
	body, status, err := client.stream(ctx, http.MethodGet, requestPath)
	if err != nil {
		return nil, false, err
	}
	defer body.Close()
	if status < 200 || status >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(body, 8*1024))
		return nil, false, engineHTTPError("container_files_failed",
			"Docker Engine rejected the container path.", status, payload)
	}

	// The archive is rooted at the requested path's base name; direct children are exactly the
	// entries one segment deeper.
	root := path.Base(target)
	entries := []ContainerFileEntry{}
	truncated := false
	descendants := 0
	reader := tar.NewReader(body)
	for {
		header, readErr := reader.Next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, false, opError("container_files_invalid",
				"Docker Engine returned an unreadable archive stream.", readErr, nil)
		}
		clean := strings.TrimSuffix(strings.TrimPrefix(path.Clean(header.Name), "./"), "/")
		if clean == "" || clean == root {
			continue
		}
		relative := strings.TrimPrefix(clean, root+"/")
		if relative == clean || strings.Contains(relative, "/") {
			// Not a direct child of the requested directory. The Engine returns the whole
			// subtree, so a directory whose content sits one level down would otherwise stream
			// every byte beneath it before this loop could finish. Descendants are counted and
			// the walk abandoned once they dominate, which bounds the read by depth rather
			// than by the caller's patience.
			descendants++
			if descendants > maxArchiveDescendants {
				truncated = true
				break
			}
			continue
		}
		if len(entries) >= maxFileEntries {
			truncated = true
			break
		}
		entries = append(entries, ContainerFileEntry{
			Name:       relative,
			Path:       path.Join(target, relative),
			SizeBytes:  header.Size,
			Mode:       header.FileInfo().Mode().String(),
			ModifiedAt: header.ModTime.UTC().Format(time.RFC3339),
			IsDir:      header.FileInfo().IsDir(),
			LinkTarget: header.Linkname,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		// Directories first, then name; the ordering people expect from a file browser.
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})

	return entries, truncated, nil
}

func (s *Service) containerFiles(parent context.Context, params ContainerFilesParams) (ContainerFilesResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainerFilesResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainerFilesResult{}, err
	}
	target, err := normalizeContainerPath(params.Path)
	if err != nil {
		return ContainerFilesResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "containers.files")
	if err != nil {
		return ContainerFilesResult{}, err
	}

	entries, truncated, err := listArchiveChildren(ctx, client, params.ID, target)
	if err != nil {
		return ContainerFilesResult{}, err
	}

	limitations := []string{}
	if truncated {
		limitations = append(limitations,
			"Listing stopped at "+strconv.Itoa(maxFileEntries)+" entries; this directory contains more.")
	}
	return ContainerFilesResult{
		Context: contextName, Source: "engine-api", Path: target, Entries: entries,
		Truncated: truncated, ObservedAt: nowUTC(), Limitations: limitations,
	}, nil
}

// containerFileRead returns the contents of a single file, bounded and base64-encoded when it
// is not valid UTF-8 so binary files cannot corrupt the transport.
func (s *Service) containerFileRead(parent context.Context, params ContainerFileReadParams) (ContainerFileReadResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainerFileReadResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainerFileReadResult{}, err
	}
	target, err := normalizeContainerPath(params.Path)
	if err != nil {
		return ContainerFileReadResult{}, err
	}
	if target == "/" {
		return ContainerFileReadResult{}, opError("invalid_path", "A directory cannot be read as a file.", nil, nil)
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "containers.fileRead")
	if err != nil {
		return ContainerFileReadResult{}, err
	}

	values := url.Values{}
	values.Set("path", target)
	requestPath := "/v" + client.apiVersion + "/containers/" + url.PathEscape(params.ID) +
		"/archive?" + values.Encode()
	body, status, err := client.stream(ctx, http.MethodGet, requestPath)
	if err != nil {
		return ContainerFileReadResult{}, err
	}
	defer body.Close()
	if status < 200 || status >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(body, 8*1024))
		return ContainerFileReadResult{}, engineHTTPError("container_file_read_failed",
			"Docker Engine rejected the container file request.", status, payload)
	}

	content, size, encoding, truncated, err := readSingleArchiveFile(body)
	if err != nil {
		return ContainerFileReadResult{}, err
	}
	return ContainerFileReadResult{
		Context: contextName, Path: target, SizeBytes: size,
		Encoding: encoding, Content: content, Truncated: truncated, ObservedAt: nowUTC(),
	}, nil
}

// readSingleArchiveFile pulls one file out of the tar stream Docker returns for a file path.
//
// Shared with the volume browser, which reads files the same way through a helper container.
// Content is bounded and re-encoded as base64 when it is not valid UTF-8, so a binary file
// cannot corrupt the JSON transport.
func readSingleArchiveFile(body io.Reader) (content string, size int64, encoding string, truncated bool, err error) {
	reader := tar.NewReader(body)
	for {
		header, readErr := reader.Next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", 0, "", false, opError("container_file_read_invalid",
				"Docker Engine returned an unreadable archive stream.", readErr, nil)
		}
		if header.FileInfo().IsDir() {
			return "", 0, "", false, opError("invalid_path",
				"A directory cannot be read as a file.", nil, nil)
		}
		data, dataErr := io.ReadAll(io.LimitReader(reader, maxFileReadBytes+1))
		if dataErr != nil {
			return "", 0, "", false, opError("container_file_read_invalid",
				"The file could not be read.", dataErr, nil)
		}
		cut := int64(len(data)) > maxFileReadBytes
		if cut {
			data = data[:maxFileReadBytes]
		}
		if !utf8.Valid(data) {
			return base64.StdEncoding.EncodeToString(data), header.Size, "base64", cut, nil
		}
		return string(data), header.Size, "utf-8", cut, nil
	}
	return "", 0, "", false, opError("container_file_missing",
		"The path did not contain a readable file.", nil, nil)
}

// containerTop is `docker top`: the processes running inside a container.
func (s *Service) containerTop(parent context.Context, params ContainerInspectParams) (ContainerTopResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainerTopResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainerTopResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "containers.top")
	if err != nil {
		return ContainerTopResult{}, err
	}
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/containers/"+url.PathEscape(params.ID)+"/top", nil)
	if err != nil {
		return ContainerTopResult{}, err
	}
	if status < 200 || status >= 300 {
		return ContainerTopResult{}, engineHTTPError("container_top_failed",
			"Docker Engine rejected the process list request.", status, body)
	}
	var raw struct {
		Titles    []string   `json:"Titles"`
		Processes [][]string `json:"Processes"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ContainerTopResult{}, opError("container_top_invalid",
			"Docker Engine returned invalid process JSON.", err, nil)
	}
	processes := make([]ContainerProcess, 0, len(raw.Processes))
	for _, row := range raw.Processes {
		processes = append(processes, ContainerProcess{Values: nonNilStrings(row)})
	}
	return ContainerTopResult{
		Context: contextName, Titles: nonNilStrings(raw.Titles),
		Processes: processes, ObservedAt: nowUTC(),
	}, nil
}

// containerDiff is `docker diff`: filesystem changes relative to the image.
func (s *Service) containerDiff(parent context.Context, params ContainerInspectParams) (ContainerDiffResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainerDiffResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainerDiffResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "containers.diff")
	if err != nil {
		return ContainerDiffResult{}, err
	}
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/containers/"+url.PathEscape(params.ID)+"/changes", nil)
	if err != nil {
		return ContainerDiffResult{}, err
	}
	if status < 200 || status >= 300 {
		return ContainerDiffResult{}, engineHTTPError("container_diff_failed",
			"Docker Engine rejected the filesystem changes request.", status, body)
	}
	var raw []struct {
		Path string `json:"Path"`
		Kind int    `json:"Kind"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ContainerDiffResult{}, opError("container_diff_invalid",
			"Docker Engine returned invalid changes JSON.", err, nil)
	}
	kinds := map[int]string{0: "modified", 1: "added", 2: "deleted"}
	changes := make([]ContainerChange, 0, len(raw))
	for _, entry := range raw {
		kind, known := kinds[entry.Kind]
		if !known {
			kind = "unknown"
		}
		changes = append(changes, ContainerChange{Path: entry.Path, Kind: kind})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	return ContainerDiffResult{Context: contextName, Changes: changes, ObservedAt: nowUTC()}, nil
}

// Uploads are bounded well below the RPC line budget: the payload arrives base64-encoded
// inside a single JSON request, which inflates it by roughly a third.
const maxFileWriteBytes = 2 * 1024 * 1024

type ContainerFileWriteParams struct {
	Context string `json:"context"`
	ID      string `json:"id"`
	// Directory inside the container to extract into.
	Path string `json:"path"`
	Name string `json:"name"`
	// Base64-encoded file contents.
	Content string `json:"content"`
	Mode    int64  `json:"mode,omitempty"`
}

type ContainerFileWriteResult struct {
	Context    string `json:"context"`
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	ObservedAt string `json:"observedAt"`
}

// containerFileWrite is the upload half of `docker cp`. It builds a one-entry tar in memory
// and PUTs it to the Engine archive endpoint, which extracts it into the target directory.
// validateUploadName checks the single path segment an upload lands under. Shared with the
// volume writer: the value becomes a tar entry name, so a separator or a traversal segment
// would let the upload escape the directory the operator chose.
func validateUploadName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len(name) > 255 || strings.ContainsAny(name, `/\`) ||
		name == "." || name == ".." {
		return "", opError("invalid_path",
			"Upload name must be a single path segment.", nil, map[string]any{"name": raw})
	}
	return name, nil
}

// decodeUploadContent bounds and decodes a base64 upload body.
func decodeUploadContent(encoded string) ([]byte, error) {
	content, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, opError("invalid_content", "Upload content must be base64-encoded.", err, nil)
	}
	if int64(len(content)) > maxFileWriteBytes {
		return nil, opError("content_too_large", "Upload exceeds the supported size.", nil,
			map[string]any{"bytes": len(content), "maximum": maxFileWriteBytes})
	}
	return content, nil
}

// buildUploadArchive wraps one file in the single-entry tar the Engine's archive endpoint
// expects. Shared so the container and volume writers cannot drift in how they frame it.
func buildUploadArchive(name string, content []byte, requestedMode int64) ([]byte, error) {
	mode := requestedMode
	if mode <= 0 || mode > 0o777 {
		mode = 0o644
	}
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	if err := writer.WriteHeader(&tar.Header{
		Name: name, Mode: mode, Size: int64(len(content)), ModTime: time.Now(),
		Typeflag: tar.TypeReg,
	}); err != nil {
		return nil, opError("upload_encode_failed",
			"The upload archive could not be created.", err, nil)
	}
	if _, err := writer.Write(content); err != nil {
		return nil, opError("upload_encode_failed",
			"The upload archive could not be written.", err, nil)
	}
	if err := writer.Close(); err != nil {
		return nil, opError("upload_encode_failed",
			"The upload archive could not be finalized.", err, nil)
	}
	return archive.Bytes(), nil
}

func (s *Service) containerFileWrite(parent context.Context, params ContainerFileWriteParams) (ContainerFileWriteResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainerFileWriteResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainerFileWriteResult{}, err
	}
	target, err := normalizeContainerPath(params.Path)
	if err != nil {
		return ContainerFileWriteResult{}, err
	}
	name := strings.TrimSpace(params.Name)
	// The name becomes a tar entry path; a separator or traversal segment would let an upload
	// escape the directory the user chose.
	if name == "" || len(name) > 255 || strings.ContainsAny(name, "/\\\\") ||
		name == "." || name == ".." {
		return ContainerFileWriteResult{}, opError("invalid_path",
			"Upload name must be a single path segment.", nil, map[string]any{"name": params.Name})
	}
	content, err := decodeUploadContent(params.Content)
	if err != nil {
		return ContainerFileWriteResult{}, err
	}
	archive, err := buildUploadArchive(name, content, params.Mode)
	if err != nil {
		return ContainerFileWriteResult{}, err
	}

	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "containers.fileWrite")
	if err != nil {
		return ContainerFileWriteResult{}, err
	}
	values := url.Values{}
	values.Set("path", target)
	status, body, err := client.request(ctx, http.MethodPut,
		"/v"+client.apiVersion+"/containers/"+url.PathEscape(params.ID)+"/archive?"+values.Encode(),
		bytes.NewReader(archive))
	if err != nil {
		return ContainerFileWriteResult{}, err
	}
	if status < 200 || status >= 300 {
		return ContainerFileWriteResult{}, engineHTTPError("container_file_write_failed",
			"Docker Engine rejected the upload.", status, body)
	}
	return ContainerFileWriteResult{
		Context: contextName, Path: path.Join(target, name),
		SizeBytes: int64(len(content)), ObservedAt: nowUTC(),
	}, nil
}

// imagesSearch backs the Registry tab, which until now was fixture-only: in host mode it
// degraded to a bare pull box while still being labelled "Registry search".
func (s *Service) imagesSearch(parent context.Context, params ImagesSearchParams) (ImagesSearchResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ImagesSearchResult{}, err
	}
	term := strings.TrimSpace(params.Term)
	if term == "" || len(term) > 255 {
		return ImagesSearchResult{}, opError("invalid_search_term",
			"Search term must be between 1 and 255 characters.", nil, nil)
	}
	for _, r := range term {
		if r == 0 || r == '\n' || r == '\r' {
			return ImagesSearchResult{}, opError("invalid_search_term",
				"Search term contains a control character.", nil, nil)
		}
	}
	limit := params.Limit
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	client, _, err := s.containerArchiveClient(ctx, contextName, "images.search")
	if err != nil {
		return ImagesSearchResult{}, err
	}
	values := url.Values{}
	values.Set("term", term)
	values.Set("limit", strconv.Itoa(limit))
	status, body, err := client.request(ctx, http.MethodGet,
		"/v"+client.apiVersion+"/images/search?"+values.Encode(), nil)
	if err != nil {
		return ImagesSearchResult{}, err
	}
	if status < 200 || status >= 300 {
		return ImagesSearchResult{}, engineHTTPError("images_search_failed",
			"Docker Engine rejected the registry search.", status, body)
	}
	var raw []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		StarCount   int    `json:"star_count"`
		IsOfficial  bool   `json:"is_official"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ImagesSearchResult{}, opError("images_search_invalid",
			"Docker Engine returned invalid search JSON.", err, nil)
	}
	results := make([]RegistryImageResult, 0, len(raw))
	for _, entry := range raw {
		results = append(results, RegistryImageResult{
			Name: entry.Name, Description: entry.Description,
			Stars: entry.StarCount, Official: entry.IsOfficial,
		})
	}
	sort.SliceStable(results, func(i, j int) bool {
		// Official images first, then by popularity: what a registry search is actually for.
		if results[i].Official != results[j].Official {
			return results[i].Official
		}
		return results[i].Stars > results[j].Stars
	})
	return ImagesSearchResult{
		Context: contextName, Term: term, Results: results, ObservedAt: nowUTC(),
	}, nil
}

// containersCommit is `docker commit`: a new image from a container's current filesystem.
func (s *Service) containersCommit(parent context.Context, params ContainersCommitParams, emit EventEmitter) (ContainersCommitResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainersCommitResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ContainersCommitResult{}, err
	}
	repository := strings.TrimSpace(params.Repository)
	if err := validateImageReference(repository); err != nil {
		return ContainersCommitResult{}, err
	}
	tag := strings.TrimSpace(params.Tag)
	if tag != "" {
		if err := validateImageReference(tag); err != nil {
			return ContainersCommitResult{}, err
		}
	}
	if len(params.Changes) > 64 {
		return ContainersCommitResult{}, opError("invalid_action_options",
			"Too many Dockerfile changes supplied.", nil, nil)
	}

	operationID, err := operationID()
	if err != nil {
		return ContainersCommitResult{}, opError("operation_id_failed",
			"Operation identifier could not be generated.", err, nil)
	}
	receipt := newDomainReceipt(operationID, contextName, "container", params.ID, "commit", "engine-api")
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, endpoint, err := s.containerArchiveClient(ctx, contextName, "containers.commit")
	if err != nil {
		return ContainersCommitResult{}, err
	}
	receipt.EndpointHash = endpoint.endpointHash
	emitDomainStarted(emit, "containers.commit", receipt)

	values := url.Values{}
	values.Set("container", params.ID)
	values.Set("repo", repository)
	if tag != "" {
		values.Set("tag", tag)
	}
	if params.Comment != "" {
		values.Set("comment", params.Comment)
	}
	if params.Author != "" {
		values.Set("author", params.Author)
	}
	values.Set("pause", strconv.FormatBool(params.Pause))
	for _, change := range params.Changes {
		values.Add("changes", change)
	}

	status, body, requestErr := client.request(ctx, http.MethodPost,
		"/v"+client.apiVersion+"/commit?"+values.Encode(), nil)
	receipt.HTTPStatus = status
	if requestErr != nil {
		return ContainersCommitResult{}, failSubmittedMutation(receipt, requestErr, emit)
	}
	if status < 200 || status >= 300 {
		return ContainersCommitResult{}, failDomainMutation(receipt,
			engineHTTPError("container_commit_failed",
				"Docker Engine rejected the commit.", status, body), emit)
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.ID == "" {
		return ContainersCommitResult{}, failDomainMutation(receipt,
			opError("container_commit_invalid",
				"Docker Engine returned an invalid commit result.", err, nil), emit)
	}
	succeedDomainMutation(&receipt, emit)
	return ContainersCommitResult{
		Context: contextName, ImageID: created.ID, Receipt: receipt, ObservedAt: nowUTC(),
	}, nil
}

// validateArchivePath checks a host path used by save/load/export. The file itself need not
// exist yet (save creates it), so the *parent directory* is what is canonicalized and checked
// against the same allowlist that governs command working directories. A leading '-' is
// rejected outright: the value becomes an argv element next to a Docker flag.
func (s *Service) validateArchivePath(raw string, mustExist, overwrite bool) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 4096 {
		return "", opError("invalid_archive_path", "Archive path must be between 1 and 4096 characters.", nil, nil)
	}
	if strings.HasPrefix(value, "-") {
		return "", opError("invalid_archive_path", "Archive path must not begin with '-'.", nil, nil)
	}
	if !filepath.IsAbs(value) {
		return "", opError("invalid_archive_path", "Archive path must be absolute.", nil, map[string]any{"path": raw})
	}
	for _, r := range value {
		if r == 0 || r == '\n' || r == '\r' {
			return "", opError("invalid_archive_path", "Archive path contains a control character.", nil, nil)
		}
	}
	cleaned := filepath.Clean(value)
	// The final component is checked with Lstat, not Stat: resolveAllowedCWD canonicalizes the
	// parent, so a symlink in the last position would otherwise redirect the write to wherever
	// it pointed. Character and block devices are refused for the same reason /dev/stdin is —
	// Docker would happily read a Compose-style stream from one, or write into it.
	info, statErr := os.Lstat(cleaned)
	switch {
	case mustExist:
		if statErr != nil || info.IsDir() || !info.Mode().IsRegular() {
			return "", opError("invalid_archive_path", "Archive file does not exist.", statErr,
				map[string]any{"path": cleaned})
		}
	case statErr == nil:
		if info.IsDir() {
			return "", opError("invalid_archive_path", "That path is a directory.", nil,
				map[string]any{"path": cleaned})
		}
		if !info.Mode().IsRegular() {
			return "", opError("invalid_archive_path",
				"That path is not a regular file.", nil, map[string]any{"path": cleaned})
		}
		// Docker's --output truncates. Replacing a file the operator did not mean to name is
		// not recoverable, so it takes a second, explicit decision rather than a silent write.
		if !overwrite {
			return "", opError("archive_exists",
				"A file already exists at that path; confirm replacing it.", nil,
				map[string]any{"path": cleaned})
		}
	}
	// The parent must resolve and sit inside the allowlist, so an archive can never be written
	// somewhere the command surface itself could not reach.
	if _, err := s.resolveAllowedCWD(filepath.Dir(cleaned)); err != nil {
		return "", err
	}
	return cleaned, nil
}

// containersExport is `docker export`: a container's filesystem as a tar archive. Run as a
// cancellable session writing straight to a host file, so the archive never transits the RPC.
func (s *Service) containersExport(parent context.Context, params ContainersExportParams, emit EventEmitter) (ImagesActionResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ImagesActionResult{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return ImagesActionResult{}, err
	}
	archive, err := s.validateArchivePath(params.ArchivePath, false, params.Overwrite)
	if err != nil {
		return ImagesActionResult{}, err
	}
	cwd := params.Cwd
	if cwd == "" && len(s.allowedCWDs) > 0 {
		cwd = s.allowedCWDs[0]
	}
	session, err := s.sessions.start(context.WithoutCancel(parent), SessionStartParams{
		Context: contextName,
		Argv:    []string{"export", "--output", archive, params.ID},
		Cwd:     cwd, Mode: "pipes",
		TimeoutSeconds:    params.TimeoutSeconds,
		OutputWindowBytes: params.OutputWindowBytes,
	}, sessionReceiptEmitter(emit, "containers.export", contextName, "container", params.ID,
		"export", "container_export_failed", "Container export"))
	if err != nil {
		return ImagesActionResult{}, err
	}
	receipt := DomainOperationReceipt{
		OperationID: session.SessionID, Context: contextName, Domain: "container",
		ResourceID: params.ID, Action: "export", Source: "cli-session",
		Outcome: "running", StartedAt: session.StartedAt,
	}
	return ImagesActionResult{Action: "export", Receipt: receipt, Session: &session}, nil
}

// imageArchive runs `docker image save` / `docker image load` as a cancellable session that
// reads or writes a host file directly. A saved image is routinely gigabytes, so the archive
// must never transit the JSON RPC; Docker's own -o/-i handling does the streaming.
func (s *Service) imageArchive(parent context.Context, params ImagesActionParams, emit EventEmitter) (ImagesActionResult, error) {
	mustExist := params.Action == "load"
	archive, err := s.validateArchivePath(params.ArchivePath, mustExist, params.Overwrite)
	if err != nil {
		return ImagesActionResult{}, err
	}
	cwd := params.Cwd
	if cwd == "" && len(s.allowedCWDs) > 0 {
		cwd = s.allowedCWDs[0]
	}
	var argv []string
	if params.Action == "save" {
		argv = []string{"image", "save", "--output", archive, params.Reference}
	} else {
		argv = []string{"image", "load", "--input", archive}
	}
	resourceID := params.Reference
	if resourceID == "" {
		resourceID = archive
	}
	session, err := s.sessions.start(context.WithoutCancel(parent), SessionStartParams{
		Context: params.Context, Argv: argv, Cwd: cwd, Mode: "pipes",
		TimeoutSeconds:    params.TimeoutSeconds,
		OutputWindowBytes: params.OutputWindowBytes,
		MaxOutputBytes:    params.MaxOutputBytes,
	}, sessionReceiptEmitter(emit, "images.action", params.Context, "image", resourceID,
		params.Action, "image_archive_failed", "Image "+params.Action))
	if err != nil {
		return ImagesActionResult{}, err
	}
	receipt := DomainOperationReceipt{
		OperationID: session.SessionID, Context: params.Context, Domain: "image",
		ResourceID: resourceID, Action: params.Action, Source: "cli-session",
		Outcome: "running", StartedAt: session.StartedAt,
	}
	return ImagesActionResult{Action: params.Action, Receipt: receipt, Session: &session}, nil
}
