package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

var errTransportUnsupported = errors.New("docker context transport is not a local unix socket")

const engineResponseLimit = 64 * 1024 * 1024

type contextEndpoint struct {
	contextName  string
	host         string
	socketPath   string
	endpointHash string
}

type engineClient struct {
	endpoint   contextEndpoint
	httpClient *http.Client
	transport  *http.Transport
	apiVersion string
	serverMin  string
	serverMax  string
}

// engineEndpointTTL bounds how long a resolved context endpoint is reused before
// `docker context inspect` is run again. Every structured RPC used to fork that subprocess:
// at the 2s container poll that was ~30 process spawns per minute, and roughly half the
// wall-clock cost of a warm containers.list, for data that effectively never changes.
const engineEndpointTTL = 30 * time.Second

type cachedEndpoint struct {
	endpoint   contextEndpoint
	resolvedAt time.Time
}

// resolveEngineEndpoint returns the endpoint for a context, reusing a recent resolution.
func (s *Service) resolveEngineEndpoint(parent context.Context, contextName string) (contextEndpoint, error) {
	if err := validateContextName(contextName); err != nil {
		return contextEndpoint{}, err
	}
	s.engineMu.Lock()
	cached, ok := s.endpointCache[contextName]
	s.engineMu.Unlock()
	if ok && time.Since(cached.resolvedAt) < engineEndpointTTL {
		return cached.endpoint, nil
	}
	endpoint, err := s.inspectEngineEndpoint(parent, contextName)
	if err != nil {
		return contextEndpoint{}, err
	}
	s.engineMu.Lock()
	if s.endpointCache == nil {
		s.endpointCache = map[string]cachedEndpoint{}
	}
	s.endpointCache[contextName] = cachedEndpoint{endpoint: endpoint, resolvedAt: time.Now()}
	s.engineMu.Unlock()
	return endpoint, nil
}

// engineClient returns a long-lived client for an endpoint. The HTTP transport, its idle
// connections and the negotiated API version are reused across requests; previously each
// call built a fresh transport, issued a throwaway /version, and then dropped every idle
// connection, so no Engine connection was ever reused.
func (s *Service) engineClient(ctx context.Context, endpoint contextEndpoint) (*engineClient, error) {
	s.engineMu.Lock()
	existing, ok := s.clientCache[endpoint.endpointHash]
	s.engineMu.Unlock()
	if ok {
		return existing, nil
	}
	client, err := newEngineClient(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	s.engineMu.Lock()
	// Another request may have negotiated concurrently; keep whichever landed first so the
	// cache holds exactly one transport per endpoint.
	if winner, raced := s.clientCache[endpoint.endpointHash]; raced {
		s.engineMu.Unlock()
		client.close()
		return winner, nil
	}
	if s.clientCache == nil {
		s.clientCache = map[string]*engineClient{}
	}
	s.clientCache[endpoint.endpointHash] = client
	s.engineMu.Unlock()
	return client, nil
}

// closeEngineClients drops every cached transport. Used on shutdown.
func (s *Service) closeEngineClients() {
	s.engineMu.Lock()
	clients := make([]*engineClient, 0, len(s.clientCache))
	for _, client := range s.clientCache {
		clients = append(clients, client)
	}
	s.clientCache = map[string]*engineClient{}
	s.endpointCache = map[string]cachedEndpoint{}
	s.engineMu.Unlock()
	for _, client := range clients {
		client.close()
	}
}

func (s *Service) inspectEngineEndpoint(parent context.Context, contextName string) (contextEndpoint, error) {
	ctx, cancel := context.WithTimeout(parent, discoveryCommandTimeout)
	defer cancel()
	args := []string{"context", "inspect", contextName}
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, discoveryOutputLimit)
	if err != nil {
		return contextEndpoint{}, opError("context_inspect_failed", "Docker context could not be inspected.", err, map[string]any{
			"context": contextName,
		})
	}
	if result.timedOut {
		return contextEndpoint{}, opError("context_inspect_timeout", "Docker context inspection timed out.", context.DeadlineExceeded, map[string]any{
			"context": contextName,
		})
	}
	if result.exitCode != 0 {
		return contextEndpoint{}, opError("context_inspect_failed", "Docker context inspection failed.", nil, map[string]any{
			"context":  contextName,
			"exitCode": result.exitCode,
			"stderr":   string(result.stderr),
		})
	}
	var contexts []struct {
		Name      string `json:"Name"`
		Endpoints struct {
			Docker struct {
				Host string `json:"Host"`
			} `json:"docker"`
		} `json:"Endpoints"`
	}
	if err := json.Unmarshal(result.stdout, &contexts); err != nil {
		return contextEndpoint{}, opError("context_inspect_invalid", "Docker context inspection returned invalid JSON.", err, map[string]any{
			"context": contextName,
		})
	}
	if len(contexts) != 1 {
		return contextEndpoint{}, opError("context_inspect_invalid", "Docker context inspection did not return exactly one context.", nil, map[string]any{
			"context": contextName,
			"count":   len(contexts),
		})
	}
	host := strings.TrimSpace(contexts[0].Endpoints.Docker.Host)
	parsed, err := url.Parse(host)
	if err != nil || parsed.Scheme != "unix" || parsed.Path == "" {
		return contextEndpoint{}, fmt.Errorf("%w: context %q endpoint %q", errTransportUnsupported, contextName, host)
	}
	hash := sha256.Sum256([]byte(contextName + "\x00" + host))
	return contextEndpoint{
		contextName:  contextName,
		host:         host,
		socketPath:   parsed.Path,
		endpointHash: hex.EncodeToString(hash[:]),
	}, nil
}

