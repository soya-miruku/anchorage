// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseTransferProgress } from "./transferProgress";

/**
 * The bar's only source of truth.
 *
 * `docker model pull` publishes no percentage, no JSON and no `--format`. It publishes
 * "Downloaded 223.94MB of 270.60MB", and every one of the strings below was taken from a real
 * pull on a real machine rather than invented. If this parse is wrong the bar is confidently
 * wrong, which is worse than the spinner it replaces.
 */
describe("parseTransferProgress", () => {
  it("reads the last figure, not the first", () => {
    // The output buffer accumulates, so an early line is still present at the end. A parser
    // that took the first match would pin a 2GB download at 0% for its entire life.
    const progress = parseTransferProgress(
      [
        "Downloaded 7.71kB of 2.02GB",
        "Downloaded 15.90kB of 2.02GB",
        "Downloaded 1.01GB of 2.02GB",
      ].join("\n"),
    );
    expect(progress?.doneBytes).toBe(1_010_000_000);
    expect(progress?.totalBytes).toBe(2_020_000_000);
    expect(progress?.fraction).toBeCloseTo(0.5, 3);
  });

  it("handles every unit Docker prints", () => {
    expect(parseTransferProgress("Downloaded 500B of 1kB")?.fraction).toBeCloseTo(0.5, 3);
    expect(parseTransferProgress("Downloaded 113.65MB of 270.60MB")?.fraction).toBeCloseTo(
      0.42,
      2,
    );
    expect(parseTransferProgress("Downloaded 1.00GB of 4.00GB")?.fraction).toBeCloseTo(0.25, 3);
  });

  it("says nothing when Docker has said nothing", () => {
    // The caller renders no bar at all in this case. An indeterminate bar and a stalled
    // download look identical, and the difference matters most on the largest files.
    expect(parseTransferProgress("")).toBeNull();
    expect(parseTransferProgress("Pulling from registry")).toBeNull();
    expect(parseTransferProgress("Model pulled successfully")).toBeNull();
  });

  it("refuses to divide by a zero total", () => {
    // `Downloaded 0.00B of 0.00B` is what a no-op pull prints — observed against a Hugging Face
    // reference that resolved to nothing. A naive divide renders the bar at NaN width.
    expect(parseTransferProgress("Downloaded 0.00B of 0.00B")).toBeNull();
  });

  it("clamps an overshoot rather than drawing past the end of the track", () => {
    /*
     * Real output from `docker model pull hf.co/HuggingFaceTB/SmolLM2-135M-Instruct`:
     *
     *     Downloaded 545.01MB of 272.50MB
     *
     * The total is the model size and the transfer includes what it discards, so Docker really
     * does report 200%. The byte counts stay honest; only the bar is clamped.
     */
    const progress = parseTransferProgress("Downloaded 545.01MB of 272.50MB");
    expect(progress?.fraction).toBe(1);
    expect(progress?.doneBytes).toBe(545_010_000);
  });
});
