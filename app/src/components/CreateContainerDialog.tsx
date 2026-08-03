import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";

import type { ContainerCreateOptions } from "../types";

/**
 * A real `docker run` form.
 *
 * The product's two primary CTAs ("Run new" and the empty-state action) previously opened the
 * raw-argv Command Center, which is a terminal, not a container-creation surface. Every field
 * here maps to a validated protocol field rather than to argv text.
 */
export function CreateContainerDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: (options: ContainerCreateOptions) => void;
}) {
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState("");
  const [env, setEnv] = useState("");
  const [binds, setBinds] = useState("");
  const [command, setCommand] = useState("");
  const [restartPolicy, setRestartPolicy] =
    useState<ContainerCreateOptions["restartPolicy"]>("no");
  const [start, setStart] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const lines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const reference = image.trim();
    if (!reference) return;

    // Parse "8080:80" / "8080:80/udp" the way `docker run -p` does.
    const parsedPorts: Record<string, string> = {};
    for (const entry of lines(ports)) {
      const [host, target] = entry.split(":");
      if (!host || !target || !/^[0-9]{1,5}$/u.test(host)) {
        setProblem(`Port mapping “${entry}” must be hostPort:containerPort`);
        return;
      }
      if (!/^[0-9]{1,5}(\/(tcp|udp|sctp))?$/u.test(target)) {
        setProblem(`Port mapping “${entry}” has an invalid container port`);
        return;
      }
      parsedPorts[host] = target;
    }

    const parsedEnv = lines(env);
    const bad = parsedEnv.find((entry) => !entry.includes("="));
    if (bad) {
      setProblem(`Environment entry “${bad}” must be KEY=VALUE`);
      return;
    }

    setProblem(null);
    onConfirm({
      image: reference,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(Object.keys(parsedPorts).length > 0 ? { ports: parsedPorts } : {}),
      ...(parsedEnv.length > 0 ? { env: parsedEnv } : {}),
      ...(lines(binds).length > 0 ? { binds: lines(binds) } : {}),
      ...(command.trim() ? { command: command.trim().split(/\s+/u) } : {}),
      ...(restartPolicy && restartPolicy !== "no" ? { restartPolicy } : {}),
      start,
    });
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <form
        className="create-environment-dialog create-container-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-container-title"
        data-testid="create-container-dialog"
        onSubmit={submit}
      >
        <div className="create-environment-dialog__heading">
          <div>
            <h2 id="create-container-title">Run a container</h2>
            <p>Anchorage sends these as validated fields, not as a shell command.</p>
          </div>
          <button type="button" aria-label="Close run a container" onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>

        <label>
          <span>Image</span>
          <input
            data-testid="create-container-image"
            value={image}
            onChange={(event) => setImage(event.currentTarget.value)}
            placeholder="nginx:1.27"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        <label>
          <span>Name</span>
          <input
            data-testid="create-container-name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Optional — Docker generates one"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Ports</span>
          <textarea
            data-testid="create-container-ports"
            value={ports}
            onChange={(event) => setPorts(event.currentTarget.value)}
            placeholder={"8080:80\n5432:5432/tcp"}
            rows={2}
            spellCheck={false}
          />
        </label>
        <label>
          <span>Environment</span>
          <textarea
            data-testid="create-container-env"
            value={env}
            onChange={(event) => setEnv(event.currentTarget.value)}
            placeholder={"TZ=Europe/London\nLOG_LEVEL=debug"}
            rows={2}
            spellCheck={false}
          />
        </label>
        <label>
          <span>Volumes</span>
          <textarea
            data-testid="create-container-binds"
            value={binds}
            onChange={(event) => setBinds(event.currentTarget.value)}
            placeholder="/srv/site:/usr/share/nginx/html:ro"
            rows={2}
            spellCheck={false}
          />
        </label>
        <label>
          <span>Command</span>
          <input
            data-testid="create-container-command"
            value={command}
            onChange={(event) => setCommand(event.currentTarget.value)}
            placeholder="Optional — overrides the image default"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Restart policy</span>
          <select
            data-testid="create-container-restart"
            value={restartPolicy}
            onChange={(event) =>
              setRestartPolicy(
                event.currentTarget.value as ContainerCreateOptions["restartPolicy"],
              )
            }
          >
            <option value="no">No</option>
            <option value="on-failure">On failure</option>
            <option value="unless-stopped">Unless stopped</option>
            <option value="always">Always</option>
          </select>
        </label>
        <label className="prune-option">
          <input
            type="checkbox"
            data-testid="create-container-start"
            checked={start}
            onChange={(event) => setStart(event.currentTarget.checked)}
          />
          <span>Start immediately</span>
        </label>

        {problem && (
          <p className="capability-error" role="alert" data-testid="create-container-problem">
            {problem}
          </p>
        )}

        <div className="create-environment-dialog__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            data-testid="create-container-confirm"
            disabled={!image.trim() || pending}
          >
            {pending ? "Creating…" : start ? "Run" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