func newEngineClient(ctx context.Context, endpoint contextEndpoint) (*engineClient, error) {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:               nil,
		DisableCompression:  true,
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     30 * time.Second,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", endpoint.socketPath)
		},
	}
	client := &engineClient{
		endpoint: endpoint,
		httpClient: &http.Client{
			Transport: transport,
		},
		transport: transport,
	}

	var version struct {
		APIVersion    string `json:"ApiVersion"`
		MinAPIVersion string `json:"MinAPIVersion"`
	}
	status, body, err := client.request(ctx, http.MethodGet, "/version", nil)
	if err != nil {
		client.close()
		return nil, err
	}
	if status < 200 || status >= 300 {
		client.close()
		return nil, engineHTTPError("engine_version_failed", "Docker Engine version negotiation failed.", status, body)
	}
	if err := json.Unmarshal(body, &version); err != nil {
		client.close()
		return nil, opError("engine_version_invalid", "Docker Engine returned invalid version JSON.", err, map[string]any{
			"context": endpoint.contextName,
		})
	}
	if version.APIVersion == "" {
		client.close()
		return nil, opError("engine_version_invalid", "Docker Engine did not report an API version.", nil, map[string]any{
			"context": endpoint.contextName,
		})
	}
	if compareAPIVersions(version.APIVersion, coreMinAPIVersion) < 0 {
		client.close()
		return nil, fmt.Errorf("%w: engine API %s is older than core minimum %s", errTransportUnsupported, version.APIVersion, coreMinAPIVersion)
	}
	client.serverMax = version.APIVersion
	client.serverMin = version.MinAPIVersion
	client.apiVersion = version.APIVersion
	if compareAPIVersions(client.apiVersion, coreMaxAPIVersion) > 0 {
		client.apiVersion = coreMaxAPIVersion
	}
	return client, nil
}

func (c *engineClient) close() {
	if c != nil && c.transport != nil {
		c.transport.CloseIdleConnections()
	}
}

