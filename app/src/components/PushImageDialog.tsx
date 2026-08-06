import { XIcon } from "@phosphor-icons/react";

import type { AnchorageImage } from "../types";
import { registryHostForReference } from "../utils/registry";

/**
 * Confirms publishing an image.
 *
 * Push is the only verb here that sends something outward. Its destination is not chosen —
 * it is derived from the reference — so an operator who mistypes a tag can publish to a
 * registry they never intended, which is a disclosure rather than a failed command. The
 * dialog therefore leads with the destination host rather than restating the tag.
 *
 * No credential appears anywhere in this flow. The Docker CLI resolves authentication from
 * the operator's own configuration and credential helpers, so nothing secret enters the
 * renderer, crosses the IPC boundary, or is stored by Anchorage. If the registry has not
 * been authenticated, Docker says so in its own output and the progress panel points at
 * `docker login` rather than offering a password field.
 */
export function PushImageDialog({
  image,
  busy,
  onCancel,
  onConfirm,
}: {
  image: AnchorageImage;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reference: string, registry: string) => void;
}) {
  const reference = image.reference ?? "";
  const registry = registryHostForReference(reference);
  const isPublicHub = registry === "docker.io";

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-image-title"
        data-testid="push-image-dialog"
      >
        <div className="dialog-panel__heading">
          <div>
            <h2 id="push-image-title">Publish to {registry}</h2>
            <p>
              This uploads the image to a remote registry. It cannot be undone from
              here.
            </p>
          </div>
          <button type="button" aria-label="Close publish image" onClick={onCancel}>
            <XIcon aria-hidden="true" size={15} />
          </button>
        </div>

        <dl className="push-summary" data-testid="push-summary">
          <dt>Reference</dt>
          <dd className="resource-mono">{reference}</dd>
          <dt>Destination</dt>
          <dd className="resource-mono">{registry}</dd>
        </dl>

        {isPublicHub && (
          <p className="capability-error" role="status" data-testid="push-public-warning">
            This reference has no registry host, so it resolves to Docker Hub. A
            repository there is public unless you have made it private.
          </p>
        )}

        <p className="resource-dim push-credentials-note">
          Anchorage never handles registry credentials. Docker resolves them from
          your own configuration; if this registry is not signed in, the push will
          say so and you can run <code>docker login {registry}</code>.
        </p>

        <div className="dialog-panel__actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            data-testid="push-image-confirm"
            disabled={!reference || busy}
            onClick={() => onConfirm(reference, registry)}
          >
            Publish
          </button>
        </div>
      </div>
    </div>
  );
}
