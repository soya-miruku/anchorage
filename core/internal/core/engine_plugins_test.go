package core

import (
	"encoding/json"
	"testing"
)

/*
Reading the daemon's plugin list.

The privileges are the reason this is not a thin passthrough. Docker asks for consent once, at
`docker plugin install`, and afterwards nothing shows what was granted — so a plugin holding
CAP_SYS_ADMIN, host networking and a bind of `/` looks exactly like one holding nothing.
*/

// A volume driver as the Engine reports one, with the privilege shape that matters.
const sshfsPluginJSON = `[{
  "Id": "5724e2c8652da337ab2eedd19fc6fc0ec908e4bd907c7421bf6a8dfc70c4c078",
  "Name": "vieux/sshfs:latest",
  "Enabled": true,
  "PluginReference": "docker.io/vieux/sshfs:latest",
  "Config": {
    "Description": "sshFS plugin for Docker",
    "Documentation": "https://docs.docker.com/engine/extend/plugins/",
    "Interface": {"Types": [{"Prefix": "docker", "Capability": "volumedriver", "Version": "1.0"}]},
    "Network": {"Type": "host"},
    "Linux": {"Capabilities": ["CAP_SYS_ADMIN"], "AllowAllDevices": false, "Devices": null},
    "Mounts": []
  },
  "Settings": {
    "Devices": [{"Name": "fuse", "Path": "/dev/fuse"}],
    "Mounts": [{"Name": "sshdirectory", "Source": "/var/lib/docker/plugins/sshfs", "Destination": "/mnt/state"}]
  }
}]`

func TestEnginePluginConversionCarriesTheGrantedPrivileges(t *testing.T) {
	var raw []enginePluginJSON
	if err := json.Unmarshal([]byte(sshfsPluginJSON), &raw); err != nil {
		t.Fatalf("decoding the daemon's shape: %v", err)
	}
	plugin := convertEnginePlugin(raw[0])

	if plugin.Name != "vieux/sshfs:latest" || !plugin.Enabled {
		t.Fatalf("identity or state lost: %+v", plugin)
	}
	// The interface tuple is what says a volume driver is a volume driver.
	if len(plugin.Interfaces) != 1 || plugin.Interfaces[0] != "docker.volumedriver/1.0" {
		t.Fatalf("interface not rendered as the daemon names it: %+v", plugin.Interfaces)
	}
	// Every one of these is a grant the operator made once and cannot currently see.
	if plugin.Privileges.Network != "host" {
		t.Fatalf("host networking must be reported: %+v", plugin.Privileges)
	}
	if len(plugin.Privileges.Capabilities) != 1 || plugin.Privileges.Capabilities[0] != "CAP_SYS_ADMIN" {
		t.Fatalf("granted capabilities must be reported: %+v", plugin.Privileges)
	}
	if len(plugin.Privileges.Devices) != 1 || plugin.Privileges.Devices[0] != "/dev/fuse" {
		t.Fatalf("granted devices must be reported by path: %+v", plugin.Privileges)
	}
	if len(plugin.Privileges.Mounts) != 1 ||
		plugin.Privileges.Mounts[0] != "/var/lib/docker/plugins/sshfs:/mnt/state" {
		t.Fatalf("granted host mounts must be reported: %+v", plugin.Privileges)
	}
}

func TestEnginePluginReportsGrantedRatherThanRequested(t *testing.T) {
	// Config is what the plugin asked for; Settings is what it holds. An operator can narrow a
	// mount at install time, and reporting the request would overstate what it can reach.
	const narrowed = `[{
      "Id": "abc", "Name": "narrowed:latest", "Enabled": false,
      "Config": {
        "Interface": {"Types": [{"Prefix":"docker","Capability":"logdriver","Version":"1.0"}]},
        "Linux": {"Capabilities": null, "AllowAllDevices": false},
        "Mounts": [{"Name":"root","Source":"/","Destination":"/host"}]
      },
      "Settings": {"Mounts": [{"Name":"root","Source":"/srv/logs","Destination":"/host"}]}
    }]`
	var raw []enginePluginJSON
	if err := json.Unmarshal([]byte(narrowed), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	plugin := convertEnginePlugin(raw[0])
	if len(plugin.Privileges.Mounts) != 1 || plugin.Privileges.Mounts[0] != "/srv/logs:/host" {
		t.Fatalf("the granted mount must win over the requested one: %+v", plugin.Privileges.Mounts)
	}
	// A nil capability list is an empty grant, not an unknown one.
	if plugin.Privileges.Capabilities == nil || len(plugin.Privileges.Capabilities) != 0 {
		t.Fatalf("no capabilities must read as none, not null: %+v", plugin.Privileges.Capabilities)
	}
}

func TestEnginePluginsListRefusesWithoutAContext(t *testing.T) {
	service := newTestService(t, writeFakeDockerScript(t, "#!/bin/sh\nexit 0\n"))
	if _, err := service.enginePluginsList(t.Context(), EnginePluginsListParams{}); err == nil {
		t.Fatal("a context is required, as it is for every other domain read")
	}
}
