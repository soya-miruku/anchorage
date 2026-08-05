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
  Bot,
  Box,
  Brain,
  ChevronLeft,
  Cloud,
  Layers,
  Copy,
  Cylinder,
  Diamond,
  KeyRound,
  LayoutGrid,
  MessagesSquare,
  Moon,
  RotateCw,
  Scale,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Ship,
  Sun,
  Wrench,
  Rows3,
  Share2,
  Search,
  Trash,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

export type AnchorageIconName =
  | "agents"
  | "back"
  | "bosun"
  | "builds"
  | "cloud"
  | "compose"
  | "containers"
  | "dashboard"
  | "delete"
  | "dev-environments"
  | "empty"
  | "extensions"
  | "governance"
  | "hardened"
  | "images"
  | "kubernetes"
  | "logs"
  | "mode-dark"
  | "mode-light"
  | "networks"
  | "more"
  | "pause"
  | "pause-freeze"
  | "play"
  | "rating"
  | "models"
  | "restart"
  | "sandboxes"
  | "scan"
  | "search"
  | "secrets"
  | "settings"
  | "close"
  | "tools"
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
  "mode-dark": {
    component: Moon,
    family: "lucide",
    libraryName: "Moon",
    strokeWidth: 1.8,
  },
  "mode-light": {
    component: Sun,
    family: "lucide",
    libraryName: "Sun",
    strokeWidth: 1.8,
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
    // Filled, not outlined. At the 12px the row cluster uses, a `regular` circle plus two
    // hairline bars merged into a smudge. The fill knocks the bars out as negative space,
    // which survives the size — and the circle is what keeps Pause distinct from Stop, so
    // dropping it and using the bare pause glyph would reinstate two identical-looking
    // controls.
    component: PauseCircleIcon,
    family: "phosphor",
    libraryName: "PauseCircle",
    weight: "fill",
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
  // v2.5 turns the titlebar gear into a toggle, so it needs a close glyph for the state where
  // pressing it leaves Settings rather than entering them.
  close: {
    component: X,
    family: "lucide",
    libraryName: "X",
    strokeWidth: 2,
  },
  settings: {
    component: RadioButtonIcon,
    family: "phosphor",
    libraryName: "RadioButton",
    weight: "bold",
  },
  "agents": {
    component: Bot,
    family: "lucide",
    libraryName: "Bot",
    strokeWidth: 1.9,
  },
  "bosun": {
    component: MessagesSquare,
    family: "lucide",
    libraryName: "MessagesSquare",
    strokeWidth: 1.9,
  },
  "cloud": {
    component: Cloud,
    family: "lucide",
    libraryName: "Cloud",
    strokeWidth: 1.9,
  },
  "governance": {
    component: Scale,
    family: "lucide",
    libraryName: "Scale",
    strokeWidth: 1.9,
  },
  "hardened": {
    component: ShieldCheck,
    family: "lucide",
    libraryName: "ShieldCheck",
    strokeWidth: 1.9,
  },
  "kubernetes": {
    component: Ship,
    family: "lucide",
    libraryName: "Ship",
    strokeWidth: 1.9,
  },
  "logs": {
    component: ScrollText,
    family: "lucide",
    libraryName: "ScrollText",
    strokeWidth: 1.9,
  },
  "models": {
    component: Brain,
    family: "lucide",
    libraryName: "Brain",
    strokeWidth: 1.9,
  },
  "sandboxes": {
    component: Box,
    family: "lucide",
    libraryName: "Box",
    strokeWidth: 1.9,
  },
  "scan": {
    component: ScanSearch,
    family: "lucide",
    libraryName: "ScanSearch",
    strokeWidth: 1.9,
  },
  "secrets": {
    component: KeyRound,
    family: "lucide",
    libraryName: "KeyRound",
    strokeWidth: 1.9,
  },
  "tools": {
    component: Wrench,
    family: "lucide",
    libraryName: "Wrench",
    strokeWidth: 1.9,
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
