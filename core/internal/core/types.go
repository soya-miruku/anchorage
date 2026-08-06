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
	Name          string `json:"name"`
	Version       string `json:"version,omitempty"`
	Vendor        string `json:"vendor,omitempty"`
	Description   string `json:"description,omitempty"`
	Path          string `json:"path,omitempty"`
	SchemaVersion string `json:"schemaVersion,omitempty"`
	Status        string `json:"status"`
	// Fault names why the CLI skipped this entry, as a value rather than as prose. The note
	// below says the same thing in words for the operator; a surface deciding which repair to
	// offer must not have to match on that wording.
	Fault            string `json:"fault,omitempty"`
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

type ContextsParams struct {
	Context string `json:"context,omitempty"`
}

// ContextsResult is deliberately a subset of CapabilitiesResult rather than a version of it
// with fields left empty: a caller can tell from the shape that no capability or command
// discovery was attempted, instead of having to know that empty means "not asked".
type ContextsResult struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Binary          *BinaryFingerprint `json:"binary,omitempty"`
	BinaryError     *OpError           `json:"binaryError,omitempty"`
	SelectedContext string             `json:"selectedContext,omitempty"`
	CurrentContext  string             `json:"currentContext,omitempty"`
	Contexts        []DockerContext    `json:"contexts"`
	// Versions carries both sides of `docker version`. The CLI's own version is not available
	// from the Engine API at all — `/version` describes the daemon — so a client/server skew,
	// which is the thing that actually breaks an operator, can only be seen from here.
	Versions   DockerVersions `json:"versions"`
	Warnings   []string       `json:"warnings"`
	ObservedAt string         `json:"observedAt"`
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

// ComposeConfigParams resolves a project's configuration. Compose finds a running project by
// label, but it cannot render a configuration it was never given, so the files `compose ls`
// reported are required here exactly as they are for `up`.
type ComposeConfigParams struct {
	Context     string   `json:"context"`
	Project     string   `json:"project"`
	ConfigFiles []string `json:"configFiles"`
}

type ComposeDependsOn struct {
	Service   string `json:"service"`
	Condition string `json:"condition"`
	// Restart asks Compose to restart this service when the dependency is restarted.
	Restart bool `json:"restart,omitempty"`
	// Required false means Compose starts this service even when the dependency is absent.
	Required bool `json:"required"`
}

type ComposeWatchRule struct {
	Path   string `json:"path"`
	Action string `json:"action"`
	Target string `json:"target,omitempty"`
	// Ignore and Include filter the watched tree; Command is the argv an `exec` rule runs.
	Ignore  []string `json:"ignore,omitempty"`
	Include []string `json:"include,omitempty"`
	Command []string `json:"command,omitempty"`
}

type ComposeLifecycleHook struct {
	// Phase is "post_start" or "pre_stop": the point in the container's life Compose runs it.
	Phase   string   `json:"phase"`
	Command []string `json:"command"`
	// User is the hook's own user, or the service's where the hook does not name one. Empty
	// means the file does not say, and the image's user decides.
	User string `json:"user,omitempty"`
	// RunsAsRoot is true only where a declared user resolves to root. An unstated user is
	// never reported as root: the resolved file does not carry the image's own default.
	RunsAsRoot bool   `json:"runsAsRoot"`
	Privileged bool   `json:"privileged,omitempty"`
	WorkingDir string `json:"workingDir,omitempty"`
}

type ComposeConfigService struct {
	Name  string `json:"name"`
	Image string `json:"image,omitempty"`
	// Profiles gates a service: one that declares a profile does not start unless that
	// profile is selected, wherever it sits in the start order.
	Profiles []string `json:"profiles,omitempty"`
	// StartOrder is the wave Compose starts the service in: 0 when it waits for nothing,
	// otherwise one past the deepest service it declares a dependency on.
	StartOrder int                    `json:"startOrder"`
	DependsOn  []ComposeDependsOn     `json:"dependsOn"`
	Watch      []ComposeWatchRule     `json:"watch"`
	Hooks      []ComposeLifecycleHook `json:"hooks"`
}

