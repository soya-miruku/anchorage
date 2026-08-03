import {
  CubeIcon,
  DatabaseIcon,
  DiamondIcon,
  GearIcon,
  ImagesIcon,
  PuzzlePieceIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ViewId } from "../types";

const viewMeta: Record<
  Exclude<ViewId, "containers">,
  { title: string; subtitle: string; icon: Icon }
> = {
  dashboard: {
    title: "Overview",
    subtitle: "Local engine · linux/amd64 · 8 CPUs · 16 GB allocated",
    icon: SquaresFourIcon,
  },
  images: {
    title: "Images",
    subtitle: "8 images · 2.55 GB total · 890 MB reclaimable",
    icon: ImagesIcon,
  },
  volumes: {
    title: "Volumes",
    subtitle: "5 volumes · 18.5 GB · 1 unused",
    icon: DatabaseIcon,
  },
  compose: {
    title: "Compose",
    subtitle: "Multi-container projects defined by a Compose file",
    icon: DiamondIcon,
  },
  networks: {
    title: "Networks",
    subtitle: "Bridge, host and user-defined networks",
    icon: DatabaseIcon,
  },
  builds: {
    title: "Builds",
    subtitle: "6 builds today · 4 succeeded · avg 1m 02s",
    icon: DiamondIcon,
  },
  devenv: {
    title: "Dev Environments",
    subtitle: "Reproducible workspaces built from a repo and a devcontainer spec.",
    icon: TerminalWindowIcon,
  },
  extensions: {
    title: "Extensions",
    subtitle: "2 installed · 6 available in the marketplace",
    icon: PuzzlePieceIcon,
  },
  settings: {
    title: "Settings",
    subtitle: "Engine resources, updates and advanced runtime behaviour.",
    icon: GearIcon,
  },
};

export function PlaceholderScreen({
  view,
}: {
  view: Exclude<ViewId, "containers">;
}) {
  const meta = viewMeta[view];
  const IconComponent = meta.icon ?? CubeIcon;

  return (
    <section
      className="placeholder-screen screen"
      data-testid={`${view}-screen`}
    >
      <header className="screen-header">
        <div>
          <h1>{meta.title}</h1>
          <p>{meta.subtitle}</p>
        </div>
      </header>
      <div className="placeholder-state">
        <span className="placeholder-state__icon">
          <IconComponent aria-hidden="true" size={24} weight="light" />
        </span>
        <strong>{meta.title}</strong>
        <p>This workspace is ready for its native engine projection.</p>
      </div>
    </section>
  );
}

