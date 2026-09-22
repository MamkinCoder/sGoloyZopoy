import { Fragment, useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Value used for sorting; column is sortable when present. */
  sortValue?: (row: T) => string | number | null | undefined;
  className?: string;
  align?: "left" | "right";
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  expandedKey?: string | number | null;
  renderExpanded?: (row: T) => ReactNode;
  empty?: ReactNode;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  dense?: boolean;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, expandedKey, renderExpanded, empty, defaultSort, dense }: Props<T>) {
  const [sort, setSort] = useState(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), "ru") * dir;
    });
  }, [rows, sort, columns]);

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const pad = dense ? "py-1" : "";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`th ${c.align === "right" ? "text-right" : ""} ${c.sortValue ? "cursor-pointer select-none hover:text-[var(--text)]" : ""} ${c.className ?? ""}`}
                onClick={c.sortValue ? () => toggleSort(c.key) : undefined}
              >
                {c.header}
                {sort?.key === c.key && <span className="ml-1">{sort.dir === "asc" ? "↑" : "↓"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td className="td faint text-center py-6" colSpan={columns.length}>
                {empty ?? "Пусто"}
              </td>
            </tr>
          )}
          {sorted.map((row) => {
            const k = rowKey(row);
            const isOpen = expandedKey != null && expandedKey === k;
            return (
              <Fragment key={k}>
                <tr
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`${onRowClick ? "cursor-pointer hover:bg-[var(--surface-2)]" : ""} ${isOpen ? "bg-[var(--surface-2)]" : ""}`}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`td ${pad} ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
                {isOpen && renderExpanded && (
                  <tr>
                    <td className="td bg-[var(--surface-2)]/50" colSpan={columns.length}>
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
