import type { MaturityLevel } from "../components/LevelChip";
import type { ViewId } from "../types";

/**
 * The feature-maturity catalogue behind the lifecycle drawer.
 *
 * Source of record is the maturity table in
 * `docs/design_handoff_anchorage/docker-features.md:44-70` (25 rows, each with a Docker
 * Documentation citation). The v2 handoff's own LIFE catalogue
 * (`Anchorage v2.dc.html:2599-2743`) is a derivation of that table, so these entries are
 * transcribed from the handoff and then reconciled against the source. Where the two
 * disagree the source wins, and the disagreement is recorded on the entry.
 *
 * All 21 handoff destinations carry entries, including the ones this build cannot serve on
 * this host. That is deliberate: maturity answers "how much should you depend on this",
 * which is a different question from "can this build reach it" — a capability can be
 * present and Experimental, or absent and GA everywhere else. The screen behind an
 * unreachable destination says which plugin is missing; the drawer says how settled the
 * capability is once you have it.
 *
 * Two rules keep this honest:
 *
 *   - The level grades the capability, not this build's coverage of it. Where a handoff
 *     description would read as a promise about *this build*, it is narrowed to what this
 *     build does or attributed to the product that does it — the level does not move
 *     either way, because how settled a capability is does not depend on what Anchorage
 *     renders.
 *   - `entitlement` carries the plan or paid tier the source records. Without it a screen
 *     made entirely of paid GA capabilities reads "all GA" to a free-plan user who cannot
 *     reach any of it.
 */

export interface MaturityEntry {
  name: string;
  level: MaturityLevel;
  description: string;
  /** Plan or paid tier required, when the source records one. */
  entitlement?: string;
}

