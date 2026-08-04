package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"time"
)

const (
	ProtocolVersion = "1"
	CoreVersion     = "0.1.0"

	coreMinAPIVersion = "1.40"
	coreMaxAPIVersion = "1.55"
)

type EventEmitter func(event string, payload any)

type HealthResult struct {
	Status          string `json:"status"`
	Version         string `json:"version"`
	ProtocolVersion string `json:"protocolVersion"`
	PID             int    `json:"pid"`
	StartedAt       string `json:"startedAt"`
	DockerReady     bool   `json:"dockerReady"`
}

type BinaryFingerprint struct {
	RequestedPath string `json:"requestedPath"`
	Path          string `json:"path"`
	RealPath      string `json:"realPath"`
	SHA256        string `json:"sha256"`
	Size          int64  `json:"size"`
	ModifiedAt    string `json:"modifiedAt"`
	Mode          string `json:"mode"`
}

type VersionSide struct {
	Version       string `json:"version,omitempty"`
	APIVersion    string `json:"apiVersion,omitempty"`
	MinAPIVersion string `json:"minApiVersion,omitempty"`
	GoVersion     string `json:"goVersion,omitempty"`
	GitCommit     string `json:"gitCommit,omitempty"`
	OS            string `json:"os,omitempty"`
	Arch          string `json:"arch,omitempty"`
}

type DockerVersions struct {
	Client VersionSide `json:"client"`
	Server VersionSide `json:"server"`
}

type DockerContext struct {
	Name           string `json:"name"`
	Description    string `json:"description,omitempty"`
	DockerEndpoint string `json:"dockerEndpoint,omitempty"`
	Current        bool   `json:"current"`
	Error          string `json:"error,omitempty"`
}

type Plugin struct {
	Name             string `json:"name"`
	Version          string `json:"version,omitempty"`
	Vendor           string `json:"vendor,omitempty"`
	Description      string `json:"description,omitempty"`
	Path             string `json:"path,omitempty"`
	SchemaVersion    string `json:"schemaVersion,omitempty"`
	Status           string `json:"status"`
	DiscoverySource  string `json:"discoverySource"`
	AvailabilityNote string `json:"availabilityNote,omitempty"`
}

