// Stagehand `model.generate` → one `claude -p` call (fast tier: observe/extract are classification).
import type { StagehandLLM, Tier } from "@sgz/shared";
import { extractJson } from "./claude.js";

type GenerateParams = Parameters<StagehandLLM["generate"]>[0];

type StagehandExec = (req: { tier: Tier; prompt: string; schema?: unknown }) => Promise<{ text: string; structured?: unknown }>;

const TIERS: Tier[] = ["fast", "write", "tailor"];

export function stagehandTier(env: NodeJS.ProcessEnv = process.env): Tier {
  const t = env.SGZ_STAGEHAND_TIER;
  return t && (TIERS as string[]).includes(t) ? (t as Tier) : "fast";
}

export function flattenMessages(p: GenerateParams): string {
  const blocks: string[] = ["Continue the conversation below as the assistant. Output only the assistant reply, nothing else."];
  if (p.systemPrompt?.trim()) blocks.push(`### SYSTEM\n${p.systemPrompt.trim()}`);
  for (const m of p.messages) blocks.push(`### ${m.role.toUpperCase()}\n${m.content.trim()}`);
  if (p.responseFormat?.type === "json_schema") {
    blocks.push(`### OUTPUT FORMAT\nReturn only JSON matching this schema, no prose, no code fences:\n${JSON.stringify(p.responseFormat.schema)}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

export function stagehandAdapter(exec: StagehandExec, tier: Tier = stagehandTier()): StagehandLLM {
  return {
    async generate(p) {
      const fmt = p.responseFormat;
      const wantsJson = fmt?.type === "json_schema";
      const r = await exec({ tier, prompt: flattenMessages(p), schema: wantsJson ? fmt.schema : undefined });
      if (!wantsJson) return { text: r.text };
      let structured = r.structured;
      if (structured === undefined) {
        try {
          structured = extractJson(r.text);
        } catch {
          // no JSON in the text: structured stays undefined
        }
      }
      const text = structured !== undefined && !r.text.trim() ? JSON.stringify(structured) : r.text;
      return { text, structured };
    },
  };
}
