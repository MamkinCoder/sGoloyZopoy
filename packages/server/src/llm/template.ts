// Tiny mustache-like renderer for prompts/*.md: {{var}}, {{a.b}}, {{#if x}}…{{/if}}, {{> partial}}.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type TemplateVars = Record<string, unknown>;

export const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

const cache = new Map<string, string>();

export function loadTemplate(name: string): string {
  let t = cache.get(name);
  if (t === undefined) {
    t = readFileSync(`${PROMPTS_DIR}${name}.md`, "utf8");
    cache.set(name, t);
  }
  return t;
}

export function renderTemplate(src: string, vars: TemplateVars, partial: (name: string) => string = loadTemplate): string {
  const withPartials = src.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name: string) => partial(name).trim());
  const withIfs = withPartials.replace(/\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, path: string, body: string) =>
    truthy(lookup(vars, path)) ? body : "",
  );
  return withIfs.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => stringify(lookup(vars, path)));
}

export function renderPrompt(name: string, vars: TemplateVars): string {
  return renderTemplate(loadTemplate(name), vars).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function lookup(vars: TemplateVars, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), vars);
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return Boolean(v);
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}