type CapabilityStatus struct {
	Name       string            `json:"name"`
	Status     string            `json:"status"`
	Version    string            `json:"version,omitempty"`
	Reason     string            `json:"reason,omitempty"`
	Transports []string          `json:"transports"`
	Evidence   *CommandEvidence  `json:"evidence,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

type CommandEvidence struct {
	Argv            []string `json:"argv"`
	ExitCode        int      `json:"exitCode"`
	Stdout          string   `json:"stdout"`
	Stderr          string   `json:"stderr"`
	StdoutTruncated bool     `json:"stdoutTruncated"`
	StderrTruncated bool     `json:"stderrTruncated"`
	TimedOut        bool     `json:"timedOut"`
	DurationMs      int64    `json:"durationMs"`
}

type CommandNode struct {
	Path         []string          `json:"path"`
	Name         string            `json:"name"`
	Description  string            `json:"description,omitempty"`
	Kind         string            `json:"kind"`
	Status       string            `json:"status"`
	Reason       string            `json:"reason"`
	Transports   []string          `json:"transports"`
	PluginRoot   string            `json:"pluginRoot,omitempty"`
	Usage        string            `json:"usage,omitempty"`
	Evidence     CommandEvidence   `json:"evidence"`
	Subcommands  []*CommandNode    `json:"subcommands"`
	Capabilities map[string]bool   `json:"capabilities,omitempty"`
	Metadata     map[string]string `json:"metadata,omitempty"`
}

type CommandInventory struct {
	Root         *CommandNode `json:"root"`
	NodeCount    int          `json:"nodeCount"`
	Complete     bool         `json:"complete"`
	LimitReached bool         `json:"limitReached"`
	MaxDepth     int          `json:"maxDepth"`
	DiscoveredAt string       `json:"discoveredAt"`
	Warnings     []string     `json:"warnings"`
}

type DiscoveryEvidence struct {
	ContextShow CommandEvidence `json:"contextShow"`
	ContextList CommandEvidence `json:"contextList"`
	Version     CommandEvidence `json:"version"`
	Info        CommandEvidence `json:"info"`
}

type CapabilitiesParams struct {
	Context string `json:"context,omitempty"`
}

type CapabilitiesResult struct {
	ProtocolVersion    string                      `json:"protocolVersion"`
	Binary             *BinaryFingerprint          `json:"binary,omitempty"`
	BinaryError        *OpError                    `json:"binaryError,omitempty"`
	SelectedContext    string                      `json:"selectedContext,omitempty"`
	CurrentContext     string                      `json:"currentContext,omitempty"`
	Contexts           []DockerContext             `json:"contexts"`
	Versions           DockerVersions              `json:"versions"`
	APIMin             string                      `json:"apiMin,omitempty"`
	APIMax             string                      `json:"apiMax,omitempty"`
	ServerExperimental bool                        `json:"serverExperimental"`
	Plugins            []Plugin                    `json:"plugins"`
	Capabilities       map[string]CapabilityStatus `json:"capabilities"`
	CommandInventory   CommandInventory            `json:"commandInventory"`
	Evidence           DiscoveryEvidence           `json:"evidence"`
	Warnings           []string                    `json:"warnings"`
	ObservedAt         string                      `json:"observedAt"`
}

type Port struct {
	IP          string `json:"ip,omitempty"`
	PrivatePort uint16 `json:"privatePort"`
	PublicPort  uint16 `json:"publicPort,omitempty"`
	Type        string `json:"type"`
}

type Container struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	ImageID string            `json:"imageId,omitempty"`
	State   string            `json:"state"`
	Status  string            `json:"status"`
	Health  string            `json:"health"`
	Ports   []Port            `json:"ports"`
	Labels  map[string]string `json:"labels,omitempty"`
	Created int64             `json:"created,omitempty"`
}

type ContainersListParams struct {
	Context string `json:"context"`
	All     *bool  `json:"all,omitempty"`
}

type ContainersListResult struct {
	Context      string      `json:"context"`
	Source       string      `json:"source"`
	APIVersion   string      `json:"apiVersion,omitempty"`
	Containers   []Container `json:"containers"`
	ObservedAt   string      `json:"observedAt"`
	EndpointHash string      `json:"endpointHash,omitempty"`
}

// SystemActionParams drives `docker system prune`.
type SystemActionParams struct {
	Context string `json:"context"`
	Action  string `json:"action"`
	// All maps to `--all`: also remove unused images that still carry tags, not just
	// dangling layers.
	All bool `json:"all,omitempty"`
	// Volumes maps to `--volumes`: also remove unused volumes. Off by default in Docker
	// because volume data is unrecoverable.
	Volumes   bool `json:"volumes,omitempty"`
	Confirmed bool `json:"confirmed"`
}

// SystemPruneStage records one component of the prune so the UI can report exactly what the
// daemon removed rather than a single opaque total.
type SystemPruneStage struct {
	Resource       string   `json:"resource"`
	Deleted        []string `json:"deleted"`
	SpaceReclaimed uint64   `json:"spaceReclaimedBytes"`
	Error          string   `json:"error,omitempty"`
}

type SystemActionResult struct {
	Context             string                 `json:"context"`
	Action              string                 `json:"action"`
	Source              string                 `json:"source"`
	Stages              []SystemPruneStage     `json:"stages"`
	SpaceReclaimedBytes uint64                 `json:"spaceReclaimedBytes"`
	Receipt             DomainOperationReceipt `json:"receipt"`
	ObservedAt          string                 `json:"observedAt"`
}

type SystemSnapshotParams struct {
	Context string `json:"context"`
	// IncludeDiskUsage requests /system/df. It is opt-in because it is a full daemon-side
	// disk walk: measured at ~7s on a host with 231 images / 237 volumes, and it used to run
	// on engine-ready and after every single mutation, where nothing displayed it.
	IncludeDiskUsage bool `json:"includeDiskUsage,omitempty"`
}

type EngineSummary struct {
	ID                 string   `json:"id,omitempty"`
	Name               string   `json:"name,omitempty"`
	ServerVersion      string   `json:"serverVersion,omitempty"`
	APIVersion         string   `json:"apiVersion"`
	MinAPIVersion      string   `json:"minApiVersion,omitempty"`
	OSType             string   `json:"osType,omitempty"`
	OperatingSystem    string   `json:"operatingSystem,omitempty"`
	Architecture       string   `json:"architecture,omitempty"`
	KernelVersion      string   `json:"kernelVersion,omitempty"`
	CPUs               int      `json:"cpus"`
	MemoryBytes        int64    `json:"memoryBytes"`
	Containers         int      `json:"containers"`
	ContainersRunning  int      `json:"containersRunning"`
	ContainersPaused   int      `json:"containersPaused"`
	ContainersStopped  int      `json:"containersStopped"`
	Images             int      `json:"images"`
	Driver             string   `json:"driver,omitempty"`
	DockerRootDir      string   `json:"dockerRootDir,omitempty"`
	Experimental       bool     `json:"experimental"`
	LiveRestoreEnabled bool     `json:"liveRestoreEnabled"`
	SwarmState         string   `json:"swarmState,omitempty"`
	Warnings           []string `json:"warnings"`
}

type ImageDiskUsage struct {
	ID           string   `json:"id"`
	RepoTags     []string `json:"repoTags"`
	RepoDigests  []string `json:"repoDigests"`
	Created      int64    `json:"created"`
	SizeBytes    int64    `json:"sizeBytes"`
	SharedBytes  int64    `json:"sharedBytes"`
	VirtualBytes int64    `json:"virtualBytes"`
	Containers   int64    `json:"containers"`
}

type ContainerDiskUsage struct {
	ID            string   `json:"id"`
	Image         string   `json:"image"`
	ImageID       string   `json:"imageId"`
	Names         []string `json:"names"`
	Created       int64    `json:"created"`
	WritableBytes int64    `json:"writableBytes"`
	RootFSBytes   int64    `json:"rootFsBytes"`
	State         string   `json:"state"`
	Status        string   `json:"status"`
}

type VolumeUsageData struct {
	SizeBytes int64 `json:"sizeBytes"`
	RefCount  int64 `json:"refCount"`
}

type VolumeProjection struct {
	Name        string            `json:"name"`
	Driver      string            `json:"driver"`
	Mountpoint  string            `json:"mountpoint,omitempty"`
	CreatedAt   string            `json:"createdAt,omitempty"`
	Scope       string            `json:"scope,omitempty"`
	Labels      map[string]string `json:"labels"`
	Options     map[string]string `json:"options"`
	Status      map[string]any    `json:"status,omitempty"`
	Usage       *VolumeUsageData  `json:"usage,omitempty"`
	LabelsText  string            `json:"labelsText,omitempty"`
	SizeDisplay string            `json:"sizeDisplay,omitempty"`
}

type BuildCacheUsage struct {
	ID          string   `json:"id"`
	Parent      string   `json:"parent,omitempty"`
	Parents     []string `json:"parents"`
	Type        string   `json:"type,omitempty"`
	Description string   `json:"description,omitempty"`
	InUse       bool     `json:"inUse"`
	Shared      bool     `json:"shared"`
	SizeBytes   int64    `json:"sizeBytes"`
	CreatedAt   string   `json:"createdAt,omitempty"`
	LastUsedAt  string   `json:"lastUsedAt,omitempty"`
	UsageCount  int64    `json:"usageCount"`
}

// DiskUsageCategory mirrors one row of `docker system df`. Totals are deduplicated across
// shared layers, so they must never be recomputed by summing the per-record sizes below.
type DiskUsageCategory struct {
	TotalCount       int64 `json:"totalCount"`
	ActiveCount      int64 `json:"activeCount"`
	SizeBytes        int64 `json:"sizeBytes"`
	ReclaimableBytes int64 `json:"reclaimableBytes"`
}

type SystemDiskUsage struct {
	LayersSizeBytes  int64                `json:"layersSizeBytes"`
	BuilderSizeBytes int64                `json:"builderSizeBytes"`
	Images           []ImageDiskUsage     `json:"images"`
	Containers       []ContainerDiskUsage `json:"containers"`
	Volumes          []VolumeProjection   `json:"volumes"`
	BuildCache       []BuildCacheUsage    `json:"buildCache"`
	// Summary is the authoritative aggregate. Per-image SizeBytes repeats every shared parent
	// layer, so summing Images[].SizeBytes overstates real usage by a large factor.
	Summary SystemDiskUsageSummary `json:"summary"`
}

type SystemDiskUsageSummary struct {
	Images     DiskUsageCategory `json:"images"`
	Containers DiskUsageCategory `json:"containers"`
	Volumes    DiskUsageCategory `json:"volumes"`
	BuildCache DiskUsageCategory `json:"buildCache"`
}

type SystemSnapshotResult struct {
	Context      string          `json:"context"`
	Source       string          `json:"source"`
	APIVersion   string          `json:"apiVersion"`
	Engine       EngineSummary   `json:"engine"`
	DiskUsage    SystemDiskUsage `json:"diskUsage"`
	ObservedAt   string          `json:"observedAt"`
	EndpointHash string          `json:"endpointHash"`
	Limitations  []string        `json:"limitations"`
}

type ContainerInspectParams struct {
	Context string `json:"context"`
	ID      string `json:"id"`
}

type ContainerStateProjection struct {
	Status     string `json:"status,omitempty"`
	Running    bool   `json:"running"`
	Paused     bool   `json:"paused"`
	Restarting bool   `json:"restarting"`
	OOMKilled  bool   `json:"oomKilled"`
	Dead       bool   `json:"dead"`
	PID        int    `json:"pid"`
	ExitCode   int    `json:"exitCode"`
	Error      string `json:"error,omitempty"`
	StartedAt  string `json:"startedAt,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
	Health     string `json:"health,omitempty"`
}

