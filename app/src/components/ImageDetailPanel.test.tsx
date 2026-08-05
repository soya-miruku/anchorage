// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageDetailPanel } from "./ImageDetailPanel";
import type { AnchorageImage } from "../types";

afterEach(cleanup);

/**
 * The panel has three ways of having no detail, and they are not the same thing.
 *
 * A read that is still running, a read that failed, and a surface with no daemon to read from
 * all left `detail` null. The last one was rendered as the first, so every image row in the
 * browser preview opened a panel that said "Loading image detail…" and never stopped — a
 * permanent wait presented as a slow one.
 */
const image: AnchorageImage = {
  repository: "registry.test/api",
  tag: "1.4.2",
  id: "sha256:abc",
  imageId: "sha256:abcdef0123456789",
  reference: "registry.test/api:1.4.2",
  identity: "registry.test/api:1.4.2",
  created: "2026-08-01T09:00:00.000Z",
  size: "184 MB",
  sizeMb: 184,
  usageKnown: true,
  inUse: true,
  reclaimable: false,
};

describe("ImageDetailPanel absence of detail", () => {
  it("states the preview's limit rather than waiting forever", () => {
    render(
      <ImageDetailPanel
        image={image}
        detail={null}
        error={null}
        inspectable={false}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/no daemon to inspect this image with/u)).toBeInTheDocument();
    expect(screen.queryByText(/Loading image detail/u)).toBeNull();
  });

  it("still waits when an inspect is genuinely in flight", () => {
    render(
      <ImageDetailPanel
        image={image}
        detail={null}
        error={null}
        inspectable
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/Loading image detail/u)).toBeInTheDocument();
  });

  it("prefers a real failure over both", () => {
    render(
      <ImageDetailPanel
        image={image}
        detail={null}
        error="image inspect: no such image"
        inspectable
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("image inspect: no such image")).toBeInTheDocument();
    expect(screen.queryByText(/Loading image detail/u)).toBeNull();
  });
});
