package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Changing a container's published ports.
//
// Docker fixes port bindings when a container is created. `docker update` cannot change them —
// it covers resources and restart policy — so there is no such thing as rebinding a container.
// The only supported route is to create a new container with the new bindings, which is what
// this does, and what the surface above it has to say plainly rather than presenting as an edit.
//
// Three consequences fall out of that and are reported rather than glossed:
//
//   - The container ID changes. Anything holding the old one is stale.
//   - The writable layer is discarded. Whatever a process wrote inside the container and not
//     into a volume or bind mount is gone.
//   - The log history goes with it, because logs belong to a container, not to a name.
//
// What is *not* discarded is everything Docker itself records: the create body is assembled from
// the container's own `Config` and `HostConfig` with only the port fields replaced. Hand-picking
// fields to copy would silently drop whatever the list forgot — a health check, a ulimit, a
// device, a capability — and the operator would have no way to know which.
type ContainersRebindPortsParams struct {
	Context string `json:"context"`
	ID      string `json:"id"`
	// Ports map "hostPort" to "containerPort/proto", e.g. {"8080": "80/tcp"}, matching
	// ContainersCreateParams. An empty map publishes nothing.
	Ports map[string]string `json:"ports"`
	// Confirmed must be set. This destroys a container; it is not a request to make by accident.
	Confirmed bool `json:"confirmed"`
}

type ContainersRebindPortsResult struct {
	Context string `json:"context"`
	// PreviousID is the container that was replaced. It no longer exists.
	PreviousID string   `json:"previousId"`
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Warnings   []string `json:"warnings"`
	// Discarded states what recreating could not carry over, in the operator's terms.
	Discarded    []string               `json:"discarded"`
	Receipt      DomainOperationReceipt `json:"receipt"`
	ObservedAt   string                 `json:"observedAt"`
	EndpointHash string                 `json:"endpointHash,omitempty"`
}

/**
 * The suffix a container is parked under while its replacement is created.
 */
const rebindParkedSuffix = "-anchorage-rebinding"