type ContainerMountProjection struct {
	Type        string `json:"type,omitempty"`
	Name        string `json:"name,omitempty"`
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination,omitempty"`
	Driver      string `json:"driver,omitempty"`
	Mode        string `json:"mode,omitempty"`
	RW          bool   `json:"rw"`
	Propagation string `json:"propagation,omitempty"`
}

type ContainerInspectProjection struct {
	ID           string                       `json:"id"`
	Name         string                       `json:"name"`
	Created      string                       `json:"created,omitempty"`
	Path         string                       `json:"path,omitempty"`
	Args         []string                     `json:"args"`
	ImageID      string                       `json:"imageId,omitempty"`
	Driver       string                       `json:"driver,omitempty"`
	Platform     string                       `json:"platform,omitempty"`
	RestartCount int                          `json:"restartCount"`
	LogPath      string                       `json:"logPath,omitempty"`
	State        ContainerStateProjection     `json:"state"`
	Image        string                       `json:"image,omitempty"`
	Hostname     string                       `json:"hostname,omitempty"`
	User         string                       `json:"user,omitempty"`
	WorkingDir   string                       `json:"workingDir,omitempty"`
	Entrypoint   []string                     `json:"entrypoint"`
	Command      []string                     `json:"command"`
	Environment  []string                     `json:"environment"`
	Labels       map[string]string            `json:"labels"`
	Mounts       []ContainerMountProjection   `json:"mounts"`
	Ports        map[string][]PortBinding     `json:"ports"`
	Networks     map[string]NetworkProjection `json:"networks"`
}

type PortBinding struct {
	HostIP   string `json:"hostIp,omitempty"`
	HostPort string `json:"hostPort,omitempty"`
}

type NetworkProjection struct {
	NetworkID  string `json:"networkId,omitempty"`
	EndpointID string `json:"endpointId,omitempty"`
	Gateway    string `json:"gateway,omitempty"`
	IPAddress  string `json:"ipAddress,omitempty"`
	MacAddress string `json:"macAddress,omitempty"`
}

type ContainerInspectResult struct {
	Context      string                     `json:"context"`
	Source       string                     `json:"source"`
	APIVersion   string                     `json:"apiVersion,omitempty"`
	Container    ContainerInspectProjection `json:"container"`
	Document     json.RawMessage            `json:"document"`
	ObservedAt   string                     `json:"observedAt"`
	EndpointHash string                     `json:"endpointHash,omitempty"`
}

type ContainerStatsParams struct {
	Context string `json:"context"`
	ID      string `json:"id"`
}

// ContainersStatsBatchParams samples several containers in one request. The containers list
// showed a permanent em-dash in its CPU and MEMORY columns because stats were only ever
// fetched for the single selected container.
type ContainersStatsBatchParams struct {
	Context string   `json:"context"`
	IDs     []string `json:"ids"`
}

type ContainerStatsSample struct {
	ID string `json:"id"`
	// Exactly one of Stats or Error is set.
	Stats *ContainerStatsResult `json:"stats,omitempty"`
	Error *OpError              `json:"error,omitempty"`
}

type ContainersStatsBatchResult struct {
	Context    string                 `json:"context"`
	Source     string                 `json:"source"`
	Samples    []ContainerStatsSample `json:"samples"`
	ObservedAt string                 `json:"observedAt"`
}

type ContainerStatsResult struct {
	Context          string          `json:"context"`
	Source           string          `json:"source"`
	APIVersion       string          `json:"apiVersion"`
	ContainerID      string          `json:"containerId"`
	ReadAt           string          `json:"readAt,omitempty"`
	CPUPercent       float64         `json:"cpuPercent"`
	CPUUsageTotal    uint64          `json:"cpuUsageTotal"`
	CPUUsageDelta    uint64          `json:"cpuUsageDelta"`
	SystemUsageDelta uint64          `json:"systemUsageDelta"`
	OnlineCPUs       uint32          `json:"onlineCpus"`
	MemoryUsageBytes uint64          `json:"memoryUsageBytes"`
	MemoryWorkingSet uint64          `json:"memoryWorkingSetBytes"`
	MemoryLimitBytes uint64          `json:"memoryLimitBytes"`
	MemoryPercent    float64         `json:"memoryPercent"`
	NetworkRXBytes   uint64          `json:"networkRxBytes"`
	NetworkTXBytes   uint64          `json:"networkTxBytes"`
	BlockReadBytes   uint64          `json:"blockReadBytes"`
	BlockWriteBytes  uint64          `json:"blockWriteBytes"`
	PIDs             uint64          `json:"pids"`
	Document         json.RawMessage `json:"document"`
	ObservedAt       string          `json:"observedAt"`
	EndpointHash     string          `json:"endpointHash"`
}

