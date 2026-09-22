import type { RunSource } from "@sgz/shared";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStartRun } from "../api/hooks";
import { toast } from "../lib/toast";
import { Dialog } from "./Dialog";
import { Field, Toggle } from "./Ui";

interface Props {
  open: boolean;
  onClose: () => void;
  slug: string;
}

export function RunDialog({ open, onClose, slug }: Props) {
  const nav = useNavigate();
  const start = useStartRun();
  const [source, setSource] = useState<RunSource>("hh");
  const [dryRun, setDryRun] = useState(false);
  const [limit, setLimit] = useState("");
  const [user, setUser] = useState<string>(slug);

  const submit = () => {
    const lim = Number(limit);
    start.mutate(
      { user, source, dry_run: dryRun, limit: lim > 0 ? lim : undefined },
      {
        onSuccess: ({ run_id }) => {
          toast.ok(`Запуск #${run_id} поставлен в очередь`);
          onClose();
          nav(`/u/${slug}/runs/${run_id}`);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Запустить"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={start.isPending} onClick={submit}>
            {start.isPending ? "Запуск…" : "Запустить"}
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Пользователь">
          <select className="input" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value={slug}>{slug}</option>
            <option value="all">все</option>
          </select>
        </Field>
        <Field label="Источник">
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as RunSource)}>
            <option value="hh">hh.ru</option>
            <option value="career">карьерные сайты</option>
            <option value="all">всё</option>
            <option value="pool">пул резюме</option>
          </select>
        </Field>
        <Field label="Лимит откликов" hint="Пусто — дневной лимит пользователя">
          <input className="input" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="напр. 5" />
        </Field>
        <Toggle checked={dryRun} onChange={setDryRun} label="Dry-run (без отправки откликов)" />
      </div>
    </Dialog>
  );
}
