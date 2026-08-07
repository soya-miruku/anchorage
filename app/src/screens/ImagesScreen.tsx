import { SessionActivityPanel } from "../components/SessionActivityPanel";
import { XIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { AnchorageIcon } from "../components/AnchorageIcon";
import { ArchivePathDialog } from "../components/ArchivePathDialog";
import { DeleteImageDialog } from "../components/DeleteImageDialog";
import { ImageDetailPanel } from "../components/ImageDetailPanel";
import { PushImageDialog } from "../components/PushImageDialog";
import { SortableHeader } from "../components/SortableHeader";
import { TagImageDialog } from "../components/TagImageDialog";
import { FixedRowWindow } from "../components/FixedRowWindow";
import type { AnchorageStore } from "../store/useAnchorageStore";
import type { AnchorageImage } from "../types";
import { useTableSort, type ColumnSort } from "../utils/tableSort";
import {
  looksUnauthenticated,
  registryHostForReference,
} from "../utils/registry";
import { formatBytes } from "../utils/bytes";

const IMAGE_COLUMNS: ReadonlyArray<
  ColumnSort<AnchorageImage, "repository" | "tag" | "created" | "size" | "usage">
> = [
  { key: "repository", label: "Repository", kind: "text", value: (row) => row.repository },
  { key: "tag", label: "Tag", kind: "text", value: (row) => row.tag },
  { key: "created", label: "Created", kind: "text", value: (row) => row.created },
  // Sort on the numeric size, not the formatted string, so 2 GB outranks 900 MB.
  { key: "size", label: "Size", kind: "number", value: (row) => row.sizeMb },
  {
    key: "usage",
    label: "In use",
    kind: "text",
    // Unknown usage is genuinely distinct from unused and must not collapse into it.
    value: (row) => (!row.usageKnown ? "unknown" : row.inUse ? "in use" : "unused"),
  },
];

function LocalImages({
  store,
  onRequestRemove,
}: {
  store: AnchorageStore;
  onRequestRemove: (image: AnchorageImage) => void;
}) {
  const { sorted: rows, headerProps } = useTableSort(
    store.filteredImages,
    IMAGE_COLUMNS,
  );
  // Two boxes narrow this table — the in-screen filter and the titlebar search. The in-screen
  // one is the nearer of the two, so it is what gets quoted back when both are set.
  const filterQuery = store.imageQuery.trim() || store.search.trim();
  return (
    <div
      className="images-local"
      id="images-local-panel"
      role="tabpanel"
      aria-labelledby="images-local-tab"
    >
      <div className="images-table__head">
        <SortableHeader label="Repository" ariaSort={headerProps("repository")["aria-sort"]} onClick={headerProps("repository").onClick} />
        <SortableHeader label="Tag" ariaSort={headerProps("tag")["aria-sort"]} onClick={headerProps("tag").onClick} />
        {/* Deliberately not sortable: a digest has no ordering a reader would act on, and
            offering one would imply the column means something it does not. */}
        <span>IMAGE ID</span>
        <SortableHeader label="Created" ariaSort={headerProps("created")["aria-sort"]} onClick={headerProps("created").onClick} />
        <SortableHeader label="Size" ariaSort={headerProps("size")["aria-sort"]} onClick={headerProps("size").onClick} />
        {/* The usage cell is right-aligned, so its header has to be too. text-align cannot do
            that any more now the header is a flex container. */}
        <SortableHeader label="In use" align="end" ariaSort={headerProps("usage")["aria-sort"]} onClick={headerProps("usage").onClick} />
      </div>
      {rows.length === 0 ? (
        <div className="images-table__body" data-testid="images-table-body">
          <div className="empty-state" data-testid="images-empty-state">
            <span className="empty-state__icon" aria-hidden="true">
              <AnchorageIcon
                className="empty-state__glyph"
                name="empty"
                size={19}
              />
            </span>
            {filterQuery ? (
              <>
                <strong>No images match “{filterQuery}”</strong>
                <p>
                  Clear the search and filters, or pull the image from a
                  registry.
                </p>
              </>
            ) : (
              <>
                <strong>No images yet</strong>
                <p>Pull one from a registry, or build one from a Dockerfile.</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <FixedRowWindow
          className="images-table__body"
          testId="images-table-body"
          items={rows}
          rowHeight={52}
          keyFor={(image) => image.identity}
          renderRow={(image) => (
            <div
              className="image-row image-row--clickable"
              data-testid={`image-${image.id}`}
              data-image-identity={image.identity}
              role="button"
              tabIndex={0}
              aria-label={`Open ${image.repository}:${image.tag}`}
              onClick={() => void store.openImageDetail(image)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void store.openImageDetail(image);
                }
              }}
            >
              <span
                className={
                  image.repository === "<none>" ? "image-row__dangling" : ""
                }
              >
                {image.repository}
              </span>
              <span className="resource-mono resource-secondary">{image.tag}</span>
              <span className="resource-mono resource-dim">{image.id}</span>
              <span className="resource-muted">{image.created}</span>
              <span className="resource-mono resource-secondary">{image.size}</span>
              <span className="image-row__usage">
                <span
                  className={`usage-pill${
                    image.inUse ? " usage-pill--active" : ""
                  }`}
                >
                  {!image.usageKnown
                    ? "Unknown"
                    : image.inUse
                      ? "In use"
                      : "Unused"}
                </span>
                {store.isHost && (
                  <button
                    className="image-row__remove"
                    type="button"
                    aria-label={`Remove ${image.repository}:${image.tag}`}
                    // A missing reference no longer disables this: dangling images are removed
                    // by immutable ID. In-use images are removable with --force, confirmed in
                    // the dialog rather than silently escalated here.
                    title={
                      !image.usageKnown
                        ? "Usage is unknown, so removal is unsafe"
                        : image.inUse
                          ? "In use — removing requires force"
                          : "Remove"
                    }
                    disabled={!image.usageKnown || store.imageMutationPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRequestRemove(image);
                    }}
                  >
                    <AnchorageIcon name="delete" size={12} />
                  </button>
                )}
              </span>
            </div>
          )}
        />
      )}
    </div>
  );
}