type ImagesListParams struct {
	Context         string `json:"context"`
	All             *bool  `json:"all,omitempty"`
	IncludeDangling bool   `json:"includeDangling,omitempty"`
}

type ImageProjection struct {
	ID             string            `json:"id"`
	ParentID       string            `json:"parentId,omitempty"`
	RepoTags       []string          `json:"repoTags"`
	RepoDigests    []string          `json:"repoDigests"`
	Created        int64             `json:"created"`
	SizeBytes      int64             `json:"sizeBytes"`
	SharedBytes    int64             `json:"sharedBytes"`
	VirtualBytes   int64             `json:"virtualBytes"`
	Containers     int64             `json:"containers"`
	Labels         map[string]string `json:"labels"`
	SizeDisplay    string            `json:"sizeDisplay,omitempty"`
	CreatedDisplay string            `json:"createdDisplay,omitempty"`
}

type ImagesListResult struct {
	Context      string            `json:"context"`
	Source       string            `json:"source"`
	APIVersion   string            `json:"apiVersion,omitempty"`
	Images       []ImageProjection `json:"images"`
	ObservedAt   string            `json:"observedAt"`
	EndpointHash string            `json:"endpointHash,omitempty"`
	Limitations  []string          `json:"limitations"`
}

type DomainOperationReceipt struct {
	OperationID  string `json:"operationId"`
	Context      string `json:"context"`
	Domain       string `json:"domain"`
	ResourceID   string `json:"resourceId,omitempty"`
	Action       string `json:"action"`
	Source       string `json:"source"`
	Outcome      string `json:"outcome"`
	HTTPStatus   int    `json:"httpStatus,omitempty"`
	ExitCode     *int   `json:"exitCode,omitempty"`
	StartedAt    string `json:"startedAt"`
	CompletedAt  string `json:"completedAt,omitempty"`
	DurationMs   int64  `json:"durationMs,omitempty"`
	EndpointHash string `json:"endpointHash,omitempty"`
	Stdout       string `json:"stdout,omitempty"`
	Stderr       string `json:"stderr,omitempty"`
}

type ImagesActionParams struct {
	Context           string              `json:"context"`
	Action            string              `json:"action"`
	ID                string              `json:"id,omitempty"`
	Reference         string              `json:"reference,omitempty"`
	Force             bool                `json:"force,omitempty"`
	NoPrune           bool                `json:"noPrune,omitempty"`
	Filters           map[string][]string `json:"filters,omitempty"`
	Confirmed         bool                `json:"confirmed,omitempty"`
	Cwd               string              `json:"cwd,omitempty"`
	TimeoutSeconds    int                 `json:"timeoutSeconds,omitempty"`
	OutputWindowBytes int                 `json:"outputWindowBytes,omitempty"`
	MaxOutputBytes    int64               `json:"maxOutputBytes,omitempty"`
	// ArchivePath is the host file that save writes to and load reads from. Streaming a
	// multi-gigabyte tar through the JSON transport is not viable, so Docker's own -o/-i
	// file handling is used instead.
	ArchivePath string `json:"archivePath,omitempty"`
	// Overwrite is the operator's explicit decision to replace an existing file, which
	// Docker's --output would otherwise do silently.
	Overwrite bool `json:"overwrite,omitempty"`
}

type ContainersExportParams struct {
	Context           string `json:"context"`
	ID                string `json:"id"`
	ArchivePath       string `json:"archivePath"`
	Overwrite         bool   `json:"overwrite,omitempty"`
	Cwd               string `json:"cwd,omitempty"`
	TimeoutSeconds    int    `json:"timeoutSeconds,omitempty"`
	OutputWindowBytes int    `json:"outputWindowBytes,omitempty"`
}

type ImageDeleteRecord struct {
	Deleted  string `json:"deleted,omitempty"`
	Untagged string `json:"untagged,omitempty"`
}

type ImagePruneResult struct {
	ImagesDeleted  []ImageDeleteRecord `json:"imagesDeleted"`
	SpaceReclaimed uint64              `json:"spaceReclaimedBytes"`
}

type ImagesActionResult struct {
	Action  string                 `json:"action"`
	Receipt DomainOperationReceipt `json:"receipt"`
	Deleted []ImageDeleteRecord    `json:"deleted,omitempty"`
	Prune   *ImagePruneResult      `json:"prune,omitempty"`
	Session *SessionStartResult    `json:"session,omitempty"`
	// Registry is where a push is going, derived from the reference. Reported so the UI can
	// name the destination it is about to publish to rather than restating the tag.
	Registry string `json:"registry,omitempty"`
}

type VolumesListParams struct {
	Context string `json:"context"`
}

type VolumesListResult struct {
	Context      string             `json:"context"`
	Source       string             `json:"source"`
	APIVersion   string             `json:"apiVersion,omitempty"`
	Volumes      []VolumeProjection `json:"volumes"`
	Warnings     []string           `json:"warnings"`
	ObservedAt   string             `json:"observedAt"`
	EndpointHash string             `json:"endpointHash,omitempty"`
	Limitations  []string           `json:"limitations"`
}

type VolumesActionParams struct {
	Context    string              `json:"context"`
	Action     string              `json:"action"`
	Name       string              `json:"name,omitempty"`
	Driver     string              `json:"driver,omitempty"`
	DriverOpts map[string]string   `json:"driverOpts,omitempty"`
	Labels     map[string]string   `json:"labels,omitempty"`
	Force      bool                `json:"force,omitempty"`
	Filters    map[string][]string `json:"filters,omitempty"`
	Confirmed  bool                `json:"confirmed,omitempty"`
}

type VolumePruneResult struct {
	VolumesDeleted []string `json:"volumesDeleted"`
	SpaceReclaimed uint64   `json:"spaceReclaimedBytes"`
}