// ComposeDeclaredDependency is something the project declares but does not itself run.
type ComposeDeclaredDependency struct {
	// Kind is "model", "provider", "secret" or "volume".
	Kind string `json:"kind"`
	Name string `json:"name"`
	// Resource is what Compose resolves the declaration to where the rendered file names one:
	// the Docker-side name of a volume or secret, the type of a provider.
	Resource string `json:"resource,omitempty"`
	External bool   `json:"external,omitempty"`
	// Services are the services that declare it, so the UI can draw the edge.
	Services []string `json:"services"`
}

type ComposeConfigResult struct {
	Context      string                      `json:"context"`
	Project      string                      `json:"project"`
	Source       string                      `json:"source"`
	ConfigFiles  []string                    `json:"configFiles"`
	Services     []ComposeConfigService      `json:"services"`
	Dependencies []ComposeDeclaredDependency `json:"dependencies"`
	ObservedAt   string                      `json:"observedAt"`
	Limitations  []string                    `json:"limitations"`
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

// Docker has no clone or empty verb for volumes. Both are built from the same never-started
// helper the browser uses: a clone streams one volume's archive into another, and an empty
// has to remove and recreate the volume, because the archive endpoint can write files but
// cannot delete them.

type VolumeCloneParams struct {
	Context string `json:"context"`
	Name    string `json:"name"`
	// Target must not already exist: a clone that wrote into an existing volume would be a
	// restore over data the operator never named.
	Target string `json:"target"`
}

type VolumeCloneResult struct {
	Context     string   `json:"context"`
	Volume      string   `json:"volume"`
	Target      string   `json:"target"`
	Entries     int      `json:"entries"`
	SizeBytes   int64    `json:"sizeBytes"`
	ObservedAt  string   `json:"observedAt"`
	Limitations []string `json:"limitations"`
}

type VolumeEmptyParams struct {
	Context string `json:"context"`
	Name    string `json:"name"`
	// Emptying discards every byte the volume holds and nothing restores it.
	Confirmed bool `json:"confirmed,omitempty"`
}

type VolumeEmptyResult struct {
	Context string `json:"context"`
	Volume  string `json:"volume"`
	// Recreated is the volume as it exists after the operation, so the UI can replace the row
	// rather than infer what removing and recreating produced.
	Recreated   *VolumeProjection `json:"recreated,omitempty"`
	ObservedAt  string            `json:"observedAt"`
	Limitations []string          `json:"limitations"`
}

type BuildsListParams struct {
	Context string `json:"context"`
}

type BuildBuilderNode struct {
	Name      string   `json:"name"`
	Status    string   `json:"status"`
	Version   string   `json:"version,omitempty"`
	Platforms []string `json:"platforms"`
}

type BuildBuilder struct {
	Name    string `json:"name"`
	Driver  string `json:"driver"`
	Current bool   `json:"current"`
	// Error is buildx's own note about a builder it could not reach.
	Error string             `json:"error,omitempty"`
	Nodes []BuildBuilderNode `json:"nodes"`
}

// BuilderActionParams operates on one buildx builder.
//
// Two actions, both of which buildx itself performs — this adds no capability Docker does not
// already expose, it only reaches the two verbs an operator needs when a builder is listed as
// unreachable and the table could previously do nothing about it:
//
//   - bootstrap: `buildx inspect --bootstrap`, which starts the builder's node and is the
//     repair for the common "cannot reach" case.
//   - remove: `buildx rm`, which deletes the builder and its cache.
//
// Switching the active builder is deliberately still absent. `buildx use` rewrites the CLI's
// own configuration for every tool on the machine, which is not this application's to change.
type BuilderActionParams struct {
	Context string `json:"context"`
	Name    string `json:"name"`
	Action  string `json:"action"`
	// Confirmed must be set for remove: the builder's cache does not survive it.
	Confirmed bool `json:"confirmed,omitempty"`
}

// BuilderActionResult reports buildx's own words and the re-read inventory.
type BuilderActionResult struct {
	ProtocolVersion string `json:"protocolVersion"`
	Context         string `json:"context"`
	Name            string `json:"name"`
	Action          string `json:"action"`
	Outcome         string `json:"outcome"`
	// Output is what buildx printed. A bootstrap that succeeds still has something to say
	// about the node it started, and a failure is only explicable in buildx's own terms.
	Output     string         `json:"output,omitempty"`
	Builders   []BuildBuilder `json:"builders"`
	ObservedAt string         `json:"observedAt"`
}

type BuildRecord struct {
	ID   string `json:"id"`
	Ref  string `json:"ref"`
	Name string `json:"name"`
	// success | failed | cancelled | running | unknown
	Status         string `json:"status"`
	CreatedAt      string `json:"createdAt"`
	CompletedAt    string `json:"completedAt,omitempty"`
	DurationMs     int64  `json:"durationMs,omitempty"`
	TotalSteps     int    `json:"totalSteps"`
	CompletedSteps int    `json:"completedSteps"`
	CachedSteps    int    `json:"cachedSteps"`
}

type BuildsListResult struct {
	Context     string         `json:"context"`
	Source      string         `json:"source"`
	Builders    []BuildBuilder `json:"builders"`
	Records     []BuildRecord  `json:"records"`
	ObservedAt  string         `json:"observedAt"`
	Limitations []string       `json:"limitations"`
}

type BuildsInspectParams struct {
	Context string `json:"context"`
	Ref     string `json:"ref"`
}

type BuildsInspectResult struct {
	Context        string   `json:"context"`
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	BuildContext   string   `json:"buildContext,omitempty"`
	Dockerfile     string   `json:"dockerfile,omitempty"`
	VCSRepository  string   `json:"vcsRepository,omitempty"`
	VCSRevision    string   `json:"vcsRevision,omitempty"`
	StartedAt      string   `json:"startedAt,omitempty"`
	CompletedAt    string   `json:"completedAt,omitempty"`
	DurationMs     int64    `json:"durationMs,omitempty"`
	Status         string   `json:"status"`
	TotalSteps     int      `json:"totalSteps"`
	CachedSteps    int      `json:"cachedSteps"`
	CompletedSteps int      `json:"completedSteps"`
	Materials      []string `json:"materials"`
	ObservedAt     string   `json:"observedAt"`
}

type SecretsListParams struct {
	Context string `json:"context"`
}

// SwarmSurface says whether the Swarm secret store was reachable, and why not when it was
// not. Docker answers 503 on every Swarm endpoint of a node that is not a manager, which is
// the ordinary state of a desktop engine — so it is carried on a successful result rather
// than raised as an error. An empty store on a manager and no store at all are different
// facts about the engine and a caller must be able to tell them apart.
type SwarmSurface struct {
	// Manager is true only when this engine served the secret list itself.
	Manager bool `json:"manager"`
	// NodeState is Docker's own Swarm.LocalNodeState: inactive, pending, active, error or
	// locked. "unknown" when the transport could not report it.
	NodeState string `json:"nodeState"`
	// Reason is the engine's or the CLI's own words for the refusal, never Anchorage's.
	Reason string `json:"reason,omitempty"`
}

// SecretSummary is a reference, not a secret. Docker discards a secret's plaintext once it
// is created: neither the Engine API nor the CLI returns Spec.Data, and only the containers
// the secret is granted to ever see the value. Nothing in this struct can hold one.
type SecretSummary struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Driver string `json:"driver,omitempty"`
	// CreatedAt/UpdatedAt are RFC3339 on the Engine transport only.
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	// Version is Swarm's object index, which every update increments. Two secrets that share
	// a name across time are not the same object, and this is what says so.
	Version uint64            `json:"version,omitempty"`
	Labels  map[string]string `json:"labels"`
	// The CLI transport formats times relative to now ("2 hours ago") and joins labels into
	// one string, exactly as the volume and image lists do, so those arrive as display text.
	CreatedDisplay string `json:"createdDisplay,omitempty"`
	UpdatedDisplay string `json:"updatedDisplay,omitempty"`
	LabelsText     string `json:"labelsText,omitempty"`
}

