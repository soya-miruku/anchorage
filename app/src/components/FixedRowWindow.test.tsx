// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FixedRowWindow } from "./FixedRowWindow";

afterEach(cleanup);

const tenThousand = Array.from({ length: 10_000 }, (_, index) => ({
  id: String(index),
}));

describe("FixedRowWindow", () => {
  it("preserves the complete small fixture DOM path", () => {
    const items = tenThousand.slice(0, 8);
    render(
      <FixedRowWindow
        items={items}
        rowHeight={56}
        testId="fixture-window"
        keyFor={(item) => item.id}
        renderRow={(item) => (
          <div data-testid={`fixture-row-${item.id}`}>{item.id}</div>
        )}
      />,
    );

    expect(screen.getByTestId("fixture-window")).not.toHaveAttribute(
      "data-virtualized",
    );
    expect(screen.getAllByTestId(/fixture-row-/u)).toHaveLength(8);
  });

  it("bounds 10k container and image DOMs while preserving stable row identity on scroll", async () => {
    render(
      <>
        <FixedRowWindow
          items={tenThousand}
          rowHeight={56}
          testId="container-window"
          keyFor={(item) => item.id}
          renderRow={(item) => (
            <div data-testid={`container-row-${item.id}`}>{item.id}</div>
          )}
        />
        <FixedRowWindow
          items={tenThousand}
          rowHeight={52}
          testId="image-window"
          keyFor={(item) => item.id}
          renderRow={(item) => (
            <div data-testid={`image-row-${item.id}`}>{item.id}</div>
          )}
        />
      </>,
    );

    expect(screen.getByTestId("container-window")).toHaveAttribute(
      "data-virtualized",
      "true",
    );
    expect(screen.getByTestId("image-window")).toHaveAttribute(
      "data-virtualized",
      "true",
    );
    expect(screen.getAllByTestId(/container-row-/u).length).toBeLessThanOrEqual(
      40,
    );
    expect(screen.getAllByTestId(/image-row-/u).length).toBeLessThanOrEqual(40);
    expect(screen.getByTestId("container-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("image-row-0")).toBeInTheDocument();

    fireEvent.scroll(screen.getByTestId("container-window"), {
      target: { scrollTop: 5_000 * 56 },
    });
    await waitFor(() =>
      expect(screen.getByTestId("container-row-5000")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("container-row-0")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/container-row-/u).length).toBeLessThanOrEqual(
      40,
    );
  });
});
