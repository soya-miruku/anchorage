package core

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

/*
The Engine's own plugin system, which this application had no verb for at all.

`docker plugin ls` and the CLI plugins in plugins.go are different subsystems that share a word.
A CLI plugin is an executable the client shells out to; a managed plugin is a container the
daemon runs to provide a volume driver, a log driver, IPAM, metrics or authorization. Only the
first was reported anywhere, so half of Docker's plugin surface was invisible.

Read over the Engine API rather than `docker plugin ls`, for the reason the rest of the domain
reads that way: the socket answers with the daemon's own structures, including the privileges a
plugin was granted, which the CLI's table does not print.
*/

type enginePluginJSON struct {
	ID              string `json:"Id"`
	Name            string `json:"Name"`
	Enabled         bool   `json:"Enabled"`
	PluginReference string `json:"PluginReference"`
	Config          struct {
		Description   string `json:"Description"`
		Documentation string `json:"Documentation"`
		Interface     struct {
			Types []struct {
				Prefix     string `json:"Prefix"`
				Capability string `json:"Capability"`
				Version    string `json:"Version"`
			} `json:"Types"`
		} `json:"Interface"`
		Network struct {
			Type string `json:"Type"`
		} `json:"Network"`
		Linux struct {
			Capabilities    []string `json:"Capabilities"`
			AllowAllDevices bool     `json:"AllowAllDevices"`
			Devices         []struct {
				Name string  `json:"Name"`
				Path *string `json:"Path"`
			} `json:"Devices"`
		} `json:"Linux"`
		Mounts []struct {
			Name        string  `json:"Name"`
			Source      *string `json:"Source"`
			Destination string  `json:"Destination"`
		} `json:"Mounts"`
	} `json:"Config"`
	Settings struct {
		Devices []struct {
			Name string  `json:"Name"`
			Path *string `json:"Path"`
		} `json:"Devices"`
		Mounts []struct {
			Name        string  `json:"Name"`
			Source      *string `json:"Source"`
			Destination string  `json:"Destination"`
		} `json:"Mounts"`
	} `json:"Settings"`
}

// interfaceName renders Docker's split interface tuple the way the daemon names it, so a
// volumedriver reads as `docker.volumedriver/1.0` rather than three fields the surface has to
// reassemble.
func interfaceName(prefix, capability, version string) string {
	name := capability
	if prefix != "" {
		name = prefix + "." + capability
	}
	if version != "" {
		name += "/" + version
	}
	return name
}

func convertEnginePlugin(raw enginePluginJSON) EnginePlugin {
	interfaces := make([]string, 0, len(raw.Config.Interface.Types))
	for _, item := range raw.Config.Interface.Types {
		if name := interfaceName(item.Prefix, item.Capability, item.Version); name != "" {
			interfaces = append(interfaces, name)
		}
	}
	// Settings carry what the plugin was actually granted; Config carries what it asked for.
	// The granted set is the honest answer to "what can this reach", so it wins where present.
	mounts := make([]string, 0, len(raw.Settings.Mounts)+len(raw.Config.Mounts))
	for _, mount := range raw.Settings.Mounts {
		source := ""
		if mount.Source != nil {
			source = *mount.Source
		}
		if source == "" && mount.Destination == "" {
			continue
		}
		mounts = append(mounts, fmt.Sprintf("%s:%s", source, mount.Destination))
	}
	devices := make([]string, 0, len(raw.Settings.Devices))
	for _, device := range raw.Settings.Devices {
		if device.Path != nil && *device.Path != "" {
			devices = append(devices, *device.Path)
			continue
		}
		if device.Name != "" {
			devices = append(devices, device.Name)
		}
	}
	capabilities := raw.Config.Linux.Capabilities
	if capabilities == nil {
		capabilities = []string{}
	}
	return EnginePlugin{
		ID:            raw.ID,
		Name:          raw.Name,
		Enabled:       raw.Enabled,
		Reference:     raw.PluginReference,
		Description:   raw.Config.Description,
		Documentation: raw.Config.Documentation,
		Interfaces:    interfaces,
		Privileges: EnginePluginPrivileges{
			Network:         raw.Config.Network.Type,
			Capabilities:    capabilities,
			AllowAllDevices: raw.Config.Linux.AllowAllDevices,
			Mounts:          mounts,
			Devices:         devices,
		},
	}
}

func (s *Service) enginePluginsList(
	parent context.Context,
	params EnginePluginsListParams,
) (EnginePluginsListResult, error) {
	contextName := strings.TrimSpace(params.Context)
	if err := validateRequiredContext(contextName); err != nil {
		return EnginePluginsListResult{}, err
	}
	ctx, cancel := context.WithTimeout(parent, domainReadTimeout)
	defer cancel()
	endpoint, err := s.resolveEngineEndpoint(ctx, contextName)
	if err != nil {
		return EnginePluginsListResult{}, err
	}
	client, err := s.engineClient(ctx, endpoint)
	if err != nil {
		return EnginePluginsListResult{}, err
	}
	status, body, err := client.request(ctx, http.MethodGet, "/v"+client.apiVersion+"/plugins", nil)
	if err != nil {
		return EnginePluginsListResult{}, err
	}
	if status < 200 || status >= 300 {
		return EnginePluginsListResult{}, engineHTTPError(
			"engine_plugins_list_failed",
			"Docker Engine rejected the plugin list request.", status, body,
		)
	}
	var raw []enginePluginJSON
	if err := json.Unmarshal(body, &raw); err != nil {
		return EnginePluginsListResult{}, opError(
			"engine_plugins_list_invalid",
			"Docker Engine returned invalid plugin JSON.", err, nil,
		)
	}
	plugins := make([]EnginePlugin, 0, len(raw))
	for _, item := range raw {
		plugins = append(plugins, convertEnginePlugin(item))
	}
	sort.Slice(plugins, func(i, j int) bool { return plugins[i].Name < plugins[j].Name })
	return EnginePluginsListResult{
		ProtocolVersion: ProtocolVersion,
		Context:         contextName,
		Source:          "engine-api",
		APIVersion:      client.apiVersion,
		Plugins:         plugins,
		ObservedAt:      nowUTC(),
		EndpointHash:    endpoint.endpointHash,
	}, nil
}