type VolumesActionResult struct {
	Action  string                 `json:"action"`
	Receipt DomainOperationReceipt `json:"receipt"`
	Volume  *VolumeProjection      `json:"volume,omitempty"`
	Prune   *VolumePruneResult     `json:"prune,omitempty"`
}

// NetworkSummary is one row of `docker network ls`. Distinct from NetworkProjection, which
// describes a single container's attachment to a network in an inspect result.
// ContainersCreateParams is a deliberately narrow `docker run`: the options a create form
// needs, each validated, rather than an arbitrary argv passthrough.
type ContainersCreateParams struct {
	Context string `json:"context"`
	Image   string `json:"image"`
	Name    string `json:"name,omitempty"`
	// Command overrides the image entrypoint's default command.
	Command []string `json:"command,omitempty"`
	// Env entries are KEY=VALUE, matching Docker.
	Env []string `json:"env,omitempty"`
	// Ports map "hostPort" to "containerPort/proto", e.g. {"8080": "80/tcp"}.
	Ports map[string]string `json:"ports,omitempty"`
	// Binds are Docker mount specs, e.g. "/host:/container:ro".
	Binds         []string          `json:"binds,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	RestartPolicy string            `json:"restartPolicy,omitempty"`
	Network       string            `json:"network,omitempty"`
	AutoRemove    bool              `json:"autoRemove,omitempty"`
	// Start runs the container immediately after creating it.
	Start bool `json:"start,omitempty"`
}

type ContainersCreateResult struct {
	Context  string                 `json:"context"`
	ID       string                 `json:"id"`
	Warnings []string               `json:"warnings"`
	Started  bool                   `json:"started"`
	Receipt  DomainOperationReceipt `json:"receipt"`
}

type ImageLayer struct {
	ID        string   `json:"id,omitempty"`
	Created   int64    `json:"created"`
	CreatedBy string   `json:"createdBy,omitempty"`
	SizeBytes int64    `json:"sizeBytes"`
	Comment   string   `json:"comment,omitempty"`
	Tags      []string `json:"tags"`
	// EmptyLayer marks metadata-only history entries, which contribute no size.
	EmptyLayer bool `json:"emptyLayer"`
}

type ImageDetail struct {
	ID            string            `json:"id"`
	RepoTags      []string          `json:"repoTags"`
	RepoDigests   []string          `json:"repoDigests"`
	Parent        string            `json:"parent,omitempty"`
	Comment       string            `json:"comment,omitempty"`
	Created       string            `json:"created,omitempty"`
	DockerVersion string            `json:"dockerVersion,omitempty"`
	Author        string            `json:"author,omitempty"`
	Architecture  string            `json:"architecture,omitempty"`
	OS            string            `json:"os,omitempty"`
	SizeBytes     int64             `json:"sizeBytes"`
	Labels        map[string]string `json:"labels"`
	Env           []string          `json:"env"`
	Entrypoint    []string          `json:"entrypoint"`
	Command       []string          `json:"command"`
	WorkingDir    string            `json:"workingDir,omitempty"`
	ExposedPorts  []string          `json:"exposedPorts"`
	RootFSLayers  []string          `json:"rootFsLayers"`
}

type ImagesInspectParams struct {
	Context string `json:"context"`
	// Full immutable sha256:<64 hex> image ID.
	ID string `json:"id"`
}

type ImagesInspectResult struct {
	Context    string          `json:"context"`
	Source     string          `json:"source"`
	Image      ImageDetail     `json:"image"`
	History    []ImageLayer    `json:"history"`
	Document   json.RawMessage `json:"document"`
	ObservedAt string          `json:"observedAt"`
}

// ContainerFileEntry is one row of a container-filesystem listing.
type ContainerFileEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	Mode       string `json:"mode"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
	IsDir      bool   `json:"isDir"`
	// LinkTarget is set for symlinks so the UI can show where they point.
	LinkTarget string `json:"linkTarget,omitempty"`
}

type ContainerFilesParams struct {
	Context string `json:"context"`
	ID      string `json:"id"`
	// Absolute path inside the container. Defaults to "/".
	Path string `json:"path,omitempty"`
}

type ContainerFilesResult struct {
	Context string               `json:"context"`
	Source  string               `json:"source"`
	Path    string               `json:"path"`
	Entries []ContainerFileEntry `json:"entries"`
	// Truncated reports that the listing hit its entry cap; the directory has more.
	Truncated   bool     `json:"truncated"`
	ObservedAt  string   `json:"observedAt"`
	Limitations []string `json:"limitations"`
}

type ContainerFileReadParams struct {
	Context string `json:"context"`
	ID      string `json:"id"`
	Path    string `json:"path"`
}

type ContainerFileReadResult struct {
	Context    string `json:"context"`
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	Encoding   string `json:"encoding"`
	Content    string `json:"content"`
	Truncated  bool   `json:"truncated"`
	ObservedAt string `json:"observedAt"`
}

type ContainerProcess struct {
	Values []string `json:"values"`
}

type ContainerTopResult struct {
	Context    string             `json:"context"`
	Titles     []string           `json:"titles"`
	Processes  []ContainerProcess `json:"processes"`
	ObservedAt string             `json:"observedAt"`
}

type ContainerChange struct {
	Path string `json:"path"`
	// Kind is "modified", "added" or "deleted", projected from Docker's 0/1/2.
	Kind string `json:"kind"`
}

type ContainerDiffResult struct {
	Context    string            `json:"context"`
	Changes    []ContainerChange `json:"changes"`
	ObservedAt string            `json:"observedAt"`
}

type NetworkSummary struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Driver     string            `json:"driver"`
	Scope      string            `json:"scope,omitempty"`
	Created    string            `json:"created,omitempty"`
	Internal   bool              `json:"internal"`
	Attachable bool              `json:"attachable"`
	Ingress    bool              `json:"ingress"`
	EnableIPv6 bool              `json:"enableIpv6"`
	IPAMDriver string            `json:"ipamDriver,omitempty"`
	Subnets    []string          `json:"subnets"`
	Gateways   []string          `json:"gateways"`
	Labels     map[string]string `json:"labels"`
	Options    map[string]string `json:"options"`
	// Predefined networks (bridge, host, none) cannot be removed; Docker rejects the attempt.
	Predefined bool `json:"predefined"`
	// ContainerCount is -1 when the transport cannot report attachments.
	ContainerCount int `json:"containerCount"`
}

