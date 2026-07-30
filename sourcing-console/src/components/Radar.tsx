/**
 * Minimalist radar chart for the seven signal categories.
 *
 * Deliberately dependency-free SVG: the console ships no charting library, and
 * a seven-axis polygon is less code than the wrapper around one would be.
 * Axes are always drawn in the same order so two companies can be compared by
 * shape at a glance.
 */

export type RadarAxis = {
  label: string;
  /** 0–1. null means nothing was resolved in this category — drawn as a gap. */
  value: number | null;
  /** Short label for the tooltip, e.g. "6/8 resolved". */
  detail?: string;
};

const SHORT: Record<string, string> = {
  "Founder & Team": "Founder",
  "Regulatory & Compliance": "Regulatory",
  "Commercial Traction": "Commercial",
  "Technology & Product": "Technology",
  "Investor & Funding": "Investor",
  "Market Presence": "Market",
  "Structural & Strategic": "Structural",
};

export function shortAxisLabel(category: string) {
  return SHORT[category] ?? category;
}

export default function Radar({
  axes,
  size = 260,
  rings = 4,
}: {
  axes: RadarAxis[];
  size?: number;
  rings?: number;
}) {
  const n = axes.length;
  if (!n) return null;

  const pad = 52;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - pad;

  // Start at 12 o'clock and go clockwise.
  const angleAt = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointAt = (i: number, radius: number) => {
    const a = angleAt(i);
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius] as const;
  };

  const resolved = axes.map((a) => (a.value == null ? 0 : Math.max(0, Math.min(1, a.value))));
  const anyResolved = axes.some((a) => a.value != null);

  const polygon = resolved
    .map((v, i) => {
      const [x, y] = pointAt(i, r * v);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      className="radar"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label="Signal fit by category"
    >
      {/* rings */}
      {Array.from({ length: rings }, (_, ring) => {
        const rr = (r * (ring + 1)) / rings;
        const pts = Array.from({ length: n }, (_, i) => {
          const [x, y] = pointAt(i, rr);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        return (
          <polygon
            key={ring}
            points={pts}
            className={ring === rings - 1 ? "radar-ring radar-ring-outer" : "radar-ring"}
          />
        );
      })}

      {/* spokes */}
      {axes.map((_, i) => {
        const [x, y] = pointAt(i, r);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} className="radar-spoke" />;
      })}

      {anyResolved ? (
        <>
          <polygon points={polygon} className="radar-area" />
          {resolved.map((v, i) => {
            if (axes[i].value == null) return null;
            const [x, y] = pointAt(i, r * v);
            return <circle key={i} cx={x} cy={y} r={2.6} className="radar-dot" />;
          })}
        </>
      ) : null}

      {/* labels */}
      {axes.map((axis, i) => {
        const [x, y] = pointAt(i, r + 16);
        const anchor = Math.abs(x - cx) < 6 ? "middle" : x > cx ? "start" : "end";
        return (
          <text key={i} x={x} y={y} className="radar-label" textAnchor={anchor} dominantBaseline="middle">
            {shortAxisLabel(axis.label)}
            <title>
              {axis.label}
              {axis.value == null ? " — not resolved" : ` — ${Math.round(axis.value * 100)}%`}
              {axis.detail ? ` (${axis.detail})` : ""}
            </title>
          </text>
        );
      })}
    </svg>
  );
}