type SecretsListResult struct {
	Context      string          `json:"context"`
	Source       string          `json:"source"`
	APIVersion   string          `json:"apiVersion,omitempty"`
	Swarm        SwarmSurface    `json:"swarm"`
	Secrets      []SecretSummary `json:"secrets"`
	ObservedAt   string          `json:"observedAt"`
	EndpointHash string          `json:"endpointHash,omitempty"`
	Limitations  []string        `json:"limitations"`
}

// PluginsParams asks only which CLI plugins are installed and which of them work.
type PluginsParams struct {
	Context string `json:"context,omitempty"`
}

// PluginsResult reports the plugin directories as the Docker CLI sees them.
//
// `Plugins` holds both the ones the CLI loaded and the entries it skipped; `Status` and
// `DiscoverySource` distinguish them. Reporting the skipped ones is the point: `docker info`
// omits them silently, so a broken plugin is invisible from the CLI alone.
type PluginsResult struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Binary          *BinaryFingerprint `json:"binary,omitempty"`
	BinaryError     *OpError           `json:"binaryError,omitempty"`
	Plugins         []Plugin           `json:"plugins"`
	SearchPath      []string           `json:"searchPath"`
	// PackageManager is how this machine installs software, detected locally: a CLI plugin is a
	// client-side executable and lands here regardless of which daemon a context points at.
	PackageManager *hostPackageManager `json:"packageManager,omitempty"`
	Warnings       []string            `json:"warnings"`
	ObservedAt     string              `json:"observedAt"`
}

