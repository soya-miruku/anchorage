import { describe, expect, it } from "vitest";

import { compareApiVersions, describeVersionSkew } from "./engineVersions";
import type { DockerVersions } from "../types";

const versions = (
  client: DockerVersions["client"],
  server: DockerVersions["server"],
): DockerVersions => ({ client, server });

describe("compareApiVersions", () => {
  it("orders Docker's major.minor decimals rather than strings", () => {
    // The string comparison this replaces gets "1.9" > "1.10" wrong, which is the one case
    // that matters: the minor number crossed into two digits years ago.
    expect(compareApiVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareApiVersions("1.9", "1.10")).toBeLessThan(0);
    expect(compareApiVersions("1.51", "1.51")).toBe(0);
    expect(compareApiVersions("2.0", "1.99")).toBeGreaterThan(0);
  });

  it("treats an unparseable version as equal rather than throwing", () => {
    // This decides wording. A parse failure must not become a claim that the daemon is
    // incompatible, which is the only verdict that tells an operator something is broken.
    for (const [left, right] of [
      ["", "1.51"],
      ["latest", "1.51"],
      ["1", "1.51"],
      ["1.x", "1.51"],
    ]) {
      expect(compareApiVersions(left, right), `${left} vs ${right}`).toBe(0);
    }
  });
});

describe("describeVersionSkew", () => {
  it("says nothing about a machine it has not read", () => {
    // Browser preview, a failed `docker version`, or before the first read lands. "unknown" is
    // not "aligned": claiming agreement between two things nobody looked at would be a lie.
    expect(describeVersionSkew(undefined).kind).toBe("unknown");
    expect(describeVersionSkew(versions({}, {})).kind).toBe("unknown");
    // One side alone still cannot describe a relationship.
    expect(describeVersionSkew(versions({ version: "29.7.1" }, {})).kind).toBe(
      "unknown",
    );
    expect(describeVersionSkew(versions({}, { version: "29.7.1" })).kind).toBe(
      "unknown",
    );
  });

  it("reports matching versions as aligned, with nothing to explain", () => {
    const skew = describeVersionSkew(
      versions(
        { version: "29.7.1", apiVersion: "1.51" },
        { version: "29.7.1", apiVersion: "1.51", minApiVersion: "1.24" },
      ),
    );
    expect(skew.kind).toBe("aligned");
    expect(skew.negotiatedApiVersion).toBe("1.51");
    // An aligned pair needs no prose; a sentence here would be noise on every healthy machine.
    expect(skew.detail).toBeUndefined();
  });

  it("names the negotiated API when the two versions differ", () => {
    // The ordinary Linux drift: apt upgraded the CLI, the daemon is still running what it
    // started with. It works, but newer flags quietly do not exist.
    const skew = describeVersionSkew(
      versions(
        { version: "29.7.1", apiVersion: "1.51", minApiVersion: "1.24" },
        { version: "28.0.4", apiVersion: "1.48", minApiVersion: "1.24" },
      ),
    );
    expect(skew.kind).toBe("skewed");
    expect(skew.negotiatedApiVersion).toBe("1.48");
    expect(skew.detail).toContain("1.48");
    expect(skew.clientVersion).toBe("29.7.1");
    expect(skew.serverVersion).toBe("28.0.4");
  });

  it("negotiates to the lower API whichever side is ahead", () => {
    const olderClient = describeVersionSkew(
      versions(
        { version: "24.0.0", apiVersion: "1.43" },
        { version: "29.7.1", apiVersion: "1.51" },
      ),
    );
    expect(olderClient.negotiatedApiVersion).toBe("1.43");
    expect(olderClient.kind).toBe("skewed");
  });

  it("calls out a daemon below the client's floor as a real break", () => {
    // Not cosmetic: every call fails, and it must not be reported in the same tone as a
    // version string that merely differs.
    const skew = describeVersionSkew(
      versions(
        { version: "29.7.1", apiVersion: "1.51", minApiVersion: "1.44" },
        { version: "19.03.0", apiVersion: "1.40", minApiVersion: "1.12" },
      ),
    );
    expect(skew.kind).toBe("incompatible");
    expect(skew.detail).toContain("1.40");
    expect(skew.detail).toContain("1.44");
  });

  it("checks incompatibility before equality, so a broken pair is never called aligned", () => {
    // Contrived but the ordering is what is being pinned: identical version strings with an
    // API below the floor must still report the break.
    const skew = describeVersionSkew(
      versions(
        { version: "29.7.1", apiVersion: "1.51", minApiVersion: "1.44" },
        { version: "29.7.1", apiVersion: "1.40" },
      ),
    );
    expect(skew.kind).toBe("incompatible");
  });

  it("does not invent a negotiated API when a side did not report one", () => {
    const skew = describeVersionSkew(
      versions({ version: "29.7.1" }, { version: "28.0.4" }),
    );
    expect(skew.kind).toBe("skewed");
    expect(skew.negotiatedApiVersion).toBeUndefined();
    expect(skew.detail).toContain("neither stated an API version");
  });
});
