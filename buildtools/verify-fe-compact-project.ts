import path from "node:path";
import fs from "node:fs";

import { ProjectDatabase } from "../src/backend/database/database-operations";

const [, , source_argument, target_argument] = process.argv;
if (source_argument === undefined || target_argument === undefined) {
  throw new Error("Usage: verify-fe-compact-project <source.lg> <target.lg>");
}
const database = new ProjectDatabase();
try {
  const source = path.resolve(source_argument);
  const target = path.resolve(target_argument);
  const source_count = database.execute({ name: "getItemCount", args: { projectPath: source } });
  const compact_count = database.execute({ name: "getItemCount", args: { projectPath: target } });
  const compact_state = database.execute({
    name: "getFateExtraCompactState",
    args: { projectPath: target },
  });
  const first_page = database.execute({
    name: "getFateExtraCompactExportPage",
    args: { projectPath: target, offset: 0, limit: 3 },
  }) as { rows: unknown[] };
  const last_page = database.execute({
    name: "getFateExtraCompactExportPage",
    args: { projectPath: target, offset: Number((compact_state as Record<string, unknown>)["physical_item_count"] ?? 0) - 1, limit: 3 },
  }) as { rows: unknown[] };
  const result = {
    source_count,
    compact_count,
    compact_state,
    first_page_count: first_page.rows.length,
    last_page_count: last_page.rows.length,
  };
  fs.writeFileSync(path.resolve("build", "test-temp", "verify-fe-compact-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  database.close();
}
