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
  ChevronRight,
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
  | "builds"
  | "compose"
  | "containers"
  | "dashboard"
  | "delete"
  | "disclose"
  | "empty"
  | "images"
  | "logs"
  | "mode-dark"
  | "mode-light"
  | "networks"
  | "more"
  | "pause"
  | "pause-freeze"
  | "play"
  | "models"
  | "restart"
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

// There was a `rotation?: 90` here, carried by exactly one glyph: the Extensions tile, whose
// library orientation did not match the handoff's. That destination is gone, and with it the
// only reason any icon needed reorienting — so the field, the data attribute and the transform
// went too rather than waiting for a second user that may never arrive.
interface LucideIconDefinition {
  component: LucideIcon;
  family: "lucide";
  libraryName: string;
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
  disclose: {
    component: ChevronRight,
    family: "lucide",
    libraryName: "ChevronRight",
    strokeWidth: 2.4,
  },
  empty: {
    component: SquareIcon,
    family: "phosphor",
    libraryName: "Square",
    weight: "fill",
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

/**
 * Every glyph the set defines, at runtime.
 *
 * `AnchorageIconName` says the same thing to the compiler, but `npm test` does not typecheck —
 * `typecheck:renderer` is a separate script nobody's gate runs — so a type-level claim about
 * this set is a claim nothing checks. This lets a test assert membership for real, which is how
 * the icons belonging to removed destinations are kept from drifting back in.
 */
export const anchorageIconNames = Object.keys(
  iconDefinitions,
) as AnchorageIconName[];

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
        data-icon-stroke-width={definition.strokeWidth}
        strokeWidth={definition.strokeWidth}
        {...props}
        style={props.style}
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
