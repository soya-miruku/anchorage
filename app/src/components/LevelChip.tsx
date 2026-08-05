/**
 * The maturity level chip from the v2 handoff (Anchorage v2.dc.html:2744-2750, rendered
 * at :2441). Five levels, each a foreground/background token pair.
 *
 * This is the product's only level-chip primitive: the lifecycle drawer, per-control
 * `EXPERIMENTAL` markers and the titlebar not-GA count all read from the same five
 * levels, so a level added here is a level every surface understands.
 *
 * The colour pair is set by a modifier class rather than an inline style, so the token
 * layer stays the single place a hue is decided.
 */

export const MATURITY_LEVELS = [
  "ga",
  "early-access",
  "beta",
  "experimental",
  "deprecated",
] as const;

export type MaturityLevel = (typeof MATURITY_LEVELS)[number];

const LABELS: Record<MaturityLevel, string> = {
  ga: "GA",
  "early-access": "Early Access",
  beta: "Beta",
  experimental: "Experimental",
  deprecated: "Deprecated",
};

export function maturityLabel(level: MaturityLevel) {
  return LABELS[level];
}

export function isMaturityLevel(value: string): value is MaturityLevel {
  return (MATURITY_LEVELS as readonly string[]).includes(value);
}

export function LevelChip({
  level,
  describes,
}: {
  level: MaturityLevel;
  /** What carries this level, when the chip is not adjacent to its own label. */
  describes?: string;
}) {
  const label = LABELS[level];
  return (
    <span
      className={`level-chip level-chip--${level}`}
      aria-label={
        describes ? `${describes} maturity: ${label}` : `Maturity: ${label}`
      }
    >
      {label}
    </span>
  );
}