func (c *engineClient) request(ctx context.Context, method, path string, body io.Reader) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, body)
	if err != nil {
		return 0, nil, opError("engine_request_invalid", "Docker Engine request could not be created.", err, nil)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		code := "engine_unreachable"
		message := "Docker Engine could not be reached."
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "engine_timeout"
			message = "Docker Engine request timed out."
		}
		return 0, nil, opError(code, message, err, map[string]any{
			"context": c.endpoint.contextName,
		})
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, engineResponseLimit+1))
	if err != nil {
		return response.StatusCode, nil, opError("engine_response_failed", "Docker Engine response could not be read.", err, map[string]any{
			"context": c.endpoint.contextName,
			"status":  response.StatusCode,
		})
	}
	if len(data) > engineResponseLimit {
		return response.StatusCode, nil, opError("engine_response_too_large", "Docker Engine response exceeded the safety limit.", nil, map[string]any{
			"context": c.endpoint.contextName,
			"limit":   engineResponseLimit,
		})
	}
	return response.StatusCode, data, nil
}

func (s *Service) containersList(ctx context.Context, params ContainersListParams) (ContainersListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainersListResult{}, err
	}
	all := true
	if params.All != nil {
		all = *params.All
	}
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.containersListCLI(ctx, contextName, all)
		}
		return ContainersListResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return s.containersListCLI(ctx, contextName, all)
		}
		return ContainersListResult{}, err
	}

	allValue := "0"
	if all {
		allValue = "1"
	}
	path := "/v" + client.apiVersion + "/containers/json?all=" + allValue
	status, body, err := client.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return ContainersListResult{}, err
	}
	if status < 200 || status >= 300 {
		return ContainersListResult{}, engineHTTPError("containers_list_failed", "Docker Engine rejected the container list request.", status, body)
	}
	var raw []engineContainer
	if err := json.Unmarshal(body, &raw); err != nil {
		return ContainersListResult{}, opError("containers_list_invalid", "Docker Engine returned invalid container JSON.", err, map[string]any{
			"context": contextName,
		})
	}
	containers := make([]Container, 0, len(raw))
	for _, item := range raw {
		containers = append(containers, projectEngineContainer(item))
	}
	sortContainers(containers)
	return ContainersListResult{
		Context:      contextName,
		Source:       "engine-api",
		APIVersion:   client.apiVersion,
		Containers:   containers,
		ObservedAt:   nowUTC(),
		EndpointHash: endpoint.endpointHash,
	}, nil
}

type engineContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	Created int64             `json:"Created"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Labels  map[string]string `json:"Labels"`
	Ports   []struct {
		IP          string `json:"IP"`
		PrivatePort uint16 `json:"PrivatePort"`
		PublicPort  uint16 `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
}

func projectEngineContainer(raw engineContainer) Container {
	name := ""
	if len(raw.Names) > 0 {
		name = strings.TrimPrefix(raw.Names[0], "/")
	}
	ports := make([]Port, 0, len(raw.Ports))
	for _, item := range raw.Ports {
		ports = append(ports, Port{
			IP: item.IP, PrivatePort: item.PrivatePort, PublicPort: item.PublicPort, Type: item.Type,
		})
	}
	sortPorts(ports)
	return Container{
		ID: raw.ID, Name: name, Image: raw.Image, ImageID: raw.ImageID,
		State: strings.ToLower(raw.State), Status: raw.Status, Health: healthFromStatus(raw.Status),
		Ports: ports, Labels: raw.Labels, Created: raw.Created,
	}
}