// containersRebindPorts replaces a container with one that publishes different ports.
//
// The old container is renamed rather than removed first. If creating the replacement fails —
// a port already in use is the common case — the original is renamed back and nothing was lost.
// Removing first and creating second would turn a rejected port into a destroyed container.
func (s *Service) containersRebindPorts(
	parent context.Context,
	params ContainersRebindPortsParams,
	emit EventEmitter,
) (ContainersRebindPortsResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return ContainersRebindPortsResult{}, err
	}
	id := strings.TrimSpace(params.ID)
	if id == "" {
		return ContainersRebindPortsResult{}, invalidParams(errors.New("id is required"))
	}
	// The full immutable ID, as every other container verb requires. This verb accepted any
	// non-empty string, which was the wrong way round: a prefix can resolve to a different
	// container between the moment a surface rendered it and the moment this acts, and this is
	// the verb that destroys the container it resolves to.
	if err := validateContainerID(id); err != nil {
		return ContainersRebindPortsResult{}, err
	}
	if !params.Confirmed {
		return ContainersRebindPortsResult{}, opError(
			"rebind_not_confirmed",
			"Republishing ports replaces the container, so it must be confirmed.",
			nil,
			map[string]any{"id": id},
		)
	}
	// The same validation `docker run` gets, reusing the create path's rules rather than a
	// second, subtly different copy of them.
	if err := validateContainersCreate(ContainersCreateParams{
		Context: contextName,
		Image:   "placeholder",
		Ports:   params.Ports,
	}); err != nil {
		return ContainersRebindPortsResult{}, err
	}

	operationID, err := operationID()
	if err != nil {
		return ContainersRebindPortsResult{}, opError("operation_id_failed", "Operation identifier could not be generated.", err, nil)
	}
	receipt := newDomainReceipt(operationID, contextName, "container", id, "rebind-ports", "engine-api")

	endpoint, err := s.resolveEngineEndpoint(parent, contextName)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ContainersRebindPortsResult{}, nativeTransportRequired("containers.rebindPorts", contextName, err)
		}
		emitDomainStarted(emit, "containers.rebindPorts", receipt)
		return ContainersRebindPortsResult{}, failDomainMutation(receipt, err, emit)
	}
	receipt.EndpointHash = endpoint.endpointHash
	ctx, cancel := context.WithTimeout(parent, domainMutationTimeout)
	defer cancel()
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		if errors.Is(err, errTransportUnsupported) {
			return ContainersRebindPortsResult{}, nativeTransportRequired("containers.rebindPorts", contextName, err)
		}
		emitDomainStarted(emit, "containers.rebindPorts", receipt)
		return ContainersRebindPortsResult{}, failDomainMutation(receipt, err, emit)
	}
	emitDomainStarted(emit, "containers.rebindPorts", receipt)

	// 1. Read the container's own definition. Everything except the ports is carried across
	//    exactly as Docker recorded it.
	status, body, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/containers/"+url.PathEscape(id)+"/json", nil)
	if err != nil {
		return ContainersRebindPortsResult{}, failDomainMutation(receipt, err, emit)
	}
	if status < 200 || status >= 300 {
		return ContainersRebindPortsResult{}, failDomainMutation(receipt,
			engineHTTPError("container_inspect_failed", "Docker Engine rejected the container inspection.", status, body), emit)
	}
	var existing struct {
		Name  string `json:"Name"`
		State struct {
			Running bool `json:"Running"`
			Paused  bool `json:"Paused"`
		} `json:"State"`
		Config     map[string]any `json:"Config"`
		HostConfig map[string]any `json:"HostConfig"`
	}
	if err := json.Unmarshal(body, &existing); err != nil {
		return ContainersRebindPortsResult{}, failDomainMutation(receipt,
			opError("container_inspect_invalid", "Docker Engine returned invalid container JSON.", err, nil), emit)
	}

	// 2. Refuse a container that is actively serving. A paused one is allowed: its processes
	//    are frozen, so replacing it interrupts nothing that was still answering.
	if existing.State.Running && !existing.State.Paused {
		return ContainersRebindPortsResult{}, failDomainMutation(receipt, opError(
			"rebind_container_running",
			"Ports can only be republished on a stopped or paused container, because Docker fixes bindings when a container is created and the container has to be replaced.",
			nil,
			map[string]any{"id": id, "state": "running"},
		), emit)
	}

	name := strings.TrimPrefix(existing.Name, "/")
	if name == "" {
		return ContainersRebindPortsResult{}, failDomainMutation(receipt, opError(
			"rebind_container_unnamed",
			"Docker reported no name for this container, so its replacement could not take the same one.",
			nil,
			map[string]any{"id": id},
		), emit)
	}

	config := existing.Config
	if config == nil {
		config = map[string]any{}
	}
	hostConfig := existing.HostConfig
	if hostConfig == nil {
		hostConfig = map[string]any{}
	}

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
	// Replace rather than merge: the operator is stating what should be published, and merging
	// would make removing a binding impossible.
	hostConfig["PortBindings"] = bindings
	config["ExposedPorts"] = exposed
	config["HostConfig"] = hostConfig

	// 3. Park the original under a different name so its name is free, while keeping it alive.
	parked := name + rebindParkedSuffix
	renamePath := "/v" + client.apiVersion + "/containers/" + url.PathEscape(id) + "/rename?name=" + url.QueryEscape(parked)
	renameStatus, renameBody, renameErr := client.request(ctx, http.MethodPost, renamePath, nil)
	if renameErr != nil {
		return ContainersRebindPortsResult{}, failDomainMutation(receipt, renameErr, emit)
	}
	if renameStatus < 200 || renameStatus >= 300 {
		return ContainersRebindPortsResult{}, failDomainMutation(receipt,
			engineHTTPError("container_rename_failed", "Docker Engine would not free the container's name.", renameStatus, renameBody), emit)
	}

	restoreName := func() {
		restorePath := "/v" + client.apiVersion + "/containers/" + url.PathEscape(id) + "/rename?name=" + url.QueryEscape(name)
		_, _, _ = client.request(ctx, http.MethodPost, restorePath, nil)
	}

	// 4. Create the replacement. Failing here leaves the original intact under its own name.
	encoded, err := json.Marshal(config)
	if err != nil {
		restoreName()
		return ContainersRebindPortsResult{}, failDomainMutation(receipt, err, emit)
	}
	createPath := "/v" + client.apiVersion + "/containers/create?name=" + url.QueryEscape(name)
	createStatus, createBody, createErr := client.request(ctx, http.MethodPost, createPath, bytes.NewReader(encoded))
	receipt.HTTPStatus = createStatus
	if createErr != nil {
		restoreName()
		return ContainersRebindPortsResult{}, failSubmittedMutation(receipt, createErr, emit)
	}
	if createStatus < 200 || createStatus >= 300 {
		restoreName()
		return ContainersRebindPortsResult{}, failDomainMutation(receipt,
			engineHTTPError("container_create_failed", "Docker Engine rejected the replacement container, so the original was left as it was.", createStatus, createBody), emit)
	}
	var created struct {
		ID       string   `json:"Id"`
		Warnings []string `json:"Warnings"`
	}
	if err := json.Unmarshal(createBody, &created); err != nil || created.ID == "" {
		restoreName()
		return ContainersRebindPortsResult{}, failDomainMutation(receipt,
			opError("container_create_invalid", "Docker Engine returned an invalid creation result, so the original was left as it was.", err, nil), emit)
	}

	// 5. The replacement exists and holds the name. Remove the parked original.
	removePath := "/v" + client.apiVersion + "/containers/" + url.PathEscape(id) + "?force=true"
	removeStatus, removeBody, removeErr := client.request(ctx, http.MethodDelete, removePath, nil)
	warnings := nonNilStrings(created.Warnings)
	if removeErr != nil || removeStatus < 200 || removeStatus >= 300 {
		// The replacement is live and correct; the original is orphaned under a name that says
		// so. Reported rather than swallowed, because a stray container consumes disk and its
		// name will collide with the next rebind.
		detail := ""
		if removeErr != nil {
			detail = removeErr.Error()
		} else {
			detail = engineHTTPError("container_remove_failed", "", removeStatus, removeBody).Error()
		}
		warnings = append(warnings, fmt.Sprintf(
			"The replacement was created, but the original container could not be removed and is still present as %q: %s",
			parked, detail,
		))
	}

	receipt.ResourceID = created.ID
	result := ContainersRebindPortsResult{
		Context:    contextName,
		PreviousID: id,
		ID:         created.ID,
		Name:       name,
		Warnings:   warnings,
		Discarded: []string{
			"The container ID changed, so anything holding the previous one is stale.",
			"The writable layer is gone: whatever a process wrote inside the container rather than into a volume or bind mount did not survive.",
			"Log history belongs to a container rather than to a name, so the previous logs are no longer reachable.",
		},
		ObservedAt:   nowUTC(),
		EndpointHash: endpoint.endpointHash,
	}
	succeedDomainMutation(&receipt, emit)
	result.Receipt = receipt
	return result, nil
}
