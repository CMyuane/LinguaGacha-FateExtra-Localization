import fs from "node:fs";
import path from "node:path";

import { ProjectDatabase } from "../src/backend/database/database-operations";

const [, , project_argument, report_argument] = process.argv;
if (project_argument === undefined || report_argument === undefined) {
  throw new Error("Usage: verify-fe-context-project <project.lg> <report.json>");
}

const project_path = path.resolve(project_argument);
const report_path = path.resolve(report_argument);
const started_at = Date.now();
const database = new ProjectDatabase();
try {
  const items = database.execute({
    name: "getAllItems",
    args: { projectPath: project_path },
  }) as Array<Record<string, unknown>>;
  const blank_machine_count = items.filter((item) => String(item["dst"] ?? "") === "").length;
  const source_placeholder_count = items.filter(
    (item) => String(item["dst"] ?? "") === String(item["src"] ?? ""),
  ).length;
  const source_placeholder_processed_count = items.filter(
    (item) =>
      String(item["dst"] ?? "") === String(item["src"] ?? "") &&
      String(item["status"] ?? "NONE") === "PROCESSED",
  ).length;
  const context_started_at = Date.now();
  const context = database.execute({
    name: "getFateExtraContext",
    args: {
      projectPath: project_path,
      resourcePath: "FE_完整提取\\pak_unpacked\\7b37eddc1ba71bc1\\field\\016\\0000.dat",
      charOffset: 66540,
      radius: 2,
    },
  }) as Record<string, unknown>;
  const context_elapsed_ms = Date.now() - context_started_at;
  const context_items = Array.isArray(context["items"])
    ? (context["items"] as Array<Record<string, unknown>>)
    : [];
  const report = {
    ok:
      items.length === 28_433 &&
      blank_machine_count === 0 &&
      context["found"] === true &&
      context_items.length === 5 &&
      context_items.some((item) => Number(item["char_offset"] ?? -1) === 66_540),
    project_path,
    item_count: items.length,
    blank_machine_count,
    source_placeholder_count,
    source_placeholder_processed_count,
    context_elapsed_ms,
    context: {
      found: context["found"],
      resource_path: context["resource_path"],
      target_ordinal: context["target_ordinal"],
      block_count: context["block_count"],
      offsets: context_items.map((item) => Number(item["char_offset"] ?? -1)),
      sources: context_items.map((item) => {
        const nested = item["item"] as Record<string, unknown> | null;
        return nested === null
          ? String(item["fallback_source"] ?? "")
          : String(nested?.["src"] ?? item["fallback_source"] ?? "");
      }),
    },
    elapsed_ms: Date.now() - started_at,
  };
  fs.mkdirSync(path.dirname(report_path), { recursive: true });
  fs.writeFileSync(report_path, JSON.stringify(report, null, 2), "utf-8");
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
} finally {
  database.close();
}