type NetworksListParams struct {
	Context string `json:"context"`
}

type NetworksListResult struct {
	Context      string           `json:"context"`
	Source       string           `json:"source"`
	APIVersion   string           `json:"apiVersion,omitempty"`
	Networks     []NetworkSummary `json:"networks"`
	ObservedAt   string           `json:"observedAt"`
	EndpointHash string           `json:"endpointHash,omitempty"`
	Limitations  []string         `json:"limitations"`
}

type NetworksActionParams struct {
	Context string `json:"context"`
	Action  string `json:"action"`
	// Name is used by create; ID targets an existing network for the other actions.
	Name       string            `json:"name,omitempty"`
	ID         string            `json:"id,omitempty"`
	Driver     string            `json:"driver,omitempty"`
	Subnet     string            `json:"subnet,omitempty"`
	Gateway    string            `json:"gateway,omitempty"`
	Internal   bool              `json:"internal,omitempty"`
	Attachable bool              `json:"attachable,omitempty"`
	EnableIPv6 bool              `json:"enableIpv6,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Options    map[string]string `json:"options,omitempty"`
	// ContainerID targets connect/disconnect.
	ContainerID string              `json:"containerId,omitempty"`
	Force       bool                `json:"force,omitempty"`
	Filters     map[string][]string `json:"filters,omitempty"`
	Confirmed   bool                `json:"confirmed,omitempty"`
}

type NetworkPruneResult struct {
	NetworksDeleted []string `json:"networksDeleted"`
}

type NetworksActionResult struct {
	Action  string                 `json:"action"`
	Receipt DomainOperationReceipt `json:"receipt"`
	Network *NetworkSummary        `json:"network,omitempty"`
	Prune   *NetworkPruneResult    `json:"prune,omitempty"`
}

type ContainerActionOptions struct {
	TimeoutSeconds int  `json:"timeoutSeconds,omitempty"`
	Force          bool `json:"force,omitempty"`
	Volumes        bool `json:"volumes,omitempty"`
	Confirmed      bool `json:"confirmed,omitempty"`
	// Signal is valid only for the kill action, e.g. "SIGTERM". Empty means Docker's
	// default, which is SIGKILL.
	Signal string `json:"signal,omitempty"`
	// Name is valid only for rename.
	Name string `json:"name,omitempty"`
	// Resource limits, valid only for update. Zero means "leave unchanged", matching
	// Docker's own behaviour for an omitted field.
	CPUShares   int64 `json:"cpuShares,omitempty"`
	MemoryBytes int64 `json:"memoryBytes,omitempty"`
	// RestartPolicy is valid only for update.
	RestartPolicy string `json:"restartPolicy,omitempty"`
}

type ContainersCommitParams struct {
	Context string `json:"context"`
	ID      string `json:"id"`
	// Repository and tag for the new image.
	Repository string   `json:"repository"`
	Tag        string   `json:"tag,omitempty"`
	Comment    string   `json:"comment,omitempty"`
	Author     string   `json:"author,omitempty"`
	Pause      bool     `json:"pause,omitempty"`
	Changes    []string `json:"changes,omitempty"`
}

type ContainersCommitResult struct {
	Context    string                 `json:"context"`
	ImageID    string                 `json:"imageId"`
	Receipt    DomainOperationReceipt `json:"receipt"`
	ObservedAt string                 `json:"observedAt"`
}

type RegistryImageResult struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Stars       int    `json:"stars"`
	Official    bool   `json:"official"`
}

type ImagesSearchParams struct {
	Context string `json:"context"`
	Term    string `json:"term"`
	Limit   int    `json:"limit,omitempty"`
}

type ImagesSearchResult struct {
	Context    string                `json:"context"`
	Term       string                `json:"term"`
	Results    []RegistryImageResult `json:"results"`
	ObservedAt string                `json:"observedAt"`
}

type ContainersActionParams struct {
	Context string                 `json:"context"`
	ID      string                 `json:"id"`
	Action  string                 `json:"action"`
	Options ContainerActionOptions `json:"options,omitempty"`
}

type OperationReceipt struct {
	OperationID  string `json:"operationId"`
	Context      string `json:"context"`
	ContainerID  string `json:"containerId"`
	Action       string `json:"action"`
	Source       string `json:"source"`
	Outcome      string `json:"outcome"`
	HTTPStatus   int    `json:"httpStatus,omitempty"`
	ExitCode     *int   `json:"exitCode,omitempty"`
	StartedAt    string `json:"startedAt"`
	CompletedAt  string `json:"completedAt"`
	DurationMs   int64  `json:"durationMs"`
	EndpointHash string `json:"endpointHash,omitempty"`
	Stdout       string `json:"stdout,omitempty"`
	Stderr       string `json:"stderr,omitempty"`
}

type CLIRunParams struct {
	Context        string            `json:"context"`
	TargetMode     string            `json:"targetMode,omitempty"`
	Argv           []string          `json:"argv"`
	Cwd            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
	Interactive    bool              `json:"interactive,omitempty"`
	Streaming      bool              `json:"streaming,omitempty"`
}

type CapturedOutput struct {
	Data      string `json:"data"`
	Encoding  string `json:"encoding"`
	Bytes     int64  `json:"bytes"`
	Truncated bool   `json:"truncated"`
}

type CLIRunResult struct {
	OperationID string         `json:"operationId"`
	Context     string         `json:"context"`
	TargetMode  string         `json:"targetMode"`
	Executable  string         `json:"executable"`
	Argv        []string       `json:"argv"`
	Cwd         string         `json:"cwd"`
	ExitCode    int            `json:"exitCode"`
	TimedOut    bool           `json:"timedOut"`
	StartedAt   string         `json:"startedAt"`
	CompletedAt string         `json:"completedAt"`
	DurationMs  int64          `json:"durationMs"`
	Stdout      CapturedOutput `json:"stdout"`
	Stderr      CapturedOutput `json:"stderr"`
}

type SessionStartParams struct {
	Context           string            `json:"context"`
	TargetMode        string            `json:"targetMode,omitempty"`
	Argv              []string          `json:"argv"`
	Cwd               string            `json:"cwd,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	Mode              string            `json:"mode"`
	Rows              int               `json:"rows,omitempty"`
	Cols              int               `json:"cols,omitempty"`
	TimeoutSeconds    int               `json:"timeoutSeconds,omitempty"`
	OutputWindowBytes int               `json:"outputWindowBytes,omitempty"`
	MaxOutputBytes    int64             `json:"maxOutputBytes,omitempty"`
}

