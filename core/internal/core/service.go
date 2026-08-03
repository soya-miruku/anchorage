package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Config struct {
	DockerExecutable string
	AllowedCWDRoots  []string
}

type Service struct {
	startedAt   time.Time
	docker      *DockerCLI
	dockerErr   error
	defaultCWD  string
	allowedCWDs []string
	sessions    *sessionManager

	// Engine endpoint resolutions and their HTTP transports are cached per context so a
	// steady poll does not re-fork `docker context inspect` and rebuild a transport per call.
	engineMu      sync.Mutex
	endpointCache map[string]cachedEndpoint
	clientCache   map[string]*engineClient

	// The recursive `docker --help` walk is ~244 subprocesses; memoize it per binary hash.
	inventoryMu    sync.Mutex
	inventoryCache map[string]CommandInventory
}

func NewService(config Config) (*Service, error) {
	defaultCWD, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("resolve core working directory: %w", err)
	}
	defaultCWD, err = canonicalDirectory(defaultCWD)
	if err != nil {
		return nil, err
	}
	roots := config.AllowedCWDRoots
	if len(roots) == 0 {
		roots = []string{defaultCWD}
	}
	allowed := make([]string, 0, len(roots))
	for _, root := range roots {
		canonical, err := canonicalDirectory(root)
		if err != nil {
			return nil, fmt.Errorf("invalid allowed cwd root %q: %w", root, err)
		}
		if !containsPath(allowed, canonical) {
			allowed = append(allowed, canonical)
		}
	}

	docker, dockerErr := resolveDockerBinary(config.DockerExecutable)
	service := &Service{
		startedAt:   time.Now().UTC(),
		docker:      docker,
		dockerErr:   dockerErr,
		defaultCWD:  defaultCWD,
		allowedCWDs: allowed,
	}
	service.sessions = newSessionManager(service)
	return service, nil
}

func (s *Service) Handle(ctx context.Context, method string, raw json.RawMessage, emit EventEmitter) (any, error) {
	switch method {
	case "health":
		var params struct{}
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return HealthResult{
			Status: "ok", Version: CoreVersion, ProtocolVersion: ProtocolVersion,
			PID: os.Getpid(), StartedAt: s.startedAt.Format(time.RFC3339Nano), DockerReady: s.docker != nil,
		}, nil
	case "system.capabilities":
		var params CapabilitiesParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.capabilities(ctx, params)
	case "system.snapshot":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params SystemSnapshotParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.systemSnapshot(ctx, params)
	case "containers.list":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainersListParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containersList(ctx, params)
	case "containers.inspect":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainerInspectParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containerInspect(ctx, params)
	case "containers.stats":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainerStatsParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containerStats(ctx, params)
	case "containers.action":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainersActionParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containersAction(ctx, params, emit)
	case "images.list":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ImagesListParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.imagesList(ctx, params)
	case "images.inspect":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ImagesInspectParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.imagesInspect(ctx, params)
	case "containers.export":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainersExportParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containersExport(ctx, params, emit)
	case "images.search":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ImagesSearchParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.imagesSearch(ctx, params)
	case "containers.commit":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainersCommitParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containersCommit(ctx, params, emit)
	case "images.action":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ImagesActionParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.imagesAction(ctx, params, emit)
	case "images.scout":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ImagesScoutParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.imagesScout(ctx, params)
	case "volumes.files":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params VolumeFilesParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.volumeFiles(ctx, params)
	case "volumes.fileRead":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params VolumeFileReadParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.volumeFileRead(ctx, params)
	case "compose.list":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ComposeListParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.composeList(ctx, params)
	case "compose.ps":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ComposePsParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.composePs(ctx, params)
	case "compose.action":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ComposeActionParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.composeAction(ctx, params, emit)
	case "volumes.list":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params VolumesListParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.volumesList(ctx, params)
	case "volumes.action":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params VolumesActionParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.volumesAction(ctx, params, emit)
	case "containers.files":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainerFilesParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containerFiles(ctx, params)
	case "containers.fileRead":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainerFileReadParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containerFileRead(ctx, params)
	case "containers.fileWrite":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainerFileWriteParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containerFileWrite(ctx, params)
	case "containers.top":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainerInspectParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containerTop(ctx, params)
	case "containers.diff":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainerInspectParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containerDiff(ctx, params)
	case "containers.statsBatch":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainersStatsBatchParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containersStatsBatch(ctx, params)
	case "containers.create":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params ContainersCreateParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.containersCreate(ctx, params, emit)
	case "networks.list":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params NetworksListParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.networksList(ctx, params)
	case "networks.action":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params NetworksActionParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.networksAction(ctx, params, emit)
	case "system.action":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params SystemActionParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.systemAction(ctx, params, emit)
	case "cli.run":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params CLIRunParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.cliRun(ctx, params, emit)
	case "session.start":
		if err := s.requireDocker(); err != nil {
			return nil, err
		}
		var params SessionStartParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		// A session deliberately outlives the request that created it: its lifetime is owned
		// by session.cancel, session.signal and its own timeout, not by the RPC call. Since
		// requests became individually cancellable, inheriting the request context here would
		// tear every session down the instant session.start returned.
		return s.sessions.start(context.WithoutCancel(ctx), params, emit)
	case "session.input":
		var params SessionInputParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.sessions.input(params)
	case "session.resize":
		var params SessionResizeParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.sessions.resize(params)
	case "session.signal":
		var params SessionSignalParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.sessions.signal(params)
	case "session.cancel":
		var params SessionCancelParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.sessions.cancel(params)
	case "session.ack":
		var params SessionAckParams
		if err := decodeStrict(raw, &params); err != nil {
			return nil, invalidParams(err)
		}
		return s.sessions.ack(params)
	default:
		return nil, opError("method_not_found", "RPC method is not supported.", nil, map[string]any{
			"method": method,
		})
	}
}

