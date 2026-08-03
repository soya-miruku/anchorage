import {
  AppWindowIcon,
  DotsThreeIcon,
  PauseCircleIcon,
  PauseIcon,
  PlayIcon,
  RadioButtonIcon,
  SquareIcon,
  StarIcon,
  type Icon,
  type IconWeight,
} from "@phosphor-icons/react";
import {
  Blocks,
  ChevronLeft,
  Layers,
  Copy,
  Cylinder,
  Diamond,
  LayoutGrid,
  RotateCw,
  Rows3,
  Share2,
  Search,
  Trash,
  type LucideIcon,
} from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

export type AnchorageIconName =
  | "back"
  | "builds"
  | "compose"
  | "containers"
  | "dashboard"
  | "delete"
  | "dev-environments"
  | "empty"
  | "extensions"
  | "images"
  | "networks"
  | "more"
  | "pause"
  | "pause-freeze"
  | "play"
  | "rating"
  | "restart"
  | "search"
  | "settings"
  | "volumes";

interface PhosphorIconDefinition {
  component: Icon;
  family: "phosphor";
  libraryName: string;
  weight: IconWeight;
}

interface LucideIconDefinition {
  component: LucideIcon;
  family: "lucide";
  libraryName: string;
  rotation?: 90;
  strokeWidth: number;
}

type AnchorageIconDefinition =
  | LucideIconDefinition
  | PhosphorIconDefinition;

const iconDefinitions: Record<
  AnchorageIconName,
  AnchorageIconDefinition
> = {
  back: {
    component: ChevronLeft,
    family: "lucide",
    libraryName: "ChevronLeft",
    strokeWidth: 2.4,
  },
  builds: {
    component: Diamond,
    family: "lucide",
    libraryName: "Diamond",
    strokeWidth: 2.1,
  },
  compose: {
    component: Layers,
    family: "lucide",
    libraryName: "Layers",
    strokeWidth: 1.6,
  },
  containers: {
    component: Rows3,
    family: "lucide",
    libraryName: "Rows3",
    strokeWidth: 2.1,
  },
  dashboard: {
    component: LayoutGrid,
    family: "lucide",
    libraryName: "LayoutGrid",
    strokeWidth: 2.1,
  },
  delete: {
    component: Trash,
    family: "lucide",
    libraryName: "Trash",
    strokeWidth: 2.1,
  },
  "dev-environments": {
    component: AppWindowIcon,
    family: "phosphor",
    libraryName: "AppWindow",
    weight: "bold",
  },
  empty: {
    component: SquareIcon,
    family: "phosphor",
    libraryName: "Square",
    weight: "fill",
  },
  extensions: {
    component: Blocks,
    family: "lucide",
    libraryName: "Blocks",
    rotation: 90,
    strokeWidth: 2.1,
  },
  images: {
    component: Copy,
    family: "lucide",
    libraryName: "Copy",
    strokeWidth: 2.1,
  },
  networks: {
    component: Share2,
    family: "lucide",
    libraryName: "Share2",
    strokeWidth: 2.1,
  },
  more: {
    component: DotsThreeIcon,
    family: "phosphor",
    libraryName: "DotsThree",
    weight: "bold",
  },
  pause: {
    component: PauseIcon,
    family: "phosphor",
    libraryName: "Pause",
    weight: "fill",
  },
  // Distinct from `pause` on purpose. The handoff uses the bare bars for the primary
  // Stop control, so the separate Pause action needed its own glyph — two adjacent
  // buttons carrying the same shape, told apart only by colour, are not a control pair.
  "pause-freeze": {
    component: PauseCircleIcon,
    family: "phosphor",
    libraryName: "PauseCircle",
    weight: "regular",
  },
  play: {
    component: PlayIcon,
    family: "phosphor",
    libraryName: "Play",
    weight: "fill",
  },
  rating: {
    component: StarIcon,
    family: "phosphor",
    libraryName: "Star",
    weight: "fill",
  },
  restart: {
    component: RotateCw,
    family: "lucide",
    libraryName: "RotateCw",
    strokeWidth: 2.25,
  },
  search: {
    component: Search,
    family: "lucide",
    libraryName: "Search",
    strokeWidth: 2.4,
  },
  settings: {
    component: RadioButtonIcon,
    family: "phosphor",
    libraryName: "RadioButton",
    weight: "bold",
  },
  volumes: {
    component: Cylinder,
    family: "lucide",
    libraryName: "Cylinder",
    strokeWidth: 2.1,
  },
};

type AnchorageIconProps = Omit<
  ComponentPropsWithoutRef<"svg">,
  "aria-hidden" | "focusable" | "role" | "strokeWidth"
> & {
  name: AnchorageIconName;
  size?: number | string;
};

export function AnchorageIcon({
  name,
  ...props
}: AnchorageIconProps) {
  const definition = iconDefinitions[name];
  const commonProps = {
    "aria-hidden": "true",
    "data-anchorage-icon": name,
    "data-icon-family": definition.family,
    "data-icon-library-name": definition.libraryName,
    focusable: "false",
  } as const;

  if (definition.family === "lucide") {
    const IconComponent = definition.component;
    return (
      <IconComponent
        {...commonProps}
        data-icon-rotation={definition.rotation}
        data-icon-stroke-width={definition.strokeWidth}
        strokeWidth={definition.strokeWidth}
        {...props}
        style={
          definition.rotation
            ? {
                ...props.style,
                transform: `rotate(${definition.rotation}deg)`,
              }
            : props.style
        }
      />
    );
  }

  const IconComponent = definition.component;
  return (
    <IconComponent
      {...commonProps}
      data-icon-weight={definition.weight}
      weight={definition.weight}
      {...props}
    />
  );
}
