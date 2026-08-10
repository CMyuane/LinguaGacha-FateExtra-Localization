import path from "node:path";

import { ProjectDatabase } from "../src/backend/database/database-operations";

const [, , source_argument, target_argument] = process.argv;
if (source_argument === undefined || target_argument === undefined) {
  throw new Error("Usage: create-fe-compact-project <source.lg> <target.lg>");
}
const source = path.resolve(source_argument);
const target = path.resolve(target_argument);
const database = new ProjectDatabase();
try {
  const result = database.execute({
    name: "createFateExtraCompactProject",
    args: {
      projectPath: source,
      targetProjectPath: target,
      name: `${path.parse(source).name}-精简工程`,
    },
  });
  console.log(JSON.stringify(result));
} finally {
  database.close();
}
