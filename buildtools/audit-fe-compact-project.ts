import fs from "node:fs";
import path from "node:path";
import { ProjectDatabase } from "../src/backend/database/database-operations";

const [, , source_argument, target_argument] = process.argv;
if (source_argument === undefined || target_argument === undefined) {
  throw new Error("Usage: audit-fe-compact-project <source.lg> <target.lg>");
}
const source = path.resolve(source_argument);
const target = path.resolve(target_argument);
const database = new ProjectDatabase();
const result = database.execute({
  name: "auditFateExtraCompactProject",
  args: { projectPath: source, targetProjectPath: target },
}) as Record<string, unknown>;
database.close();
const output = path.resolve("build", "test-temp", "audit-fe-compact-result.json");
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (result["ok"] !== true) process.exitCode = 1;
