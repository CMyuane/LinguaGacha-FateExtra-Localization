import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { JsonTool } from "../../../shared/utils/json-tool";
import { FateExtraCompactTranslationAuthorityMigration } from "./fate-extra-compact-translation-authority-migration";
import { ProjectSchemaMigration } from "./project-schema-migration";

let temp_directory = "";

afterEach(() => {
  if (temp_directory !== "") {
    fs.rmSync(temp_directory, { recursive: true, force: true });
    temp_directory = "";
  }
});

describe("FateExtraCompactTranslationAuthorityMigration", () => {
  it("只把已经偏离创建基线的精简代表译文标记为权威", () => {
    const db = create_database();
    seed_group(db, {
      itemId: 1,
      sourceHash: "unchanged",
      source: "原文一",
      initialMachineTranslation: "初译一",
      currentTranslation: "初译一",
    });
    seed_group(db, {
      itemId: 2,
      sourceHash: "changed",
      source: "原文二",
      initialMachineTranslation: "初译二",
      currentTranslation: "工作台新译二",
    });
    seed_group(db, {
      itemId: 3,
      sourceHash: "placeholder",
      source: "原文三",
      initialMachineTranslation: "",
      currentTranslation: "原文三",
    });
    seed_group(db, {
      itemId: 4,
      sourceHash: "placeholder-changed",
      source: "原文四",
      initialMachineTranslation: "",
      currentTranslation: "工作台新译四",
    });

    FateExtraCompactTranslationAuthorityMigration.run(db);

    expect(
      db
        .prepare(
          "SELECT source_hash, representative_translation_authoritative AS authority FROM fate_extra_compact_source ORDER BY compact_item_id",
        )
        .all(),
    ).toEqual([
      { source_hash: "unchanged", authority: 0 },
      { source_hash: "changed", authority: 1 },
      { source_hash: "placeholder", authority: 0 },
      { source_hash: "placeholder-changed", authority: 1 },
    ]);
    db.close();
  });

  it("迁移计划以代表组为外层并通过主键读取 item 与代表 occurrence", () => {
    const db = create_database();
    const plan = db
      .prepare(`
        EXPLAIN QUERY PLAN
        UPDATE fate_extra_compact_source AS source
        SET representative_translation_authoritative = 1
        WHERE source.compact_item_id IS NOT NULL
          AND source.excluded_reason = ''
          AND EXISTS (
            SELECT 1
            FROM items AS item
            LEFT JOIN fate_extra_compact_occurrence AS representative
              ON representative.original_item_id = source.representative_original_item_id
            WHERE item.id = source.compact_item_id
              AND COALESCE(json_extract(item.data, '$.dst'), '') <> CASE
                WHEN COALESCE(representative.original_machine_translation, '') = ''
                THEN source.source
                ELSE representative.original_machine_translation
              END
          )
      `)
      .all()
      .map((row) => String(row["detail"] ?? ""));

    expect(plan.join("\n")).toMatch(/SCAN source/iu);
    expect(plan.join("\n")).toMatch(/SEARCH item USING INTEGER PRIMARY KEY/iu);
    expect(plan.join("\n")).toMatch(/SEARCH representative USING INTEGER PRIMARY KEY/iu);
    expect(plan.join("\n")).not.toMatch(/SCAN representative/iu);
    db.close();
  });

  it("没有有效精简身份时不处理残留代表表数据", () => {
    const db = create_database(false);
    seed_group(db, {
      itemId: 1,
      sourceHash: "inactive",
      source: "原文",
      initialMachineTranslation: "旧译",
      currentTranslation: "新译",
    });

    FateExtraCompactTranslationAuthorityMigration.run(db);

    expect(
      db
        .prepare(
          "SELECT representative_translation_authoritative AS authority FROM fate_extra_compact_source",
        )
        .get(),
    ).toEqual({ authority: 0 });
    db.close();
  });
});

function create_database(compact_enabled = true): DatabaseSync {
  temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-compact-authority-"));
  const db = new DatabaseSync(path.join(temp_directory, "project.lg"));
  ProjectSchemaMigration.run(db);
  if (compact_enabled) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "fate_extra.compact.v1",
      JsonTool.stringifyStrict({ enabled: true }),
    );
  }
  return db;
}

function seed_group(
  db: DatabaseSync,
  args: {
    itemId: number;
    sourceHash: string;
    source: string;
    initialMachineTranslation: string;
    currentTranslation: string;
  },
): void {
  db.prepare("INSERT INTO items (id, data) VALUES (?, ?)").run(
    args.itemId,
    JsonTool.stringifyStrict({ src: args.source, dst: args.currentTranslation }),
  );
  db.prepare(`
    INSERT INTO fate_extra_compact_source (
      source_hash, source, representative_original_item_id, compact_item_id,
      occurrence_count, excluded_reason
    ) VALUES (?, ?, ?, ?, 1, '')
  `).run(args.sourceHash, args.source, args.itemId, args.itemId);
  db.prepare(`
    INSERT INTO fate_extra_compact_occurrence (
      original_item_id, source_hash, file_path, row_number, resource_path,
      char_offset, original_prefix, source_line_numbers, pass_through,
      original_machine_translation
    ) VALUES (?, ?, 'route.txt', 0, 'route.bin', 0, '', '[]', '[]', ?)
  `).run(args.itemId, args.sourceHash, args.initialMachineTranslation);
}
