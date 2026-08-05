import { describe, expect, it } from "vitest";
import { describeEngineHosting } from "./engineHosting";

/**
 * Three of v2.5's Settings panes describe a machine this build often is not running on.
 *
 * File sharing offers VirtioFS and friends; Virtualisation opens by asserting that "on this host
 * [the Linux kernel] comes from a virtual machine". Both are Docker Desktop concepts. Against a
 * native Linux engine there is no VM and no sharing layer — bind mounts come straight off the
 * host filesystem — so rendering either as a set of controls would offer settings that reach
 * nothing.
 *
 * Docker reports `OperatingSystem` as "Docker Desktop" when the daemon is the Desktop VM, and as
 * the distribution name when it is a native engine. That is the signal, and it is read rather
 * than assumed: someone pointing Anchorage at a Desktop context should not be told there is no
 * VM when there is one.
 */
describe("describeEngineHosting", () => {
  it("recognises a native Linux engine from the distribution it reports", () => {
    const hosting = describeEngineHosting({
      operatingSystem: "CachyOS",
      osType: "linux",
    });
    expect(hosting.kind).toBe("native-linux");
  });

  it("recognises Docker Desktop, which does run a virtual machine", () => {
    expect(
      describeEngineHosting({ operatingSystem: "Docker Desktop", osType: "linux" }).kind,
    ).toBe("desktop");
    // Desktop reports variants; matching must not be exact-string.
    expect(
      describeEngineHosting({ operatingSystem: "Docker Desktop 4.30.0 (149282)", osType: "linux" })
        .kind,
    ).toBe("desktop");
  });

  it("says it does not know rather than guessing", () => {
    // A snapshot that has not arrived, or a daemon that reported nothing useful, is not
    // evidence that there is no VM.
    expect(describeEngineHosting(undefined).kind).toBe("unknown");
    expect(describeEngineHosting({ operatingSystem: "", osType: "" }).kind).toBe("unknown");
  });

  it("treats a non-Linux daemon as virtualised, because Linux containers need a Linux kernel", () => {
    expect(
      describeEngineHosting({ operatingSystem: "Windows Server 2022", osType: "windows" }).kind,
    ).toBe("desktop");
  });

  it("carries the reported OS so the pane can quote it rather than paraphrase", () => {
    expect(
      describeEngineHosting({ operatingSystem: "CachyOS", osType: "linux" }).reported,
    ).toBe("CachyOS");
  });
});