// PluginActionParams repairs one faulty entry in a Docker CLI plugin directory.
//
// Both actions are local repairs of something already on disk. Nothing here installs a plugin:
// the core has no HTTP client and cannot execute anything but the fingerprinted Docker binary,
// so "install" is guidance the surface gives the operator, never work this verb does.
//
//   - remove: unlink the entry. The common case is a symlink whose target a package manager
//     deleted, which the CLI silently ignores and which no Docker command can clear.
//   - enable: add the execute bit the CLI requires. Only valid for an entry that is faulty
//     precisely because it lacks one.
//
// Path is required alongside Name because the same plugin name can appear in several
// directories, and the entry being repaired is one file rather than a name.
type PluginActionParams struct {
	Context string `json:"context,omitempty"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Action  string `json:"action"`
	// Confirmed must be set for remove: it deletes a host file.
	Confirmed bool `json:"confirmed,omitempty"`
}

// PluginActionResult carries the re-read installation rather than only an acknowledgement, so
// the surface cannot render a report that disagrees with the change it just made.
type PluginActionResult struct {
	ProtocolVersion string        `json:"protocolVersion"`
	Name            string        `json:"name"`
	Path            string        `json:"path"`
	Action          string        `json:"action"`
	Outcome         string        `json:"outcome"`
	Plugins         PluginsResult `json:"plugins"`
	ObservedAt      string        `json:"observedAt"`
}

/*
Engine managed plugins.

A different system from the CLI plugins in `plugins.go`, and easy to conflate: those are
executables the CLI shells out to, while these are containers the daemon runs to provide volume
drivers, network drivers, log drivers, IPAM, metrics collectors and authorization. They are
installed with `docker plugin install`, listed by the Engine's own `/plugins` endpoint, and were
entirely absent from this application — the whole subsystem had no verb and no surface.

What makes them worth reporting carefully is the privilege. Installing one grants it capabilities
the daemon then honours: host mounts, devices, Linux capabilities and a network mode. Docker asks
for that consent once, at install time, and afterwards nothing shows what a given plugin was
granted. That is precisely the kind of thing this application exists to make visible.
*/
type EnginePluginPrivileges struct {
	// Network mode the plugin's own container runs with, e.g. "host".
	Network string `json:"network,omitempty"`
	// Linux capabilities the daemon grants it, e.g. CAP_SYS_ADMIN.
	Capabilities []string `json:"capabilities"`
	// True when the plugin was granted every device on the host rather than a named set.
	AllowAllDevices bool `json:"allowAllDevices"`
	// Host paths the plugin can see, as "source:destination".
	Mounts []string `json:"mounts"`
	// Host devices exposed to it.
	Devices []string `json:"devices"`
}

type EnginePlugin struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// Reference the plugin was pulled from, when the daemon reports one.
	Reference     string `json:"reference,omitempty"`
	Description   string `json:"description,omitempty"`
	Documentation string `json:"documentation,omitempty"`
	// Interface types it implements: docker.volumedriver/1.0, docker.logdriver/1.0 and so on.
	Interfaces []string               `json:"interfaces"`
	Privileges EnginePluginPrivileges `json:"privileges"`
}

type EnginePluginsListParams struct {
	Context string `json:"context"`
}

type EnginePluginsListResult struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Context         string         `json:"context"`
	Source          string         `json:"source"`
	APIVersion      string         `json:"apiVersion,omitempty"`
	Plugins         []EnginePlugin `json:"plugins"`
	ObservedAt      string         `json:"observedAt"`
	EndpointHash    string         `json:"endpointHash,omitempty"`
}

/* ── Docker Model Runner ─────────────────────────────────────────────────────────────────── */

// DockerModel is one model on this machine, projected from `docker model ls --json`.
//
// The size, parameter count and quantization are carried as Docker printed them rather than
// re-derived. They arrive as display strings ("256.35 MiB", "361.82 M", "IQ2_XXS/Q4_K_M") and
// reformatting them would put a number on screen that disagrees with `docker model ls` for no
// benefit — nothing computes with them.
type DockerModel struct {
	// ID is the manifest digest, `sha256:…`.
	ID string `json:"id"`
	// Tags are every reference pointing at this model. A pulled model normally has one; a
	// model that has been untagged has none, and is only addressable by digest.
	Tags []string `json:"tags"`
	// Reference is what `docker model run` and `docker model rm` accept: the first tag when
	// there is one, the digest otherwise.
	Reference    string `json:"reference"`
	Created      string `json:"created,omitempty"`
	Format       string `json:"format,omitempty"`
	Quantization string `json:"quantization,omitempty"`
	Parameters   string `json:"parameters,omitempty"`
	Architecture string `json:"architecture,omitempty"`
	Size         string `json:"size,omitempty"`
	// ContextSize is the model's own token window, when it declares one.
	ContextSize *int `json:"contextSize,omitempty"`
}

// ModelBackend is one row of the `docker model status` table. A backend that is not installed
// is reported rather than hidden: "mlx — Not Installed — only supported on Apple Silicon" tells
// a Linux operator something true, where an absent row would look like a missing feature.
type ModelBackend struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

type ModelRunnerStatus struct {
	// Running is taken from the runner's own sentence, not inferred from the backend table.
	Running bool `json:"running"`
	// Reported is that sentence verbatim, so the screen can show what Docker said rather than
	// a paraphrase of a boolean.
	Reported string         `json:"reported,omitempty"`
	Backends []ModelBackend `json:"backends"`
}

type ModelDiskUsage struct {
	Label string `json:"label"`
	Size  string `json:"size"`
}

type ModelsListParams struct {
	Context string `json:"context"`
}

type ModelsListResult struct {
	ProtocolVersion string        `json:"protocolVersion"`
	Context         string        `json:"context"`
	Models          []DockerModel `json:"models"`
	// Runner and Disk are best-effort. Both come from column-aligned text with no JSON option,
	// so an unrecognised table leaves them empty rather than failing the whole read.
	Runner     ModelRunnerStatus `json:"runner"`
	Disk       []ModelDiskUsage  `json:"disk"`
	ObservedAt string            `json:"observedAt"`
}

type ModelsSearchParams struct {
	Context string `json:"context"`
	Query   string `json:"query,omitempty"`
	// Source selects the registries searched: docker-hub (the default), huggingface, or all.
	Source string `json:"source,omitempty"`
}

type ModelSearchResult struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Downloads   int64  `json:"downloads,omitempty"`
	Stars       int64  `json:"stars,omitempty"`
	Source      string `json:"source,omitempty"`
	Official    bool   `json:"official,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
	Backend     string `json:"backend,omitempty"`
	// SizeBytes is a real byte count here, unlike the display strings on DockerModel: search
	// returns a number and the UI formats it.
	SizeBytes int64 `json:"sizeBytes,omitempty"`
}

