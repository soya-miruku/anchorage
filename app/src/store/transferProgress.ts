/**
 * How far a streaming transfer has got, read out of Docker's own output.
 *
 * `docker model pull` writes a running total and nothing else machine-readable — no percentage,
 * no JSON, no `--format`. What it does write is exact:
 *
 *     Downloaded 7.71kB of 2.02GB
 *     Downloaded 223.94MB of 270.60MB
 *
 * That is a real measurement rather than an animation, which is the whole point: a bar that
 * moves on a timer is a lie about progress, and a 2GB model behind an indeterminate spinner is
 * indistinguishable from a stalled one. Where Docker does not say, this returns null and the
 * caller shows no bar at all.
 *
 * Only the last occurrence counts. The output accumulates, so an early "7.71kB of 2.02GB" is
 * still in the buffer when the transfer is nearly done.
 */

export type TransferProgress = {
  doneBytes: number;
  totalBytes: number;
  /** 0-1, clamped. Separate from the byte counts so a caller need not repeat the divide. */
  fraction: number;
};

/**
 * Docker's units are decimal, not binary — 270.60MB for a model `docker model ls` then reports
 * as 258MiB. Following its arithmetic rather than correcting it keeps the bar consistent with
 * the line of text directly above it, which is what someone reads to check the bar.
 */
const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
};

const PROGRESS_LINE =
  /Downloaded\s+([\d.]+)\s*(B|kB|MB|GB|TB)\s+of\s+([\d.]+)\s*(B|kB|MB|GB|TB)/giu;

function toBytes(amount: string, unit: string): number {
  const scale = UNIT_BYTES[unit.toLowerCase()];
  const value = Number.parseFloat(amount);
  if (!scale || !Number.isFinite(value)) return Number.NaN;
  return value * scale;
}

export function parseTransferProgress(output: string): TransferProgress | null {
  let last: RegExpExecArray | null = null;
  // `matchAll` would allocate every match in a buffer that reaches 64KB; only the last is used.
  PROGRESS_LINE.lastIndex = 0;
  for (
    let match = PROGRESS_LINE.exec(output);
    match !== null;
    match = PROGRESS_LINE.exec(output)
  ) {
    last = match;
  }
  if (!last) return null;

  const doneBytes = toBytes(last[1], last[2]);
  const totalBytes = toBytes(last[3], last[4]);
  if (!Number.isFinite(doneBytes) || !Number.isFinite(totalBytes)) return null;
  // `Downloaded 0.00B of 0.00B` is what a no-op pull prints. A bar at 0/0 would render either
  // as empty forever or, with a naive divide, as NaN width — neither is a fact about anything.
  if (totalBytes <= 0) return null;

  return {
    doneBytes,
    totalBytes,
    // Docker overshoots: a Hugging Face pull printed "Downloaded 545.01MB of 272.50MB" because
    // the total is the model size and the download includes what it discards. Clamped, because
    // a bar wider than its track is worse than one that sits at full for the last few seconds.
    fraction: Math.min(1, Math.max(0, doneBytes / totalBytes)),
  };
}
