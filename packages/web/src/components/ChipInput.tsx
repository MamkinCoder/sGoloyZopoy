import { useState, type KeyboardEvent } from "react";

interface Props {
  value: string[];
  onChange: (v: string[]) => void;
  variant?: "default" | "danger";
}

export function ChipInput({ value, onChange, variant = "default" }: Props) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const parts = draft
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const chipCls =
    variant === "danger" ? "chip bg-[var(--bad-soft)] text-[var(--bad)] border-transparent" : "chip";
  return (
    <div className="input h-auto min-h-8 py-1 flex flex-wrap gap-1 items-center">
      {value.map((v) => (
        <span key={v} className={chipCls}>
          {v}
          <button type="button" aria-label={`Убрать ${v}`} className="opacity-60 hover:opacity-100" onClick={() => onChange(value.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[120px] bg-transparent outline-none text-[13px]"
        value={draft}
        placeholder={value.length ? "" : "Enter — добавить"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
      />
    </div>
  );
}
