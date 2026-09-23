import { useState } from "react";

interface Props {
  value: unknown;
  name?: string;
  depth?: number;
  /** Levels expanded by default. */
  open?: number;
}

function Primitive({ v }: { v: unknown }) {
  if (v === null) return <span className="faint">null</span>;
  if (typeof v === "string") return <span className="text-[var(--ok)] break-all">"{v}"</span>;
  if (typeof v === "number") return <span className="text-[var(--accent)]">{v}</span>;
  if (typeof v === "boolean") return <span className="text-[var(--warn)]">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

export function JsonView({ value, name, depth = 0, open = 1 }: Props) {
  const [expanded, setExpanded] = useState(depth < open);
  const composite = typeof value === "object" && value !== null;
  const entries = composite ? Object.entries(value as object) : [];
  const label = name !== undefined ? <span className="muted">{name}: </span> : null;

  if (!composite) {
    return (
      <div className="kbd" style={{ paddingLeft: depth * 12 }}>
        {label}
        <Primitive v={value} />
      </div>
    );
  }
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <div className="kbd">
      <button type="button" className="text-left hover:underline" style={{ paddingLeft: depth * 12 }} onClick={() => setExpanded((e) => !e)}>
        <span className="faint inline-block w-3">{expanded ? "▾" : "▸"}</span>
        {label}
        {expanded ? brackets[0] : `${brackets[0]}…${brackets[1]}`}
        {!expanded && <span className="faint"> {entries.length}</span>}
      </button>
      {expanded && (
        <div>
          {entries.length === 0 && <div className="faint" style={{ paddingLeft: (depth + 1) * 12 }}>пусто</div>}
          {entries.map(([k, v]) => (
            <JsonView key={k} name={k} value={v} depth={depth + 1} open={open} />
          ))}
          <div style={{ paddingLeft: depth * 12 + 12 }}>{brackets[1]}</div>
        </div>
      )}
    </div>
  );
}