type ModelsSearchResult struct {
	ProtocolVersion string              `json:"protocolVersion"`
	Context         string              `json:"context"`
	Query           string              `json:"query,omitempty"`
	Results         []ModelSearchResult `json:"results"`
	ObservedAt      string              `json:"observedAt"`
}

type ModelsActionParams struct {
	Context string `json:"context"`
	// Action is pull, remove, or unload.
	Action string `json:"action"`
	// Reference is required for pull and remove. Omitting it on unload evicts every loaded
	// model, which is a legitimate ask rather than an oversight.
	Reference string `json:"reference,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	// The three session fields apply to pull alone, which streams. MaxOutputBytes is int64 to
	// match SessionStartParams, where it bounds a total rather than one window.
	TimeoutSeconds    int   `json:"timeoutSeconds,omitempty"`
	OutputWindowBytes int   `json:"outputWindowBytes,omitempty"`
	MaxOutputBytes    int64 `json:"maxOutputBytes,omitempty"`
}

type ModelsActionResult struct {
	Action  string                 `json:"action"`
	Receipt DomainOperationReceipt `json:"receipt"`
	// Session is present for pull alone: the download outlives this response and is followed
	// through session events.
	Session *SessionStartResult `json:"session,omitempty"`
}

/* ── Installing a CLI plugin ─────────────────────────────────────────────────────────────── */

type CapabilityInstallParams struct {
	// Capability names an entry in the core's compiled-in table — `agent` or `mcp`. It is
	// deliberately not a URL: the whole safety of this verb rests on the caller being unable
	// to say where the bytes come from.
	Capability string `json:"capability"`
	// Confirmed must be true. Installing places an executable in a directory the Docker CLI
	// scans and runs, which is closer to installing an application than to fetching a file.
	Confirmed bool `json:"confirmed"`
}

type CapabilityInstallResult struct {
	ProtocolVersion string `json:"protocolVersion"`
	Capability      string `json:"capability"`
	Plugin          string `json:"plugin"`
	Path            string `json:"path"`
	Repository      string `json:"repository"`
	Release         string `json:"release"`
	Asset           string `json:"asset"`
	// SHA256 is the digest of the file actually written.
	SHA256 string `json:"sha256"`
	// AssetSHA256 is the digest the release published, which the download was verified
	// against. For a bare binary the two are identical; for an archive they differ, because
	// the published digest covers the tarball rather than the file extracted from it. Both are
	// reported so the difference is visible rather than implied.
	AssetSHA256 string `json:"assetSha256"`
	SizeBytes   int64  `json:"sizeBytes"`
	InstalledAt string `json:"installedAt"`
}

/* ── Docker Agent ────────────────────────────────────────────────────────────────────────── */

// AgentModel is one model an agent can be pointed at, from `docker agent models --format json`.
type AgentModel struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Default  bool   `json:"default,omitempty"`
}

// AgentToolset is one tool type an agent configuration can grant, with Docker's own summary.
type AgentToolset struct {
	Type    string `json:"type"`
	Summary string `json:"summary,omitempty"`
	Docs    string `json:"docs,omitempty"`
}

/*
AgentProvider is one model provider and whether its credential is visible.

`Configured` is deliberately not called "present". Docker Agent reads credentials from
environment variables, so this reports what is visible to the Anchorage process — a key exported
in a shell profile is invisible to an app started from a desktop launcher, and the screen says
that rather than reporting the key as missing.
*/
type AgentProvider struct {
	Provider string `json:"provider"`
	// Credentials are the environment variables this provider would be read from.
	Credentials []string `json:"credentials"`
	Configured  bool     `json:"configured"`
}

type AgentsListParams struct {
	Context string `json:"context"`
}

type AgentsListResult struct {
	ProtocolVersion string          `json:"protocolVersion"`
	Context         string          `json:"context"`
	Models          []AgentModel    `json:"models"`
	Toolsets        []AgentToolset  `json:"toolsets"`
	Providers       []AgentProvider `json:"providers"`
	// ConfigPath and ConfigStatus come from `doctor`, which is supplementary: an unreadable
	// report leaves them empty rather than failing the read.
	ConfigPath   string `json:"configPath,omitempty"`
	ConfigStatus string `json:"configStatus,omitempty"`
	// TelemetryDisabled records that Anchorage set TELEMETRY_ENABLED=false for its own calls.
	// Reported rather than assumed, so the screen states a fact about what it did rather than
	// a claim about the operator's own terminal, where the default still applies.
	TelemetryDisabled bool   `json:"telemetryDisabled"`
	ObservedAt        string `json:"observedAt"`
}