func (s *Service) containersListCLI(parent context.Context, contextName string, all bool) (ContainersListResult, error) {
	args := withContext(contextName, "ps")
	if all {
		args = append(args, "--all")
	}
	args = append(args, "--no-trunc", "--format", "{{json .}}")
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, 16*1024*1024)
	if err != nil {
		return ContainersListResult{}, err
	}
	if result.timedOut {
		return ContainersListResult{}, opError("containers_list_timeout", "Docker CLI container listing timed out.", context.DeadlineExceeded, map[string]any{
			"context": contextName,
		})
	}
	if result.exitCode != 0 {
		return ContainersListResult{}, opError("containers_list_failed", "Docker CLI container listing failed.", nil, map[string]any{
			"context":  contextName,
			"exitCode": result.exitCode,
			"stderr":   string(result.stderr),
		})
	}
	containers := make([]Container, 0)
	for lineNumber, line := range strings.Split(strings.TrimSpace(string(result.stdout)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var row struct {
			ID           string `json:"ID"`
			Names        string `json:"Names"`
			Image        string `json:"Image"`
			State        string `json:"State"`
			Status       string `json:"Status"`
			HealthStatus string `json:"HealthStatus"`
			Ports        string `json:"Ports"`
			// Docker's CLI emits labels as a comma-separated k=v string, unlike the Engine
			// API's map. Without this the CLI transport reported no labels at all, so compose
			// grouping was impossible on remote contexts.
			Labels string `json:"Labels"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return ContainersListResult{}, opError("containers_list_invalid", "Docker CLI returned an invalid container row.", err, map[string]any{
				"context": contextName, "line": lineNumber + 1,
			})
		}
		health := strings.TrimSpace(row.HealthStatus)
		if health == "" {
			health = healthFromStatus(row.Status)
		}
		containers = append(containers, Container{
			ID: row.ID, Name: row.Names, Image: row.Image, State: strings.ToLower(row.State),
			Status: row.Status, Health: health, Ports: parseCLIPorts(row.Ports),
			Labels: parseCLILabels(row.Labels),
		})
	}
	sortContainers(containers)
	return ContainersListResult{
		Context: contextName, Source: "cli", Containers: containers, ObservedAt: nowUTC(),
	}, nil
}

func (s *Service) containersAction(parent context.Context, params ContainersActionParams, emit EventEmitter) (OperationReceipt, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return OperationReceipt{}, err
	}
	if err := validateContainerID(params.ID); err != nil {
		return OperationReceipt{}, err
	}
	if err := validateAction(params); err != nil {
		return OperationReceipt{}, err
	}
	params.Context = contextName
	id, err := operationID()
	if err != nil {
		return OperationReceipt{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	started := time.Now().UTC()
	if emit != nil {
		emit("operation.started", map[string]any{
			"operationId": id, "method": "containers.action", "context": contextName,
			"containerId": params.ID, "action": params.Action, "startedAt": started.Format(time.RFC3339Nano),
		})
	}
	emitCompletion := func(receipt OperationReceipt, opErr error) {
		if emit == nil {
			return
		}
		payload := map[string]any{"receipt": receipt}
		if opErr != nil {
			payload["error"] = AsOpError(opErr)
		}
		emit("operation.completed", payload)
		switch receipt.Outcome {
		case "succeeded":
			emit("reconciliation.requested", map[string]any{
				"operationId": receipt.OperationID, "context": receipt.Context, "domain": "container",
				"resourceId": receipt.ContainerID, "action": receipt.Action, "reason": "mutation_completed",
			})
		case "unknown":
			emit("reconciliation.required", map[string]any{
				"operationId": receipt.OperationID, "context": receipt.Context, "domain": "container",
				"resourceId": receipt.ContainerID, "action": receipt.Action, "reason": "mutation_outcome_unknown",
			})
		}
	}

	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil && errors.Is(err, errTransportUnsupported) {
		receipt, runErr := s.containerActionCLI(parent, id, started, params)
		emitCompletion(receipt, runErr)
		return receipt, runErr
	}
	if err != nil {
		receipt := baseReceipt(id, started, params, "engine-api")
		receipt.Outcome = "failed"
		finishReceipt(&receipt)
		emitCompletion(receipt, err)
		return OperationReceipt{}, err
	}
	receipt, runErr := s.containerActionEngine(parent, id, started, endpoint, params)
	if errors.Is(runErr, errTransportUnsupported) && receipt.HTTPStatus == 0 {
		receipt, runErr = s.containerActionCLI(parent, id, started, params)
	}
	emitCompletion(receipt, runErr)
	return receipt, runErr
}

func (s *Service) containerActionEngine(parent context.Context, id string, started time.Time, endpoint contextEndpoint, params ContainersActionParams) (OperationReceipt, error) {
	receipt := baseReceipt(id, started, params, "engine-api")
	receipt.EndpointHash = endpoint.endpointHash
	timeout := mutationTimeout(params.Options.TimeoutSeconds)
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		receipt.Outcome = "failed"
		finishReceipt(&receipt)
		return receipt, err
	}

	containerPath := "/v" + client.apiVersion + "/containers/" + url.PathEscape(params.ID)
	method := http.MethodPost
	path := ""
	switch params.Action {
	case "start":
		path = containerPath + "/start"
	case "stop":
		path = containerPath + "/stop"
	case "restart":
		path = containerPath + "/restart"
	case "pause":
		path = containerPath + "/pause"
	case "unpause":
		path = containerPath + "/unpause"
	case "kill":
		path = containerPath + "/kill"
		if params.Options.Signal != "" {
			path += "?signal=" + url.QueryEscape(params.Options.Signal)
		}
	case "rename":
		path = containerPath + "/rename?name=" + url.QueryEscape(params.Options.Name)
	case "update":
		path = containerPath + "/update"
	case "remove":
		method = http.MethodDelete
		values := url.Values{}
		values.Set("force", strconv.FormatBool(params.Options.Force))
		values.Set("v", strconv.FormatBool(params.Options.Volumes))
		path = containerPath + "?" + values.Encode()
	}
	if (params.Action == "stop" || params.Action == "restart") && params.Options.TimeoutSeconds > 0 {
		path += "?t=" + strconv.Itoa(params.Options.TimeoutSeconds)
	}
	var payload io.Reader
	if params.Action == "update" {
		update := map[string]any{}
		if params.Options.CPUShares > 0 {
			update["CpuShares"] = params.Options.CPUShares
		}
		if params.Options.MemoryBytes > 0 {
			update["Memory"] = params.Options.MemoryBytes
		}
		if params.Options.RestartPolicy != "" {
			update["RestartPolicy"] = map[string]any{"Name": params.Options.RestartPolicy}
		}
		encoded, marshalErr := json.Marshal(update)
		if marshalErr != nil {
			receipt.Outcome = "failed"
			finishReceipt(&receipt)
			return receipt, marshalErr
		}
		payload = bytes.NewReader(encoded)
	}
	status, body, err := client.request(ctx, method, path, payload)
	receipt.HTTPStatus = status
	if err != nil {
		receipt.Outcome = "failed"
		code := AsOpError(err).Code
		if code == "engine_timeout" {
			receipt.Outcome = "unknown"
			err = opError("mutation_outcome_unknown", "Docker Engine timed out after the mutation was submitted; reconciliation is required.", err, map[string]any{
				"receipt": receipt,
			})
		}
		finishReceipt(&receipt)
		return receipt, err
	}
	if status < 200 || status >= 400 {
		receipt.Outcome = "failed"
		finishReceipt(&receipt)
		return receipt, engineHTTPError("container_action_failed", "Docker Engine rejected the container mutation.", status, body)
	}
	receipt.Outcome = "succeeded"
	finishReceipt(&receipt)
	return receipt, nil
}

func (s *Service) containerActionCLI(parent context.Context, id string, started time.Time, params ContainersActionParams) (OperationReceipt, error) {
	receipt := baseReceipt(id, started, params, "cli")
	args := withContext(params.Context, "container")
	switch params.Action {
	case "start":
		args = append(args, "start", params.ID)
	case "stop":
		args = append(args, "stop")
		if params.Options.TimeoutSeconds > 0 {
			args = append(args, "--time", strconv.Itoa(params.Options.TimeoutSeconds))
		}
		args = append(args, params.ID)
	case "restart":
		args = append(args, "restart")
		if params.Options.TimeoutSeconds > 0 {
			args = append(args, "--time", strconv.Itoa(params.Options.TimeoutSeconds))
		}
		args = append(args, params.ID)
	case "pause":
		args = append(args, "pause", params.ID)
	case "unpause":
		args = append(args, "unpause", params.ID)
	case "kill":
		args = append(args, "kill")
		if params.Options.Signal != "" {
			args = append(args, "--signal", params.Options.Signal)
		}
		args = append(args, params.ID)
	case "rename":
		args = append(args, "rename", params.ID, params.Options.Name)
	case "update":
		args = append(args, "update")
		if params.Options.CPUShares > 0 {
			args = append(args, "--cpu-shares", strconv.FormatInt(params.Options.CPUShares, 10))
		}
		if params.Options.MemoryBytes > 0 {
			args = append(args, "--memory", strconv.FormatInt(params.Options.MemoryBytes, 10))
		}
		if params.Options.RestartPolicy != "" {
			args = append(args, "--restart", params.Options.RestartPolicy)
		}
		args = append(args, params.ID)
	case "remove":
		args = append(args, "rm")
		if params.Options.Force {
			args = append(args, "--force")
		}
		if params.Options.Volumes {
			args = append(args, "--volumes")
		}
		args = append(args, params.ID)
	}
	ctx, cancel := context.WithTimeout(parent, mutationTimeout(params.Options.TimeoutSeconds))
	defer cancel()
	result, err := s.docker.run(ctx, args, s.defaultCWD, nil, cliOutputLimit)
	receipt.Stdout = string(result.stdout)
	receipt.Stderr = string(result.stderr)
	exitCode := result.exitCode
	receipt.ExitCode = &exitCode
	if err != nil {
		receipt.Outcome = "failed"
		finishReceipt(&receipt)
		return receipt, err
	}
	if result.timedOut {
		receipt.Outcome = "unknown"
		finishReceipt(&receipt)
		return receipt, opError("mutation_outcome_unknown", "Docker CLI timed out during the mutation; reconciliation is required.", context.DeadlineExceeded, map[string]any{
			"receipt": receipt,
		})
	}
	if result.exitCode != 0 {
		receipt.Outcome = "failed"
		finishReceipt(&receipt)
		return receipt, opError("container_action_failed", "Docker CLI rejected the container mutation.", nil, map[string]any{
			"receipt": receipt,
		})
	}
	receipt.Outcome = "succeeded"
	finishReceipt(&receipt)
	return receipt, nil
}

func baseReceipt(id string, started time.Time, params ContainersActionParams, source string) OperationReceipt {
	return OperationReceipt{
		OperationID: id, Context: params.Context, ContainerID: params.ID, Action: params.Action,
		Source: source, Outcome: "pending", StartedAt: started.Format(time.RFC3339Nano),
	}
}

func finishReceipt(receipt *OperationReceipt) {
	completed := time.Now().UTC()
	receipt.CompletedAt = completed.Format(time.RFC3339Nano)
	started, err := time.Parse(time.RFC3339Nano, receipt.StartedAt)
	if err == nil {
		receipt.DurationMs = completed.Sub(started).Milliseconds()
	}
}

func engineHTTPError(code, message string, status int, body []byte) *OpError {
	details := map[string]any{"status": status}
	var response struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &response) == nil && response.Message != "" {
		details["engineMessage"] = response.Message
	} else if len(body) > 0 {
		details["body"] = string(body)
	}
	return opError(code, message, nil, details)
}

func validateRequiredContext(contextName string) error {
	if contextName == "" {
		return opError("context_required", "An explicit Docker context is required.", nil, nil)
	}
	return validateContextName(contextName)
}

func validateContextName(contextName string) error {
	if len(contextName) > 255 {
		return opError("invalid_context", "Docker context name is too long.", nil, nil)
	}
	if strings.ContainsAny(contextName, "\x00\r\n") {
		return opError("invalid_context", "Docker context name contains control characters.", nil, nil)
	}
	return nil
}

func validateContainerID(id string) error {
	if len(id) != 64 {
		return opError("invalid_container_id", "A full immutable 64-character container ID is required.", nil, map[string]any{
			"length": len(id),
		})
	}
	for _, char := range id {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return opError("invalid_container_id", "Container ID must be hexadecimal.", nil, nil)
		}
	}
	return nil
}

func validateAction(params ContainersActionParams) error {
	switch params.Action {
	case "start", "stop", "restart", "remove", "pause", "unpause", "kill", "rename", "update":
	default:
		return opError("unsupported_container_action", "Container action is not in the mutation allowlist.", nil, map[string]any{
			"action": params.Action,
		})
	}
	if params.Options.TimeoutSeconds < 0 || params.Options.TimeoutSeconds > 600 {
		return opError("invalid_timeout", "Container timeout must be between 0 and 600 seconds.", nil, nil)
	}
	if params.Action != "stop" && params.Action != "restart" && params.Options.TimeoutSeconds != 0 {
		return opError("invalid_action_options", "Timeout is only valid for container stop and restart.", nil, nil)
	}
	if params.Action != "remove" && (params.Options.Force || params.Options.Volumes) {
		return opError("invalid_action_options", "Force and volume removal options are only valid for remove.", nil, nil)
	}
	if params.Options.Name != "" && params.Action != "rename" {
		return opError("invalid_action_options", "Name is only valid for container rename.", nil, nil)
	}
	if params.Action == "rename" && !containerNamePattern(params.Options.Name) {
		return opError("invalid_container_name", "Container name contains an unsupported character.", nil, map[string]any{
			"name": params.Options.Name,
		})
	}
	if params.Action != "update" &&
		(params.Options.CPUShares != 0 || params.Options.MemoryBytes != 0 || params.Options.RestartPolicy != "") {
		return opError("invalid_action_options", "Resource limits are only valid for container update.", nil, nil)
	}
	if params.Action == "update" {
		if params.Options.CPUShares < 0 || params.Options.CPUShares > 262_144 {
			return opError("invalid_action_options", "CPU shares are outside the supported range.", nil, nil)
		}
		// Docker rejects a memory limit below 6 MiB.
		if params.Options.MemoryBytes != 0 && params.Options.MemoryBytes < 6*1024*1024 {
			return opError("invalid_action_options", "Memory limit must be at least 6 MiB.", nil, nil)
		}
		if !allowedRestartPolicies[params.Options.RestartPolicy] {
			return opError("invalid_restart_policy", "Restart policy is not supported.", nil, nil)
		}
	}
	if params.Options.Signal != "" {
		if params.Action != "kill" {
			return opError("invalid_action_options", "Signal is only valid for container kill.", nil, nil)
		}
		if err := validateContainerSignal(params.Options.Signal); err != nil {
			return err
		}
	}
	if params.Action == "remove" && !params.Options.Confirmed {
		return confirmationRequired("container", params.ID, params.Action)
	}
	if params.Action != "remove" && params.Options.Confirmed {
		return opError("invalid_action_options", "Confirmation is only valid for container remove.", nil, nil)
	}
	return nil
}

// Docker accepts signal names ("SIGTERM", "TERM") or numbers. Keep this deliberately narrow:
// the value becomes a query parameter and an argv element, so it must never carry anything a
// shell or URL could reinterpret.
func validateContainerSignal(signal string) error {
	if len(signal) > 20 {
		return opError("invalid_signal", "Container signal is too long.", nil, nil)
	}
	for _, r := range signal {
		isUpper := r >= 'A' && r <= 'Z'
		isDigit := r >= '0' && r <= '9'
		if !isUpper && !isDigit {
			return opError("invalid_signal", "Container signal must be an uppercase signal name or number.", nil, map[string]any{
				"signal": signal,
			})
		}
	}
	return nil
}

func mutationTimeout(stopTimeout int) time.Duration {
	timeout := 2 * time.Minute
	if stopTimeout > 0 {
		candidate := time.Duration(stopTimeout+30) * time.Second
		if candidate > timeout {
			timeout = candidate
		}
	}
	return timeout
}

func compareAPIVersions(left, right string) int {
	parse := func(value string) (int, int) {
		major, minorText, _ := strings.Cut(strings.TrimPrefix(value, "v"), ".")
		majorValue, _ := strconv.Atoi(major)
		minorValue, _ := strconv.Atoi(minorText)
		return majorValue, minorValue
	}
	leftMajor, leftMinor := parse(left)
	rightMajor, rightMinor := parse(right)
	if leftMajor < rightMajor || leftMajor == rightMajor && leftMinor < rightMinor {
		return -1
	}
	if leftMajor > rightMajor || leftMajor == rightMajor && leftMinor > rightMinor {
		return 1
	}
	return 0
}

func healthFromStatus(status string) string {
	lower := strings.ToLower(status)
	switch {
	case strings.Contains(lower, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(lower, "(healthy)"):
		return "healthy"
	case strings.Contains(lower, "(health: starting)"):
		return "starting"
	default:
		return "none"
	}
}

func sortContainers(containers []Container) {
	sort.Slice(containers, func(i, j int) bool {
		if containers[i].Name == containers[j].Name {
			return containers[i].ID < containers[j].ID
		}
		return containers[i].Name < containers[j].Name
	})
}

func sortPorts(ports []Port) {
	sort.Slice(ports, func(i, j int) bool {
		if ports[i].PrivatePort != ports[j].PrivatePort {
			return ports[i].PrivatePort < ports[j].PrivatePort
		}
		if ports[i].PublicPort != ports[j].PublicPort {
			return ports[i].PublicPort < ports[j].PublicPort
		}
		if ports[i].IP != ports[j].IP {
			return ports[i].IP < ports[j].IP
		}
		return ports[i].Type < ports[j].Type
	})
}

func parseCLIPorts(raw string) []Port {
	ports := make([]Port, 0)
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		left, right, mapped := strings.Cut(item, "->")
		target := left
		ip := ""
		publicText := ""
		if mapped {
			target = right
			ip, publicText = splitHostPortLoose(left)
		}
		privateText, protocol, ok := strings.Cut(target, "/")
		if !ok {
			continue
		}
		privateRange := parsePortRange(privateText)
		publicRange := parsePortRange(publicText)
		if len(privateRange) == 0 {
			continue
		}
		for index, privatePort := range privateRange {
			port := Port{IP: ip, PrivatePort: privatePort, Type: protocol}
			if index < len(publicRange) {
				port.PublicPort = publicRange[index]
			} else if len(publicRange) == 1 {
				port.PublicPort = publicRange[0]
			}
			ports = append(ports, port)
		}
	}
	sortPorts(ports)
	return ports
}

func splitHostPortLoose(value string) (string, string) {
	value = strings.TrimSpace(value)
	if host, port, err := net.SplitHostPort(value); err == nil {
		return host, port
	}
	index := strings.LastIndex(value, ":")
	if index < 0 {
		return "", value
	}
	return strings.Trim(value[:index], "[]"), value[index+1:]
}

func parsePortRange(value string) []uint16 {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	startText, endText, ranged := strings.Cut(value, "-")
	start, err := strconv.ParseUint(startText, 10, 16)
	if err != nil || start == 0 {
		return nil
	}
	if !ranged {
		return []uint16{uint16(start)}
	}
	end, err := strconv.ParseUint(endText, 10, 16)
	if err != nil || end < start || end-start > 1024 {
		return nil
	}
	result := make([]uint16, 0, end-start+1)
	for port := start; port <= end; port++ {
		result = append(result, uint16(port))
	}
	return result
}

// parseCLILabels reads Docker's CLI label formatting: "k=v,k2=v2". Values may contain '=',
// so only the first separator is significant.
func parseCLILabels(raw string) map[string]string {
	labels := map[string]string{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		key, value, found := strings.Cut(entry, "=")
		if !found || key == "" {
			continue
		}
		labels[key] = value
	}
	if len(labels) == 0 {
		return nil
	}
	return labels
}

// stream issues a request and hands back the live body instead of buffering it. The archive
// endpoints return tar streams that can be arbitrarily large — a directory listing reads only
// the headers it needs and abandons the rest, which buffering would make impossible.
//
// The caller owns the returned ReadCloser and must close it.
func (c *engineClient) stream(ctx context.Context, method, path string) (io.ReadCloser, int, error) {
	request, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, nil)
	if err != nil {
		return nil, 0, opError("engine_request_invalid", "Docker Engine request could not be created.", err, nil)
	}
	request.Header.Set("Accept", "application/x-tar")
	response, err := c.httpClient.Do(request)
	if err != nil {
		code, message := "engine_unreachable", "Docker Engine could not be reached."
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code, message = "engine_timeout", "Docker Engine did not respond in time."
		}
		return nil, 0, opError(code, message, err, nil)
	}
	return response.Body, response.StatusCode, nil
}
