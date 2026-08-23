import fs from "node:fs";
import path from "node:path";

import { ProjectDatabase } from "../src/backend/database/database-operations";

const root = path.resolve("build", "test-temp", "fate-extra-compact-smoke");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const source = path.join(root, "source.lg");
const target = path.join(root, "compact.lg");
const database = new ProjectDatabase();
const metadata = (resource_path: string, char_offset: number) => ({
  __linguagacha_fe_v1: {
    schema_version: 1,
    path: resource_path,
    char_offset,
    original_prefix: `${resource_path} | char:${char_offset}`,
    source_hash: "",
    source_line_numbers: [1],
    pass_through: [],
    migration_review: false,
    migration_source: "smoke",
    proofread_translation: "",
    display_mode: "auto",
    classification: {
      category: "ordinary_independent_slot",
      category_zh: "普通独立槽位",
      confidence: "confirmed",
      reason: "smoke",
      resource_path,
      byte_offset: char_offset,
      source_bytes: 16,
      slot_capacity: 64,
      slot_end: null,
      allow_overlength: false,
      allow_relocation: false,
      translator_message: "",
      pointer_offsets: [],
      address_limit: null,
      preserve_high16: false,
      shared_storage_group: "",
      shared_group_start: null,
      shared_group_end: null,
      shared_group_members: null,
      format_handler: "",
    },
  },
});

database.execute({ name: "createProject", args: { projectPath: source, name: "source" } });
database.execute({
  name: "setMeta",
  args: {
    projectPath: source,
    key: "fate_extra.adapter.v1",
    value: { schema_version: 1, enabled: true, logical_text_count: 3, file_formats: [] },
  },
});
database.execute({
  name: "setItems",
  args: {
    projectPath: source,
    items: [
      {
        id: 1,
        src: "同文",
        dst: "",
        file_path: "a.txt",
        row: 0,
        status: "NONE",
        extra_field: metadata("a.dat", 10),
      },
      {
        id: 2,
        src: "同文",
        dst: "译文",
        file_path: "b.txt",
        row: 1,
        status: "PROCESSED",
        extra_field: metadata("b.dat", 20),
      },
      {
        id: 3,
        src: "独立",
        dst: "",
        file_path: "b.txt",
        row: 2,
        status: "NONE",
        extra_field: metadata("b.dat", 30),
      },
    ],
  },
});
const result = database.execute({
  name: "createFateExtraCompactProject",
  args: { projectPath: source, targetProjectPath: target, name: "compact" },
}) as Record<string, unknown>;
const source_count = database.execute({ name: "getItemCount", args: { projectPath: source } });
const compact_count = database.execute({ name: "getItemCount", args: { projectPath: target } });
const page = database.execute({
  name: "getFateExtraCompactExportPage",
  args: { projectPath: target, afterOriginalItemId: 0, limit: 100 },
}) as { rows: unknown[] };
const compact_items = database.execute({
  name: "getAllItems",
  args: { projectPath: target },
}) as Array<Record<string, unknown>>;
const translated_representative = compact_items.find((item) => item["src"] === "同文");
if (
  result["physical_item_count"] !== 3 ||
  result["unique_source_count"] !== 2 ||
  result["compact_item_count"] !== 2 ||
  source_count !== 3 ||
  compact_count !== 2 ||
  page.rows.length !== 3 ||
  translated_representative?.["id"] !== 2 ||
  translated_representative?.["dst"] !== "译文"
) {
  throw new Error(
    `compact smoke failed: ${JSON.stringify({ result, source_count, compact_count, rows: page.rows.length, translated_representative })}`,
  );
}
database.close();
console.log(
  JSON.stringify({
    ok: true,
    result,
    source_count,
    compact_count,
    occurrence_count: page.rows.length,
  }),
);
