// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MaturityChip, MaturityDrawer } from "./MaturityDrawer";
import type { MaturityEntry } from "../data/maturity";

afterEach(cleanup);

const MIXED: MaturityEntry[] = [
  { name: "Container lifecycle", level: "ga", description: "Start and stop." },
  { name: "Checkpoints", level: "experimental", description: "Runtime support." },
  { name: "Debug toolbox", level: "ga", description: "Slim images.", entitlement: "Paid plans" },
];

const ALL_GA: MaturityEntry[] = [
  { name: "Network management", level: "ga", description: "Inspect networks." },
];

describe("MaturityChip", () => {
  it("counts the capabilities that are not settled", () => {
    render(<MaturityChip entries={MIXED} onOpen={() => undefined} />);

    expect(screen.getByRole("button")).toHaveTextContent("1 not GA");
  });

  it("does not call a deprecated capability pre-GA, since deprecated is past GA", () => {
    // Dev Environments is exactly this shape: one entry, Deprecated, nothing else.
    const deprecatedOnly: MaturityEntry[] = [
      {
        name: "Dev Environments",
        level: "deprecated",
        description: "Superseded by Sandboxes.",
      },
    ];
    render(<MaturityChip entries={deprecatedOnly} onOpen={() => undefined} />);

    const chip = screen.getByRole("button");
    expect(chip).toHaveTextContent("1 not GA");
    expect(chip).not.toHaveTextContent("pre-GA");
  });

  it("says so plainly when every capability on the view is GA", () => {
    render(<MaturityChip entries={ALL_GA} onOpen={() => undefined} />);

    expect(screen.getByRole("button")).toHaveTextContent("all GA");
  });

  it("does not let a paid-plan capability read as unqualified green", () => {
    const paidOnly: MaturityEntry[] = [
      { name: "Cloud builders", level: "ga", description: "Remote BuildKit.", entitlement: "Paid plans" },
    ];
    render(<MaturityChip entries={paidOnly} onOpen={() => undefined} />);

    expect(screen.getByRole("button")).toHaveTextContent("1 plan-gated");
  });

  it("renders nothing at all when the view tracks no capabilities", () => {
    const { container } = render(
      <MaturityChip entries={[]} onOpen={() => undefined} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("MaturityDrawer", () => {
  function open(entries = MIXED) {
    render(
      <MaturityDrawer
        entries={entries}
        viewLabel="Containers"
        onClose={() => undefined}
      />,
    );
  }

  it("names the view it is reporting on", () => {
    open();

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Maturity · Containers",
    );
  });

  it("lists every tracked capability with its level", () => {
    open();

    expect(screen.getByText("Container lifecycle")).toBeInTheDocument();
    expect(screen.getByText("Checkpoints")).toBeInTheDocument();
    expect(
      screen.getByText("Experimental", { selector: ".level-chip" }),
    ).toBeInTheDocument();
  });

  it("shows the plan a capability needs, so GA does not imply reachable", () => {
    open();

    expect(screen.getByText("Paid plans")).toBeInTheDocument();
  });

  it("explains what every label means", () => {
    open();

    expect(
      screen.getByText("Supported for everyday production use."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Kept temporarily, scheduled for removal."),
    ).toBeInTheDocument();
  });

  it("states plainly when a view tracks nothing yet", () => {
    open([]);

    expect(
      screen.getByText("Nothing tracked for this view yet."),
    ).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    let closed = false;
    render(
      <MaturityDrawer
        entries={MIXED}
        viewLabel="Containers"
        onClose={() => {
          closed = true;
        }}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toBe(true);
  });

  it("keeps Tab inside the panel, which is what aria-modal promises", () => {
    open();

    const panel = screen.getByRole("dialog");
    const focusable = Array.from(panel.querySelectorAll("button"));
    expect(focusable.length).toBeGreaterThan(0);

    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(focusable[0]).toHaveFocus();

    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("returns focus to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <MaturityDrawer
        entries={MIXED}
        viewLabel="Containers"
        onClose={() => undefined}
      />,
    );
    expect(opener).not.toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("closes when the scrim beside the panel is clicked", () => {
    let closed = false;
    render(
      <MaturityDrawer
        entries={MIXED}
        viewLabel="Containers"
        onClose={() => {
          closed = true;
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("maturity-scrim"));
    expect(closed).toBe(true);
  });
});
