/**
 * Byte counts as Docker reports them: base 1024, one decimal below 10 units.
 *
 * Two byte-identical copies of this lived in DashboardScreen and SystemPruneDialog, and the
 * images prune result needed a third. One copy is the only way the three places that report
 * reclaimed space agree on what a gigabyte is.
 */
export const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};
