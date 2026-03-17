import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

let checklistCache = null;

export async function loadChecklist() {
  if (checklistCache) return checklistCache;

  const filePath = resolve(process.cwd(), "data", "review_checklist.extracted.json");
  const raw = await readFile(filePath, "utf-8");
  checklistCache = JSON.parse(raw);
  return checklistCache;
}
