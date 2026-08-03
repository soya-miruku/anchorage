import { memo, useEffect, useState } from "react";

import { isDesignCaptureRequest } from "../theme/appearance";

const formatClock = () =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());

/**
 * The reading used when the design-parity harness is driving the app.
 *
 * The clock was the one element that changed between otherwise identical capture runs, which
 * made the whole 24-state capture non-reproducible and invalidated the visual-review
 * attestation's per-file hashes every time it was regenerated. Freezing is preferable to
 * masking the region: the glyphs, alignment and colour of the clock stay under comparison,
 * and only the part with no conformance meaning — which second it happens to be — is fixed.
 */
const FROZEN_CLOCK = "00:00:00";

/**
 * The status-bar clock owns its own interval and state.
 *
 * It previously lived in the single application store, so its 1 Hz tick re-rendered the whole
 * tree — titlebar, sidebar, engine card, the active screen and the Command Center dialog if it
 * was open — once a second, forever, for a value rendered in exactly one <time> element.
 */
export const StatusClock = memo(function StatusClock() {
  const frozen = isDesignCaptureRequest(
    typeof window === "undefined" ? "" : window.location.search,
  );
  const [clock, setClock] = useState(() =>
    frozen ? FROZEN_CLOCK : formatClock(),
  );

  useEffect(() => {
    if (frozen) return undefined;
    const timer = window.setInterval(() => setClock(formatClock()), 1000);
    return () => window.clearInterval(timer);
  }, [frozen]);

  return <time>{clock}</time>;
});