const CATALOGUE: Partial<Record<ViewId, MaturityEntry[]>> = {
  dashboard: [
    {
      name: "Engine telemetry",
      level: "ga",
      description:
        "Live CPU, memory and disk accounting for the local engine.",
    },
    {
      name: "System prune",
      level: "ga",
      description:
        "Reclaims dangling images, stopped containers and build cache.",
    },
    {
      name: "Reclaimable estimate",
      level: "beta",
      description:
        "Projected savings are approximate until a prune actually runs.",
    },
  ],
  containers: [
    {
      name: "Container lifecycle",
      level: "ga",
      description: "Start, stop, restart, pause, kill and delete.",
    },
    {
      name: "Exec terminal",
      level: "ga",
      description: "Attach an interactive shell to a running container.",
    },
    {
      name: "File browser",
      level: "ga",
      description:
        "Browse and transfer files by reading the container's own archive stream, so it works on slim and distroless images.",
    },
    {
      // Handoff says Beta (Anchorage v2.dc.html:2609); the source table says
      // "GA, paid plans" (docker-features.md:51). Source wins, entitlement recorded.
      name: "Debug toolbox",
      level: "ga",
      description:
        "Attaches a temporary toolbox to slim and distroless containers.",
      entitlement: "Paid plans",
    },
    {
      // No handoff entry. Source row docker-features.md:64, and it is the stated
      // mitigation for containers sharing one kernel (docker-features.md:2188-2192).
      name: "Enhanced Container Isolation",
      level: "ga",
      description:
        "User namespaces and Sysbox, so a container root is not a host root. Not enabled by this build.",
      entitlement: "Business",
    },
    {
      name: "Checkpoints",
      level: "experimental",
      description:
        "Requires runtime support and is not available on every platform.",
    },
  ],
  images: [
    {
      name: "Local image store",
      level: "ga",
      description: "Pull, push, inspect, run and remove images.",
    },
    {
      name: "containerd image store",
      level: "ga",
      description:
        "Multi-platform images, attestations and alternative snapshotters.",
    },
    {
      name: "Registry search",
      level: "ga",
      description: "Search connected registries and pull by tag or digest.",
    },
    {
      name: "Vulnerability analysis",
      level: "ga",
      description:
        "Docker Scout CVE matching and layer attribution, run on request rather than in the background.",
    },
    {
      // Attributed rather than dropped, per the second rule above: the level grades the
      // capability, and Docker Desktop is what has it. Anchorage's image detail reads
      // config, layers and Scout findings — there is no attestation surface in this build,
      // so an unattributed entry here would read as a promise about the Images screen.
      name: "Attestation viewer",
      level: "early-access",
      description:
        "Docker Desktop reads SBOM and provenance attestations stored beside an image. Anchorage does not project them.",
    },
  ],
  volumes: [
    {
      // The full set the handoff claims (Anchorage v2.dc.html:2619). Docker has no clone or
      // empty verb; both are helper-container operations, which is how Docker Desktop
      // implements them too — see core/internal/core/volumes_clone.go.
      name: "Volume management",
      level: "ga",
      description:
        "Create, inspect, clone, empty and delete volumes. A clone carries the contents but not the source's labels or driver options, so it is a copy rather than a stand-in.",
    },
    {
      name: "Content browser",
      level: "ga",
      description:
        "Browse and modify volume contents without starting a container.",
    },
    {
      name: "Back up and restore",
      level: "ga",
      description:
        "Archives a volume to a host path you choose. The archive is plaintext — it holds everything the workload was trusted with.",
    },
    {
      name: "Scheduled exports",
      level: "early-access",
      description:
        "Recurring backups to an archive, image or supported destination.",
    },
  ],
  networks: [
    // No handoff entry: the v2 nav has no Networks destination. `docker network` is
    // core Engine surface (docs/parity-and-release-gates.md:20-22), so the screen stays
    // and carries its own entries.
    {
      name: "Network management",
      level: "ga",
      description: "Inspect, create and remove user-defined networks.",
    },
    {
      name: "Network pruning",
      level: "ga",
      description: "Removes networks no container is attached to.",
    },
  ],
  compose: [
    {
      name: "Application model",
      level: "ga",
      description:
        "Services, networks, volumes, configs, secrets and profiles.",
    },
    {
      name: "Project lifecycle",
      level: "ga",
      description: "Up, down, start, stop and restart a discovered project.",
    },
    {
      name: "Health-gated startup",
      level: "ga",
      description:
        "Wait for healthy or completed rather than merely started. Anchorage does not yet show the declared order.",
    },
    {
      // Was dropped when this catalogue was transcribed. It belongs: Compose 5.3 ships it
      // (docker-features.md:903-913) and Compose v5 is GA in the source table (:49), so the
      // rule that omits genuinely upcoming capabilities does not reach it. Anchorage listing
      // projects rather than declared services narrows the description, not the level.
      name: "Init services",
      level: "ga",
      description:
        "Run to completion in order before the application starts. Anchorage lists projects, not the services declared inside them.",
    },
    {
      name: "Watch",
      level: "ga",
      description:
        "Sync, restart or rebuild on file changes. Reachable through Command Center only.",
    },
    {
      name: "Lifecycle hooks",
      level: "ga",
      description:
        "Post-start and pre-stop steps with their own privileges.",
    },
    {
      name: "Model declarations",
      level: "ga",
      description: "AI models as first-class application dependencies.",
    },
    {
      name: "Provider services",
      level: "early-access",
      description:
        "Declare an external capability without running a container.",
    },
    {
      name: "Kubernetes bridge",
      level: "beta",
      description:
        "A translation layer — not every semantic has an equivalent.",
    },
  ],
  builds: [
    {
      name: "BuildKit build records",
      level: "ga",
      description:
        "Timings, cache use and inputs for every local build. Buildx does not report per-step detail, so Anchorage does not show a step table.",
    },
    {
      name: "Bake targets",
      level: "ga",
      description: "Coordinated multi-target builds from one configuration.",
    },
    {
      name: "Imported CI records",
      level: "ga",
      description:
        "A pipeline can publish build traces with `buildx history import`, but they land in Docker Desktop. Anchorage lists this machine's buildx record store only.",
    },
    {
      name: "Build policies",
      level: "early-access",
      description:
        "Machine-checked rules for sources, registries and base images.",
    },
    {
      name: "Cloud builders",
      level: "ga",
      description:
        "Remote BuildKit with a persistent shared cache.",
      entitlement: "Paid plans",
    },
  ],
  devenv: [
    {
      name: "Dev Environments",
      level: "deprecated",
      description:
        "Superseded by Sandboxes; scheduled for removal in a future release.",
    },
  ],
  extensions: [
    {
      name: "Extension runtime",
      level: "ga",
      description:
        "Extensions ship as images with a UI and optional backend container. An extension may be granted the Docker socket and host executables.",
    },
    {
      name: "Private marketplace",
      level: "ga",
      description:
        "Organisations can publish an internal, curated catalogue.",
    },
    {
      name: "Public marketplace",
      level: "beta",
      description:
        "New public submissions are paused pending a security review.",
    },
  ],
  logs: [
    // Every row here grades Docker Desktop's unified Logs view (docker-features.md:527-537).
    // Anchorage streams one container at a time and has no merged view, so the rows a reader
    // could otherwise take for a promise about this build name their subject.
    {
      name: "Unified stream",
      level: "ga",
      description:
        "Docker Desktop's Logs view puts container and build output in one place, filtered together.",
    },
    {
      name: "Regular expressions",
      level: "ga",
      description: "Full regex matching across every selected source.",
    },
    {
      name: "Export",
      level: "ga",
      description: "Writes the current filtered view to a file.",
    },
    {
      name: "Saved filters",
      level: "early-access",
      description: "Reusable predicates shared across a team.",
    },
    {
      name: "Retention",
      level: "beta",
      description:
        "Roughly 100,000 entries in that view; forward to a real log system for more.",
    },
  ],
  kubernetes: [
    {
      name: "kubeadm cluster",
      level: "ga",
      description: "Single node at a fixed version, sharing the engine image store.",
    },
    {
      name: "kind cluster",
      level: "ga",
      description: "Configurable version and multiple nodes.",
    },
    {
      // Same subject problem as Logs: this is the Desktop UI reading cluster state
      // (docker-features.md:548), and Anchorage projects no state from a cluster at all.
      name: "Object browser",
      level: "early-access",
      description:
        "Docker Desktop's UI reads cluster state without dropping to kubectl.",
    },
    {
      name: "Compose bridge deployment",
      level: "beta",
      description: "Applies generated manifests to this cluster.",
    },
  ],
  bosun: [
    {
      // Bosun is Anchorage's name for a Docker capability, so the level has to be
      // traceable to Docker's: Gordon / `docker ai`, GA in the source table
      // (docker-features.md:52) since Docker Desktop 4.74 (:1009).
      name: "Bosun assistant (Docker Gordon)",
      level: "ga",
      description: "Docker-aware chat that can inspect and, with approval, act.",
    },
    {
      name: "Command approval",
      level: "ga",
      description: "Per-action, per-session or bypassed — your choice, per thread.",
    },
    {
      name: "File editing",
      level: "ga",
      description: "Writes inside the working directory, which is context and not a boundary.",
    },
    {
      name: "Web access",
      level: "beta",
      description: "Off by default; when on, prompts may leave the machine.",
    },
    {
      name: "Secret redaction",
      level: "beta",
      description: "Defence in depth, not a guarantee the model never sees a value.",
    },
  ],
  models: [
    {
      name: "Local inference",
      level: "ga",
      description: "Pull, run and serve models from an OCI registry on this host.",
    },
    {
      name: "OpenAI-compatible API",
      level: "ga",
      description: "Chat, completions and embeddings on the local endpoint.",
    },
    {
      name: "vLLM engine",
      level: "early-access",
      description: "Linux x86-64 and Windows WSL 2 only; Safetensors models.",
    },
    {
      name: "Diffusers engine",
      level: "beta",
      description: "Image pipelines on eligible Nvidia configurations.",
    },
    {
      name: "Hugging Face import",
      level: "beta",
      description: "Repackages supported HF repositories as OCI artifacts.",
    },
    {
      name: "API authentication",
      level: "experimental",
      description: "There is none by default — do not expose the port to a network.",
    },
  ],
  agents: [
    {
      name: "Agent framework",
      level: "ga",
      description: "Declarative multi-agent definitions with delegation.",
    },
    {
      name: "OCI distribution",
      level: "ga",
      description: "Push and pull agent configurations like any other artifact.",
    },
    {
      name: "Editor protocol (ACP)",
      level: "early-access",
      description: "Drives an agent from a supported editor.",
    },
    {
      name: "Session replay",
      level: "beta",
      description: "Re-runs a recorded transcript against a changed configuration.",
    },
    {
      name: "Evals",
      level: "beta",
      description: "Scores a candidate configuration against a fixed task set.",
    },
    {
      name: "Agent-to-agent protocol",
      level: "experimental",
      description: "Evolving; not a stable interoperability contract yet.",
    },
  ],
  tools: [
    // Semantic interception is omitted: docker-features.md:2289-2300 files it under what is genuinely upcoming, with no evidence it has shipped. Labelling it Experimental would launder unannounced availability into a maturity level.
    {
      name: "MCP Gateway",
      level: "ga",
      description: "One endpoint that proxies, isolates and routes every tool server.",
    },
    {
      // Handoff says "weekly patches" (Anchorage v2.dc.html:2670). The source lists
      // signatures, SBOMs and security updates with no cadence anywhere
      // (docker-features.md:1318-1326), so the cadence goes rather than being invented.
      name: "Catalog",
      level: "ga",
      description: "Signed, containerised servers with SBOMs and security updates.",
    },
    {
      name: "Profiles",
      level: "early-access",
      description: "Grouped configurations — not a credential boundary.",
    },
    {
      name: "Interceptors",
      level: "early-access",
      description: "Programmable inspection of requests and responses.",
    },
    {
      name: "Toolkit UI",
      level: "beta",
      description: "This management surface is still stabilising.",
    },
    {
      name: "Dynamic tool selection",
      level: "experimental",
      description: "Agents pick tools at runtime; code-execution mode is very early.",
    },
  ],
  sandboxes: [
    // The source table records Sandboxes as current with several subfeatures still Experimental or Early Access (docker-features.md:60), which is what these levels reflect rather than the handoff GA.
    {
      name: "Sandbox microVMs",
      level: "ga",
      description: "One kernel and one daemon per sandbox.",
    },
    {
      name: "Clone workspaces",
      level: "ga",
      description: "Read-only host source plus a private writable clone inside the VM.",
    },
    {
      name: "Network policy presets",
      level: "ga",
      description: "Enforced at the host proxy, outside the agent’s control.",
    },
    {
      name: "Templates",
      level: "early-access",
      description: "Reusable sandbox images shared across a team.",
    },
    {
      name: "Shared skills store",
      level: "early-access",
      description: "Convenient, but a writable share bridges trust between sandboxes.",
    },
    {
      name: "SSH access",
      level: "experimental",
      description: "Editor integration over sandbox-name.sbx; credentials are not forwarded.",
    },
    {
      name: "Kits",
      level: "experimental",
      description: "Declarative setup bundles — review them like an installer.",
    },
  ],
  scan: [
    // Third-party composition analysis is omitted: docker-features.md:2370-2374 files the
    // Black Duck integration under what is genuinely upcoming. Same rule as semantic
    // interception below — an announced integration is not a Beta capability.
    {
      name: "Vulnerability analysis",
      level: "ga",
      description: "SBOM generation, CVE matching and layer attribution.",
    },
    {
      // The source describes the policy checks without assigning a status
      // (docker-features.md:2006-2010) and has no Scout table row, so the level tracks the
      // platform capability. The local verb is a different surface: the scout plugin on this
      // host (v1.18.3) prints "(experimental)" beside `policy`, and `docker scout policy
      // --help` says results come from the platform when they exist there.
      name: "Policy evaluation",
      level: "ga",
      description:
        "Base-image currency, attestation presence and documented exceptions, graded on the Scout platform. The local `docker scout policy` command is still experimental.",
    },
    {
      name: "VEX exceptions",
      level: "ga",
      description: "Records that a finding does not affect this configuration.",
    },
    {
      name: "Background analysis",
      level: "early-access",
      description: "Scans local images as they are pulled or built.",
    },
  ],
  hardened: [
    // Hardened Images have no row in the source table, so the qualifiers come from §21.2:
    // only the community catalogue is open and free, and the higher-assurance tiers are
    // commercial (docker-features.md:2026-2027, :2031). They are image tiers rather than
    // Docker subscription plans, which is why they are not worded like "Business".
    {
      name: "Community catalogue",
      level: "ga",
      description: "Minimal, non-root, signed images with SLSA Build Level 3 provenance.",
    },
    {
      name: "FIPS variants",
      level: "ga",
      description: "Validated cryptographic modules for regulated workloads.",
      entitlement: "Paid tier",
    },
    {
      name: "STIG variants",
      level: "early-access",
      description: "Hardening baselines for government deployment.",
      entitlement: "Paid tier",
    },
    {
      name: "Enterprise customisation",
      level: "early-access",
      description: "Your own packages and policies on a hardened base.",
      entitlement: "Enterprise tier",
    },
  ],
  secrets: [
    {
      name: "Secret references",
      level: "ga",
      description: "se:// URIs resolved at run time instead of plaintext in config.",
    },
    {
      name: "OS keychain backend",
      level: "ga",
      description: "Native keychain on macOS, Windows and Linux.",
    },
    {
      // The table's blanket "several plugins and commands remain Experimental"
      // (docker-features.md:67) is about the engine, and the three Experimental rows below
      // discharge it: §17 marks only `docker pass run` (:1811), community engine (:1849)
      // and compose build (:1848), while listing the 1Password backends as current
      // (:1790-1791). Beta is what §25.9's "Stabilising password-manager plugins" (:2361)
      // amounts to — still moving, not liable to vanish.
      name: "Password-manager plugins",
      level: "beta",
      description: "1Password CLI and SDK integration.",
    },
    {
      name: "Host command injection",
      level: "experimental",
      description: "Resolving a secret for a process outside a container.",
    },
    {
      name: "Build-time references",
      level: "experimental",
      description: "Compose build does not consume se:// references yet.",
    },
    {
      name: "Community engine support",
      level: "experimental",
      description: "Standalone Linux packages lag the integrated experience.",
    },
  ],
  governance: [
    // Only SAML/SCIM is a Docker Business entitlement. The AI-governance rows are a separate
    // product the source records as "Limited enterprise availability" (docker-features.md:68,
    // :1871) — an availability statement, not a plan, so they must not read as "buy Business
    // and you have this".
    {
      name: "SAML and SCIM",
      level: "ga",
      description: "Identity federation and automated provisioning.",
      entitlement: "Business",
    },
    {
      name: "Sandbox policy",
      level: "early-access",
      description: "Central network, filesystem and credential rules.",
      entitlement: "Enterprise (limited availability)",
    },
    {
      name: "MCP policy",
      level: "early-access",
      description: "Server and tool allowlists enforced at the gateway.",
      entitlement: "Enterprise (limited availability)",
    },
    {
      // Handoff says "90-day retention" (Anchorage v2.dc.html:2724). §18 records audit
      // records (docker-features.md:1866) and SIEM-oriented visibility (:1869) with no
      // retention period; the only retention figure in the source is Gordon's five days
      // (:1056), which is a different product. The figure goes.
      name: "Audit stream",
      level: "early-access",
      description: "Events exported to a SIEM.",
      entitlement: "Enterprise (limited availability)",
    },
    {
      name: "Policy inheritance",
      level: "experimental",
      description: "Organisation policy replaces local policy; merge order is changing.",
      entitlement: "Enterprise (limited availability)",
    },
  ],
  cloud: [
    // GPU instances, bring-your-own-cloud and CI integration are omitted: docker-features.md:2255-2287 files all three under what is genuinely upcoming, with no announced availability. The drawer exists to stop pre-release reading as settled, so it may not itself assign them a shipped level.
    {
      name: "Remote engine session",
      level: "ga",
      description: "Builds, containers, Compose and volumes on a managed runner.",
      entitlement: "Business add-on",
    },
    {
      name: "Cloud builders",
      level: "ga",
      description: "Remote BuildKit with a persistent shared cache.",
      entitlement: "Paid plans",
    },
  ],
  settings: [
    {
      name: "Resources & Resource Saver",
      level: "ga",
      description:
        "VM limits and idle shutdown for the Linux VM behind the engine. Anchorage talks to the host engine directly, so there is no VM to bound.",
    },
    {
      name: "Engine JSON",
      level: "ga",
      description:
        "Raw daemon configuration. Invalid values stop the engine from starting.",
    },
    {
      name: "File sharing",
      level: "ga",
      description:
        "VirtioFS by default, with a synchronised cache for large repositories. A Docker Desktop VM concept with no host-engine equivalent.",
    },
    {
      // Source table records this as Docker's macOS virtualization implementation
      // (docker-features.md:63), so it can never apply to a Linux host build.
      name: "Docker VMM",
      level: "beta",
      description:
        "Docker's own macOS VM monitor. Not applicable to a Linux host engine.",
    },
    {
      name: "Wasm workloads",
      level: "deprecated",
      description:
        "No longer maintained; use an alternative runtime on a standalone engine.",
    },
  ],
};

export function maturityFor(view: ViewId): MaturityEntry[] {
  return CATALOGUE[view] ?? [];
}

/**
 * Entries a user should not treat as settled — every level that is not GA. Deprecated is
 * one of them, which is why this counts distance from GA in either direction rather than
 * calling itself pre-GA: Dev Environments is a single Deprecated entry, and that is past
 * GA, not before it.
 */
export function notGaCount(entries: MaturityEntry[]) {
  return entries.filter((entry) => entry.level !== "ga").length;
}

/**
 * Entries that are GA but unreachable without a plan the user may not hold. `notGaCount`
 * deliberately does not fold these in — "not GA" and "not entitled" are different
 * questions — but a screen made entirely of paid GA capabilities must not read as
 * unqualified green either.
 */
export function entitledCount(entries: MaturityEntry[]) {
  return entries.filter((entry) => entry.entitlement).length;
}
