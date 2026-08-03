import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";

const DEFAULT_VIEWPORT_HEIGHT = 640;
const DEFAULT_OVERSCAN = 8;

export function FixedRowWindow<T>({
  items,
  rowHeight,
  keyFor,
  renderRow,
  className,
  testId,
  threshold = 200,
  overscan = DEFAULT_OVERSCAN,
}: {
  items: readonly T[];
  rowHeight: number;
  keyFor: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  className?: string;
  testId?: string;
  threshold?: number;
  overscan?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    DEFAULT_VIEWPORT_HEIGHT,
  );
  const virtualized = items.length > threshold;

  useLayoutEffect(() => {
    if (!virtualized) return;
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      setViewportHeight(
        Math.max(rowHeight, host.clientHeight || DEFAULT_VIEWPORT_HEIGHT),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [rowHeight, virtualized]);

  useEffect(() => {
    if (!virtualized) {
      setScrollTop(0);
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    const maximum = Math.max(0, items.length * rowHeight - viewportHeight);
    if (host.scrollTop <= maximum) return;
    host.scrollTop = maximum;
    setScrollTop(maximum);
  }, [items.length, rowHeight, viewportHeight, virtualized]);

  const windowRange = useMemo(() => {
    const visible = Math.ceil(viewportHeight / rowHeight);
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(items.length, start + visible + overscan * 2);
    return { start, end };
  }, [
    items.length,
    overscan,
    rowHeight,
    scrollTop,
    viewportHeight,
  ]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  if (!virtualized) {
    return (
      <div className={className} data-testid={testId}>
        {items.map((item) => (
          <Fragment key={keyFor(item)}>
            {renderRow(item)}
          </Fragment>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className={className}
      data-testid={testId}
      data-virtualized="true"
      onScroll={onScroll}
    >
      <div
        className="fixed-row-window__space"
        style={{ height: items.length * rowHeight }}
      >
        <div
          className="fixed-row-window__items"
          style={{
            transform: `translateY(${windowRange.start * rowHeight}px)`,
          }}
        >
          {items.slice(windowRange.start, windowRange.end).map((item) => (
            <Fragment key={keyFor(item)}>
              {renderRow(item)}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