func (s *Service) requireDocker() error {
	if s.docker != nil {
		return nil
	}
	return AsOpError(s.dockerErr)
}

func (s *Service) cliRun(parent context.Context, params CLIRunParams, emit EventEmitter) (CLIRunResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return CLIRunResult{}, err
	}
	params.Context = contextName
	targetMode, err := normalizeTargetMode(params.TargetMode)
	if err != nil {
		return CLIRunResult{}, err
	}
	params.TargetMode = targetMode
	if params.Interactive || params.Streaming {
		return CLIRunResult{}, opError("unsupported_mode", "Interactive and streaming CLI execution are not supported by protocol v1.", nil, map[string]any{
			"interactive": params.Interactive,
			"streaming":   params.Streaming,
		})
	}
	if err := validateCLIArgv(params.Argv, s.docker.binary, targetMode); err != nil {
		return CLIRunResult{}, err
	}
	if err := validateCLIEnvironment(params.Env, targetMode); err != nil {
		return CLIRunResult{}, err
	}
	if params.TimeoutSeconds < 0 || params.TimeoutSeconds > 3600 {
		return CLIRunResult{}, opError("invalid_timeout", "CLI timeout must be between 0 and 3600 seconds.", nil, nil)
	}
	timeout := time.Duration(params.TimeoutSeconds) * time.Second
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	cwd, err := s.resolveAllowedCWD(params.Cwd)
	if err != nil {
		return CLIRunResult{}, err
	}
	operationID, err := operationID()
	if err != nil {
		return CLIRunResult{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	args := commandArgs(contextName, targetMode, params.Argv...)
	started := time.Now().UTC()
	if emit != nil {
		emit("operation.started", map[string]any{
			"operationId": operationID, "method": "cli.run", "context": contextName,
			"targetMode": targetMode, "argv": args, "cwd": cwd,
			"startedAt": started.Format(time.RFC3339Nano),
		})
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	commandResult, runErr := s.docker.run(ctx, args, cwd, params.Env, cliOutputLimit)
	completed := time.Now().UTC()
	result := CLIRunResult{
		OperationID: operationID,
		Context:     contextName,
		TargetMode:  targetMode,
		Executable:  s.docker.binary.RealPath,
		Argv:        args,
		Cwd:         cwd,
		ExitCode:    commandResult.exitCode,
		TimedOut:    commandResult.timedOut,
		StartedAt:   started.Format(time.RFC3339Nano),
		CompletedAt: completed.Format(time.RFC3339Nano),
		DurationMs:  completed.Sub(started).Milliseconds(),
		Stdout:      capturedOutput(commandResult.stdout, commandResult.stdoutBytes, commandResult.stdoutTruncated),
		Stderr:      capturedOutput(commandResult.stderr, commandResult.stderrBytes, commandResult.stderrTruncated),
	}
	if emit != nil {
		payload := map[string]any{"result": result}
		if runErr != nil {
			payload["error"] = AsOpError(runErr)
		}
		emit("operation.completed", payload)
	}
	if runErr != nil {
		return CLIRunResult{}, runErr
	}
	return result, nil
}

func (s *Service) resolveAllowedCWD(requested string) (string, error) {
	if strings.TrimSpace(requested) == "" {
		requested = s.defaultCWD
	}
	canonical, err := canonicalDirectory(requested)
	if err != nil {
		return "", opError("invalid_cwd", "CLI working directory must be an existing directory.", err, map[string]any{
			"cwd": requested,
		})
	}
	for _, root := range s.allowedCWDs {
		if pathWithin(root, canonical) {
			return canonical, nil
		}
	}
	return "", opError("cwd_not_allowed", "CLI working directory is outside the configured allowlist.", nil, map[string]any{
		"cwd": canonical,
	})
}

func canonicalDirectory(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", resolved)
	}
	return filepath.Clean(resolved), nil
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func containsPath(paths []string, candidate string) bool {
	for _, item := range paths {
		if samePath(item, candidate) {
			return true
		}
	}
	return false
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

var environmentKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func normalizeTargetMode(value string) (string, error) {
	if value == "" {
		return "pinned", nil
	}
	if value != "pinned" && value != "literal" {
		return "", opError(
			"invalid_target_mode",
			"CLI target mode must be \"pinned\" or \"literal\".",
			nil,
			map[string]any{"targetMode": value},
		)
	}
	return value, nil
}

func commandArgs(contextName, targetMode string, argv ...string) []string {
	if targetMode == "literal" {
		return append([]string(nil), argv...)
	}
	return withContext(contextName, argv...)
}

func validateCLIEnvironment(environment map[string]string, targetMode string) error {
	for key, value := range environment {
		if !environmentKeyPattern.MatchString(key) {
			return opError("unsafe_environment", "CLI environment contains an invalid variable name.", nil, map[string]any{
				"key": key,
			})
		}
		upper := strings.ToUpper(key)
		if unsafeEnvironmentKey(upper, targetMode) {
			return opError("unsafe_environment", "CLI environment cannot override process loading, executable, credential-store, or Docker target settings.", nil, map[string]any{
				"key": key,
			})
		}
		if strings.ContainsRune(value, '\x00') {
			return opError("unsafe_environment", "CLI environment values cannot contain NUL bytes.", nil, map[string]any{
				"key": key,
			})
		}
	}
	return nil
}

func unsafeEnvironmentKey(key, targetMode string) bool {
	switch key {
	case "PATH", "PATHEXT", "HOME", "USERPROFILE",
		"LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
		"SSLKEYLOGFILE", "SSH_ASKPASS", "GIT_ASKPASS":
		return true
	case "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
		"DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH":
		return targetMode != "literal"
	default:
		return strings.HasPrefix(key, "LD_") || strings.HasPrefix(key, "DYLD_")
	}
}

func validateCLIArgv(argv []string, binary BinaryFingerprint, targetMode string) error {
	if len(argv) == 0 {
		return opError("argv_required", "CLI argv must contain at least one Docker command.", nil, nil)
	}
	if len(argv) > 1024 {
		return opError("argv_too_large", "CLI argv contains too many arguments.", nil, map[string]any{"limit": 1024})
	}
	firstBase := filepath.Base(argv[0])
	if samePath(firstBase, filepath.Base(binary.Path)) || samePath(firstBase, filepath.Base(binary.RealPath)) || strings.ContainsAny(argv[0], `/\`) {
		return opError("executable_override_rejected", "CLI argv must start with a Docker command, not an executable path.", nil, nil)
	}
	positionalOnly := false
	for index, argument := range argv {
		if len(argument) > 1024*1024 {
			return opError("argv_too_large", "A CLI argument exceeds the safety limit.", nil, map[string]any{"index": index})
		}
		if strings.ContainsRune(argument, '\x00') {
			return opError("invalid_argv", "CLI arguments cannot contain NUL bytes.", nil, map[string]any{"index": index})
		}
		if argument == "--" {
			positionalOnly = true
			continue
		}
		if targetMode != "literal" && !positionalOnly && targetOverrideFlag(argument) {
			return opError("context_override_rejected", "CLI argv cannot override the pinned Docker context, host, client config, or TLS target.", nil, map[string]any{
				"argument": argument,
				"index":    index,
			})
		}
	}
	return nil
}

func targetOverrideFlag(argument string) bool {
	switch argument {
	case "-c", "--context", "-H", "--host", "--config",
		"--tls", "--tlsverify", "--tlscacert", "--tlscert", "--tlskey":
		return true
	}
	for _, prefix := range []string{
		"-c=", "--context=", "-H=", "--host=", "--config=", "--tls=", "--tlsverify=",
		"--tlscacert=", "--tlscert=", "--tlskey=",
	} {
		if strings.HasPrefix(argument, prefix) {
			return true
		}
	}
	if len(argument) > 2 && (strings.HasPrefix(argument, "-c") || strings.HasPrefix(argument, "-H")) {
		return true
	}
	return false
}

func invalidParams(err error) *OpError {
	return opError("invalid_params", "RPC parameters are invalid.", err, map[string]any{
		"reason": err.Error(),
	})
}