function RegistrySearch({ store }: { store: AnchorageStore }) {
  if (store.isHost) {
    const reference = store.registryQuery.trim();
    // Scoped to image sessions: a Compose action shares this slot and must not disable Pull.
    const running =
      store.imageTransfer?.kind === "image" &&
      (store.imageTransfer.status === "starting" ||
        store.imageTransfer.status === "running");
    return (
      <div
        className="registry-panel"
        id="images-registry-panel"
        role="tabpanel"
        aria-labelledby="images-registry-tab"
      >
        <div className="host-pull-panel">
          <div>
            <h2>Registry</h2>
            <p>
              Search Docker Hub, or enter a literal reference to pull. Anchorage
              passes it to the selected Docker context without shell interpolation.
            </p>
          </div>
          <label className="registry-search host-pull-panel__search">
            <span className="sr-only">Image reference</span>
            <AnchorageIcon name="search" size={13} />
            <input
              data-testid="registry-search"
              value={store.registryQuery}
              onChange={(event) =>
                store.setRegistryQuery(event.currentTarget.value)
              }
              placeholder="registry.example.com/team/image:tag"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="host-pull-panel__actions">
            <button
              className="ghost-button"
              type="button"
              data-testid="registry-search-run"
              disabled={!reference || store.registrySearching}
              onClick={() => void store.searchRegistry(reference)}
            >
              {store.registrySearching ? "Searching…" : "Search"}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!reference || running}
              onClick={() => void store.pullRegistryImage(reference)}
            >
              {running ? "Pulling…" : "Pull image"}
            </button>
          </div>
        </div>

        {store.registryHits.length > 0 && (
          <div className="registry-results" data-testid="registry-results">
            {store.registryHits.map((hit) => (
              <article className="registry-card" key={hit.name}>
                <div className="registry-card__content">
                  <div className="registry-card__title">
                    <h2>{hit.name}</h2>
                    {hit.official && <span>OFFICIAL</span>}
                  </div>
                  <p>{hit.description || "No description provided."}</p>
                  <div className="registry-card__metrics">
                    ★ {hit.stars.toLocaleString()}
                  </div>
                </div>
                <button
                  className="registry-pull"
                  type="button"
                  disabled={running}
                  onClick={() => void store.pullRegistryImage(hit.name)}
                >
                  Pull
                </button>
              </article>
            ))}
          </div>
        )}
        {/* Image sessions only; Compose actions share this slot and render on their own screen. */}
        {store.imageTransfer?.kind === "image" && (
          <SessionActivityPanel
            session={store.imageTransfer}
            testId="image-transfer-output"
            // Docker writes nothing at all while an archive streams, so an empty pane is the
            // normal state for save and export rather than a sign of a stall.
            runningMessage="Working — Docker reports nothing until the transfer finishes."
            idleMessage="Waiting for Docker…"
          >
            {/* Docker reports an unauthenticated registry in its own words. Rather than offer a
                password field, point at the command that owns the credential. */}
            {store.imageTransfer.title === "Push" &&
              looksUnauthenticated(store.imageTransfer.output) && (
                <p className="capability-error" data-testid="push-auth-hint">
                  That registry is not signed in. Run{" "}
                  <code>
                    docker login{" "}
                    {registryHostForReference(
                      store.imageTransfer.reference.split(" → ")[0],
                    )}
                  </code>{" "}
                  in a terminal, then try again.
                </p>
              )}
          </SessionActivityPanel>
        )}
      </div>
    );
  }

  return (
    <div
      className="registry-panel"
      id="images-registry-panel"
      role="tabpanel"
      aria-labelledby="images-registry-tab"
    >
      <label className="registry-search">
        <span className="sr-only">Search the registry</span>
        <AnchorageIcon name="search" size={13} />
        <input
          data-testid="registry-search"
          value={store.registryQuery}
          onChange={(event) =>
            store.setRegistryQuery(event.currentTarget.value)
          }
          placeholder="Search the registry…"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {store.registryResults.length > 0 ? (
        <div className="registry-results">
          {store.registryResults.map((image) => {
            const pulled = store.pulledRegistryImages.has(image.name);
            return (
              <article className="registry-card" key={image.name}>
                <span
                  className="registry-card__mark"
                  aria-hidden="true"
                >
                  {image.name.charAt(0).toLocaleUpperCase()}
                </span>
                <div className="registry-card__content">
                  <div className="registry-card__title">
                    <h2>{image.name}</h2>
                    {image.official && <span>OFFICIAL</span>}
                  </div>
                  <p>{image.description}</p>
                  <div className="registry-card__metrics">
                    ★ {image.stars} · {image.pulls} pulls · updated {image.updated}
                  </div>
                </div>
                <button
                  className={`registry-pull${pulled ? " registry-pull--done" : ""}`}
                  type="button"
                  disabled={pulled}
                  onClick={() => store.pullRegistryImage(image.name)}
                >
                  {pulled ? "Pulled" : "Pull"}
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="registry-empty" data-testid="registry-empty">
          <strong>No results for “{store.registryQuery}”</strong>
          <p>
            Check the spelling or search for a namespace like{" "}
            <span>bitnami/</span>.
          </p>
        </div>
      )}
    </div>
  );
}

export function ImagesScreen({ store }: { store: AnchorageStore }) {
  const [pendingRemove, setPendingRemove] = useState<AnchorageImage | null>(null);
  const [cleanUpOpen, setCleanUpOpen] = useState(false);
  const [cleanUpScope, setCleanUpScope] = useState<"dangling" | "all">(
    "dangling",
  );
  const [loadOpen, setLoadOpen] = useState(false);
  const [saveTarget, setSaveTarget] = useState<AnchorageImage | null>(null);
  const [tagTarget, setTagTarget] = useState<AnchorageImage | null>(null);
  const [pushTarget, setPushTarget] = useState<AnchorageImage | null>(null);
  // Transfers share one progress panel and one session slot, so starting a second would
  // cancel the first. The controls are disabled rather than silently doing that.
  const transferRunning =
    store.imageTransfer?.status === "starting" ||
    store.imageTransfer?.status === "running";

  const uniqueImages = useMemo(
    () => [...new Map(store.images.map((i) => [i.imageId, i])).values()],
    [store.images],
  );
  const danglingTargets = useMemo(
    () =>
      uniqueImages.filter(
        (image) => image.reference === null && image.usageKnown && image.reclaimable,
      ),
    [uniqueImages],
  );
  const unusedTargets = useMemo(
    () => uniqueImages.filter((image) => image.usageKnown && image.reclaimable),
    [uniqueImages],
  );
  const cleanUpTargets =
    cleanUpScope === "all" ? unusedTargets : danglingTargets;
  const reclaimMb = cleanUpTargets.reduce((total, i) => total + i.sizeMb, 0);

  const canCleanUp = store.isHost
    ? store.hostDomainState.images.status === "ready" && unusedTargets.length > 0
    : store.images.some((image) => image.reclaimable);

  return (
    <section className="resource-screen screen" data-testid="images-screen">
      <header className="resource-header">
        <div>
          <h1>Images</h1>
          <p>
            {store.imageSummary}
            {store.isHost &&
              store.hostDomainState.images.status === "loading" &&
              " · refreshing live images…"}
          </p>
          {store.isHost && store.hostDomainState.images.status === "error" && (
            <p className="capability-error" role="status">
              Live images unavailable: {store.hostDomainState.images.error}
            </p>
          )}
        </div>
        <div className="screen-header__actions">
          {store.isHost && (
            <button
              className="ghost-button"
              type="button"
              data-testid="images-load-archive"
              disabled={transferRunning}
              onClick={() => setLoadOpen(true)}
            >
              Load archive
            </button>
          )}
          <button
            className="ghost-button"
            type="button"
            disabled={!canCleanUp || store.imageMutationPending}
            onClick={() => {
              setCleanUpScope(danglingTargets.length > 0 ? "dangling" : "all");
              setCleanUpOpen(true);
            }}
          >
            Clean up
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => store.setImageTab("registry")}
          >
            Pull image
          </button>
        </div>
      </header>

      {store.imagePruneResult && (
        <div
          className="prune-result"
          role="status"
          aria-live="polite"
          data-testid="image-prune-result"
        >
          <div>
            <strong>
              Reclaimed {formatBytes(store.imagePruneResult.spaceReclaimedBytes)}
            </strong>
            <ul>
              <li>
                {store.imagePruneResult.removed} image
                {store.imagePruneResult.removed === 1 ? "" : "s"} removed
                {store.imagePruneResult.untagged > 0 &&
                  `, ${store.imagePruneResult.untagged} tag${
                    store.imagePruneResult.untagged === 1 ? "" : "s"
                  } dropped`}
              </li>
            </ul>
          </div>
          <button
            className="ghost-button"
            type="button"
            onClick={store.dismissImagePruneResult}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="resource-tabs" role="tablist" aria-label="Images">
        <button
          id="images-local-tab"
          className={store.imageTab === "local" ? "resource-tab--active" : ""}
          type="button"
          role="tab"
          aria-selected={store.imageTab === "local"}
          aria-controls="images-local-panel"
          onClick={() => store.setImageTab("local")}
        >
          Local
        </button>
        <button
          id="images-registry-tab"
          className={store.imageTab === "registry" ? "resource-tab--active" : ""}
          type="button"
          role="tab"
          aria-selected={store.imageTab === "registry"}
          aria-controls="images-registry-panel"
          onClick={() => store.setImageTab("registry")}
        >
          Registry search
        </button>
      </div>

      {store.imageTab === "local" ? (
        <>
          {store.isHost && (
            <div className="images-toolbar" data-testid="images-toolbar">
              <label className="registry-search images-toolbar__search">
                <span className="sr-only">Filter images</span>
                <AnchorageIcon name="search" size={13} />
                <input
                  data-testid="images-filter-query"
                  value={store.imageQuery}
                  onChange={(event) =>
                    store.setImageQuery(event.currentTarget.value)
                  }
                  placeholder="Filter by repository, tag or ID…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                className={`filter-button${
                  store.imageFilters.includeDangling ? " filter-button--active" : ""
                }`}
                data-testid="images-filter-dangling"
                type="button"
                aria-pressed={store.imageFilters.includeDangling}
                onClick={() =>
                  store.setImageFilters({
                    includeDangling: !store.imageFilters.includeDangling,
                  })
                }
              >
                <span aria-hidden="true" />
                Show untagged
              </button>
              <button
                className={`filter-button${
                  store.imageFilters.all ? " filter-button--active" : ""
                }`}
                data-testid="images-filter-all"
                type="button"
                aria-pressed={store.imageFilters.all}
                title="docker image ls --all: include intermediate layers"
                onClick={() => store.setImageFilters({ all: !store.imageFilters.all })}
              >
                <span aria-hidden="true" />
                Show all layers
              </button>
            </div>
          )}
          <LocalImages store={store} onRequestRemove={setPendingRemove} />
        </>
      ) : (
        <RegistrySearch store={store} />
      )}

      {cleanUpOpen && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="dialog-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clean-up-images-title"
            data-testid="clean-up-images-dialog"
          >
            <div className="dialog-panel__heading">
              <div>
                <h2 id="clean-up-images-title">Clean up images</h2>
                <p>Removed image layers cannot be recovered.</p>
              </div>
              <button
                type="button"
                aria-label="Close clean up images"
                onClick={() => setCleanUpOpen(false)}
              >
                <XIcon aria-hidden="true" size={15} />
              </button>
            </div>

            <div className="clean-up-scope" role="radiogroup" aria-label="Clean up scope">
              <label className="prune-option">
                <input
                  type="radio"
                  name="clean-up-scope"
                  data-testid="clean-up-scope-dangling"
                  checked={cleanUpScope === "dangling"}
                  onChange={() => setCleanUpScope("dangling")}
                />
                <span>
                  Untagged only (<code>docker image prune</code>)
                  <small>
                    {danglingTargets.length} image
                    {danglingTargets.length === 1 ? "" : "s"} without a tag.
                  </small>
                </span>
              </label>
              <label className="prune-option">
                <input
                  type="radio"
                  name="clean-up-scope"
                  data-testid="clean-up-scope-all"
                  checked={cleanUpScope === "all"}
                  onChange={() => setCleanUpScope("all")}
                />
                <span>
                  All unused (<code>docker image prune --all</code>)
                  <small>
                    {unusedTargets.length} image
                    {unusedTargets.length === 1 ? "" : "s"} no container is using,
                    including tagged ones you may want to keep.
                  </small>
                </span>
              </label>
            </div>

            <div className="prune-preview" data-testid="clean-up-preview">
              <p>
                Reclaims approximately{" "}
                <strong>
                  {reclaimMb >= 1024
                    ? `${(reclaimMb / 1024).toFixed(1)} GB`
                    : `${Math.round(reclaimMb)} MB`}
                </strong>{" "}
                across {cleanUpTargets.length} image
                {cleanUpTargets.length === 1 ? "" : "s"}.
              </p>
            </div>

            <div className="dialog-panel__actions">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setCleanUpOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button primary-button--danger"
                type="button"
                data-testid="clean-up-confirm"
                disabled={
                  cleanUpTargets.length === 0 || store.imageMutationPending
                }
                onClick={() => {
                  setCleanUpOpen(false);
                  void store.cleanUpImages(cleanUpScope);
                }}
              >
                Remove {cleanUpTargets.length}
              </button>
            </div>
          </div>
        </div>
      )}

      {store.selectedImage && (
        <ImageDetailPanel
          image={store.selectedImage}
          detail={store.imageDetail}
          error={store.imageDetailError}
          inspectable={store.isHost}
          onClose={store.closeImageDetail}
          // A dangling image has no reference to name on the command line, so it cannot be
          // saved by tag. Offering the control anyway would only produce a core rejection.
          onSave={
            store.isHost && !transferRunning && store.selectedImage.reference
              ? () => setSaveTarget(store.selectedImage)
              : undefined
          }
          // Tagging works on any image, dangling included — the source is the immutable ID,
          // so an image with no reference at all can still be given one.
          // Keyed the same way `analyzeImage` is called below. Looking results up by
          // reference alone lost them for a dangling image, which is stored under its
          // immutable ID: the scan ran, succeeded, and the drawer showed nothing.
          scout={
            store.scoutByReference[
              store.selectedImage.reference ?? store.selectedImage.imageId
            ] ?? null
          }
          scoutPending={
            store.scoutPending ===
            (store.selectedImage.reference ?? store.selectedImage.imageId)
          }
          scoutError={store.scoutError}
          // Scout takes a reference or an immutable ID, so a dangling image can be
          // analysed too — it is addressed by whichever it has.
          onAnalyze={
            store.isHost
              ? () =>
                  void store.analyzeImage(
                    store.selectedImage?.reference ?? store.selectedImage?.imageId ?? "",
                  )
              : undefined
          }
          // A dangling image has no reference to publish under, and push addresses an
          // image by reference rather than by ID.
          onPush={
            store.isHost && !transferRunning && store.selectedImage.reference
              ? () => setPushTarget(store.selectedImage)
              : undefined
          }
          onTag={
            store.isHost && !store.imageMutationPending
              ? () => setTagTarget(store.selectedImage)
              : undefined
          }
        />
      )}

      {saveTarget?.reference && (
        <ArchivePathDialog
          testId="save-image-dialog"
          title="Save image"
          description={`Writes ${saveTarget.reference} to a tar archive, layers and metadata intact. Load restores it on another machine.`}
          placeholder="/home/you/images/api.tar"
          confirmLabel="Save"
          allowOverwrite
          busy={transferRunning}
          onCancel={() => setSaveTarget(null)}
          onConfirm={(archivePath, overwrite) => {
            const reference = saveTarget.reference;
            setSaveTarget(null);
            if (reference) {
              store.setImageTab("registry");
              void store.saveImageArchive(reference, archivePath, overwrite);
            }
          }}
        />
      )}

      {loadOpen && (
        <ArchivePathDialog
          testId="load-image-dialog"
          title="Load archive"
          description="Reads images out of a tar produced by save. Existing tags with the same name are re-pointed."
          placeholder="/home/you/images/api.tar"
          confirmLabel="Load"
          busy={transferRunning}
          onCancel={() => setLoadOpen(false)}
          onConfirm={(archivePath) => {
            setLoadOpen(false);
            store.setImageTab("registry");
            void store.loadImageArchive(archivePath);
          }}
        />
      )}

      {pushTarget?.reference && (
        <PushImageDialog
          image={pushTarget}
          busy={transferRunning}
          onCancel={() => setPushTarget(null)}
          onConfirm={(reference, registry) => {
            setPushTarget(null);
            store.setImageTab("registry");
            void store.pushImage(reference, registry);
          }}
        />
      )}

      {tagTarget && (
        <TagImageDialog
          image={tagTarget}
          busy={store.imageMutationPending}
          onCancel={() => setTagTarget(null)}
          onConfirm={(reference) => {
            const target = tagTarget;
            setTagTarget(null);
            void store.tagImage(target, reference);
          }}
        />
      )}

      {pendingRemove && (
        <DeleteImageDialog
          image={pendingRemove}
          onCancel={() => setPendingRemove(null)}
          onConfirm={(options) => {
            const target = pendingRemove;
            setPendingRemove(null);
            void store.removeImage(target, options);
          }}
        />
      )}
    </section>
  );
}