type SessionStartResult struct {
	SessionID         string   `json:"sessionId"`
	Mode              string   `json:"mode"`
	PID               int      `json:"pid"`
	Context           string   `json:"context"`
	TargetMode        string   `json:"targetMode"`
	Executable        string   `json:"executable"`
	Argv              []string `json:"argv"`
	Cwd               string   `json:"cwd"`
	Rows              int      `json:"rows,omitempty"`
	Cols              int      `json:"cols,omitempty"`
	OutputWindowBytes int      `json:"outputWindowBytes"`
	MaxOutputBytes    int64    `json:"maxOutputBytes"`
	StartedAt         string   `json:"startedAt"`
}

type SessionInputParams struct {
	SessionID string `json:"sessionId"`
	Data      string `json:"data,omitempty"`
	Encoding  string `json:"encoding,omitempty"`
	EOF       bool   `json:"eof,omitempty"`
}

type SessionInputResult struct {
	SessionID     string `json:"sessionId"`
	AcceptedBytes int    `json:"acceptedBytes"`
	EOF           bool   `json:"eof"`
}

type SessionResizeParams struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
}

type SessionResizeResult struct {
	SessionID string `json:"sessionId"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
}

type SessionSignalParams struct {
	SessionID string `json:"sessionId"`
	Signal    string `json:"signal"`
}

type SessionSignalResult struct {
	SessionID string `json:"sessionId"`
	Signal    string `json:"signal"`
	Accepted  bool   `json:"accepted"`
}

type SessionCancelParams struct {
	SessionID     string `json:"sessionId"`
	GracePeriodMs *int   `json:"gracePeriodMs,omitempty"`
}

type SessionCancelResult struct {
	SessionID string `json:"sessionId"`
	Accepted  bool   `json:"accepted"`
	State     string `json:"state"`
}

type SessionAckParams struct {
	SessionID       string `json:"sessionId"`
	ThroughSequence uint64 `json:"throughSequence"`
}

type SessionAckResult struct {
	SessionID        string `json:"sessionId"`
	ThroughSequence  uint64 `json:"throughSequence"`
	OutstandingBytes int64  `json:"outstandingBytes"`
}

type SessionOutputEvent struct {
	SessionID string `json:"sessionId"`
	Sequence  uint64 `json:"sequence"`
	Stream    string `json:"stream"`
	Data      string `json:"data"`
	Encoding  string `json:"encoding"`
	Bytes     int    `json:"bytes"`
}

type SessionStartedEvent struct {
	SessionStartResult
	State string `json:"state"`
}

type SessionTruncatedEvent struct {
	SessionID      string `json:"sessionId"`
	MaxOutputBytes int64  `json:"maxOutputBytes"`
	DroppedBytes   int64  `json:"droppedBytes"`
}

type SessionExitOutput struct {
	StdoutBytes  int64  `json:"stdoutBytes"`
	StderrBytes  int64  `json:"stderrBytes"`
	PTYBytes     int64  `json:"ptyBytes"`
	EmittedBytes int64  `json:"emittedBytes"`
	DroppedBytes int64  `json:"droppedBytes"`
	Truncated    bool   `json:"truncated"`
	LastSequence uint64 `json:"lastSequence"`
}

type SessionExitedEvent struct {
	SessionID  string            `json:"sessionId"`
	State      string            `json:"state"`
	ExitCode   int               `json:"exitCode"`
	Signal     string            `json:"signal,omitempty"`
	TimedOut   bool              `json:"timedOut"`
	Canceled   bool              `json:"canceled"`
	StartedAt  string            `json:"startedAt"`
	ExitedAt   string            `json:"exitedAt"`
	DurationMs int64             `json:"durationMs"`
	Output     SessionExitOutput `json:"output"`
}

func decodeStrict(raw json.RawMessage, target any) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage(`{}`)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// Compose is a CLI plugin with no Engine API surface at all, so every compose method is
// CLI-routed. The plugin also frames its JSON two different ways: `compose ls` emits a single
// JSON array, while `compose ps` emits one object per line. Both are handled explicitly
// rather than assumed, because the failure mode of guessing is an empty list rather than an
// error — a project surface that silently shows nothing.

type ComposeListParams struct {
	Context string `json:"context"`
	// All includes projects whose containers all exited, matching `compose ls --all`.
	All bool `json:"all,omitempty"`
}

// ComposeStateCount is one term of Compose's status string, e.g. `running(19)`.
type ComposeStateCount struct {
	State string `json:"state"`
	Count int    `json:"count"`
}

type ComposeProject struct {
	Name string `json:"name"`
	// Status is Compose's own summary, e.g. "exited(3), running(19)".
	Status string `json:"status"`
	// States is Status parsed into terms so the UI does not have to re-parse a display string.
	States []ComposeStateCount `json:"states"`
	// ConfigFiles is required to run `up`; stop/start/restart/down find containers by label.
	ConfigFiles  []string `json:"configFiles"`
	RunningCount int      `json:"runningCount"`
	TotalCount   int      `json:"totalCount"`
}

type ComposeListResult struct {
	Context     string           `json:"context"`
	Source      string           `json:"source"`
	Projects    []ComposeProject `json:"projects"`
	ObservedAt  string           `json:"observedAt"`
	Limitations []string         `json:"limitations"`
}

type ComposePsParams struct {
	Context string `json:"context"`
	Project string `json:"project"`
}

type ComposeService struct {
	Name        string `json:"name"`
	Service     string `json:"service"`
	ContainerID string `json:"containerId"`
	Image       string `json:"image"`
	State       string `json:"state"`
	Status      string `json:"status"`
	Health      string `json:"health,omitempty"`
	ExitCode    int    `json:"exitCode"`
	Ports       string `json:"ports,omitempty"`
}

type ComposePsResult struct {
	Context     string           `json:"context"`
	Project     string           `json:"project"`
	Source      string           `json:"source"`
	Services    []ComposeService `json:"services"`
	ObservedAt  string           `json:"observedAt"`
	Limitations []string         `json:"limitations"`
}

type ComposeActionParams struct {
	Context string `json:"context"`
	Project string `json:"project"`
	Action  string `json:"action"`
	// ConfigFiles is required for `up`: Compose can find existing containers by label, but it
	// cannot recreate them without the file that defines them.
	ConfigFiles []string `json:"configFiles,omitempty"`
	// Down removes containers and networks, so it carries the same confirmation requirement
	// as every other destructive verb. RemoveVolumes additionally discards data.
	Confirmed bool `json:"confirmed,omitempty"`
	// RemoveVolumes destroys data, which plain `down` does not, so it carries its own
	// agreement rather than riding on the confirmation for taking the project down.
	RemoveVolumes          bool `json:"removeVolumes,omitempty"`
	ConfirmedRemoveVolumes bool `json:"confirmedRemoveVolumes,omitempty"`
	RemoveOrphans          bool `json:"removeOrphans,omitempty"`
	TimeoutSeconds         int  `json:"timeoutSeconds,omitempty"`
	OutputWindowBytes      int  `json:"outputWindowBytes,omitempty"`
}

type ComposeActionResult struct {
	Action  string                 `json:"action"`
	Project string                 `json:"project"`
	Receipt DomainOperationReceipt `json:"receipt"`
	Session *SessionStartResult    `json:"session,omitempty"`
}

// Volume browsing mounts the volume read-only into a helper container that is created and
// never started, then reads it through the same archive endpoint the container file browser
// uses. Docker exposes no way to read a volume directly; this is the approach Docker Desktop
// takes too.

type VolumeFilesParams struct {
	Context string `json:"context"`
	Name    string `json:"name"`
	Path    string `json:"path,omitempty"`
}

type VolumeFilesResult struct {
	Context     string               `json:"context"`
	Volume      string               `json:"volume"`
	Source      string               `json:"source"`
	Path        string               `json:"path"`
	Entries     []ContainerFileEntry `json:"entries"`
	Truncated   bool                 `json:"truncated"`
	ObservedAt  string               `json:"observedAt"`
	Limitations []string             `json:"limitations"`
}

type VolumeFileReadParams struct {
	Context string `json:"context"`
	Name    string `json:"name"`
	Path    string `json:"path"`
}

type VolumeFileReadResult struct {
	Context    string `json:"context"`
	Volume     string `json:"volume"`
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	Encoding   string `json:"encoding"`
	Content    string `json:"content"`
	Truncated  bool   `json:"truncated"`
	ObservedAt string `json:"observedAt"`
}

// Scout is an optional CLI plugin with no Engine API. Its SARIF report is projected here so
// the renderer never parses SARIF itself.

type ImagesScoutParams struct {
	Context string `json:"context"`
	// A tag or an immutable image ID; Scout accepts either, so dangling images can be scanned.
	Reference string `json:"reference"`
}

type ScoutFinding struct {
	ID       string  `json:"id"`
	Severity string  `json:"severity"`
	Score    float64 `json:"score,omitempty"`
	Package  string  `json:"package,omitempty"`
	// InstalledVersion is what the image actually carries; FixedVersion is the upgrade that
	// resolves the CVE, and is the only actionable field in a vulnerability report.
	InstalledVersion string `json:"installedVersion,omitempty"`
	AffectedVersion  string `json:"affectedVersion,omitempty"`
	FixedVersion     string `json:"fixedVersion,omitempty"`
	URL              string `json:"url,omitempty"`
}

type ImagesScoutResult struct {
	Context     string         `json:"context"`
	Reference   string         `json:"reference"`
	Source      string         `json:"source"`
	Scanner     string         `json:"scanner,omitempty"`
	Summary     map[string]int `json:"summary"`
	Total       int            `json:"total"`
	Findings    []ScoutFinding `json:"findings"`
	ObservedAt  string         `json:"observedAt"`
	Limitations []string       `json:"limitations"`
}

type VolumeFileWriteParams struct {
	Context  string `json:"context"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	FileName string `json:"fileName"`
	Content  string `json:"content"`
	Mode     int64  `json:"mode,omitempty"`
	// ConfirmedInUse acknowledges writing into a volume a running container holds. Docker
	// permits it; a live database will not survive it gracefully.
	ConfirmedInUse bool `json:"confirmedInUse,omitempty"`
}

type VolumeFileWriteResult struct {
	Context    string `json:"context"`
	Volume     string `json:"volume"`
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	ObservedAt string `json:"observedAt"`
}

type VolumeBackupParams struct {
	Context     string `json:"context"`
	Name        string `json:"name"`
	ArchivePath string `json:"archivePath"`
	Overwrite   bool   `json:"overwrite,omitempty"`
}

type VolumeBackupResult struct {
	Context     string `json:"context"`
	Volume      string `json:"volume"`
	ArchivePath string `json:"archivePath"`
	Entries     int    `json:"entries"`
	SizeBytes   int64  `json:"sizeBytes"`
	ObservedAt  string `json:"observedAt"`
}

type VolumeRestoreParams struct {
	Context     string `json:"context"`
	Name        string `json:"name"`
	ArchivePath string `json:"archivePath"`
	// Restoring writes over whatever the volume already holds.
	Confirmed      bool `json:"confirmed,omitempty"`
	ConfirmedInUse bool `json:"confirmedInUse,omitempty"`
}

type VolumeRestoreResult struct {
	Context     string `json:"context"`
	Volume      string `json:"volume"`
	ArchivePath string `json:"archivePath"`
	ObservedAt  string `json:"observedAt"`
}
