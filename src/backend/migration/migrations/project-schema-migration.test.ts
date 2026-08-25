import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants as sqlite_constants, DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonTool } from "../../../shared/utils/json-tool";
import {
  PROJECT_DATABASE_SCHEMA_VERSION,
  ProjectSchemaMigration,
} from "./project-schema-migration";

let temp_dir = "";
let databases: DatabaseSync[] = [];

beforeEach(() => {
  temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-schema-migration-"));
  databases = [];
});

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {}
  }
  fs.rmSync(temp_dir, { recursive: true, force: true });
});

describe("ProjectSchemaMigration", () => {
  it("为空数据库补齐当前 schema、索引和 schema_version", () => {
    const db = open_database("schema.lg");

    ProjectSchemaMigration.run(db);

    expect(read_table_names(db)).toEqual([
      "analysis_candidate_aggregate",
      "analysis_item_checkpoint",
      "assets",
      "fate_extra_compact_occurrence",
      "fate_extra_compact_override",
      "fate_extra_compact_source",
      "fate_extra_file_summary",
      "fate_extra_preview_navigation_file_summary",
      "fate_extra_preview_navigation_generation",
      "fate_extra_preview_navigation_occurrence",
      "fate_extra_preview_navigation_unit",
      "fate_extra_preview_navigation_unit_file",
      "fate_extra_preview_search_document",
      "fate_extra_preview_search_file_summary",
      "fate_extra_preview_search_fts",
      "fate_extra_preview_search_fts_config",
      "fate_extra_preview_search_fts_data",
      "fate_extra_preview_search_fts_docsize",
      "fate_extra_preview_search_fts_idx",
      "fate_extra_preview_search_generation",
      "fate_extra_preview_search_item",
      "fate_extra_preview_search_mapping",
      "fate_extra_preview_search_short_gram",
      "fate_extra_text_occurrence",
      "fate_extra_text_unit",
      "items",
      "meta",
      "rules",
      "sqlite_sequence",
    ]);
    expect(read_meta_number(db, "schema_version")).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    expect(
      db
        .prepare("PRAGMA table_info(fate_extra_compact_source)")
        .all()
        .find((row) => row["name"] === "representative_translation_authoritative"),
    ).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('fate_extra_text_unit', 'fate_extra_text_occurrence')",
        )
        .get(),
    ).toMatchObject({ count: 2 });
  });

  it.each([
    { kind: "plain" as const, label: "普通" },
    { kind: "fate-extra" as const, label: "FE" },
    { kind: "compact" as const, label: "FE 精简" },
  ])("schema 9 打开旧 $label 项目时只创建空派生索引结构", ({ kind }) => {
    const db = open_database(`legacy-schema-6-${kind}.lg`);
    create_schema_6_fixture(db, kind);
    const facts_before = read_project_facts(db);
    const derived_writes: string[] = [];

    db.setAuthorizer((action_code, table_name) => {
      if (
        DERIVED_SEARCH_DATA_TABLES.has(table_name ?? "") &&
        DERIVED_SEARCH_WRITE_ACTIONS.has(action_code)
      ) {
        derived_writes.push(table_name ?? "");
      }
      return sqlite_constants.SQLITE_OK;
    });
    try {
      ProjectSchemaMigration.run(db);
    } finally {
      db.setAuthorizer(null);
    }

    expect(read_meta_number(db, "schema_version")).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    expect(read_project_facts(db)).toEqual(facts_before);
    expect(read_preview_search_counts(db)).toEqual({
      document: 0,
      file_summary: 0,
      generation: 0,
      item: 0,
      mapping: 0,
      navigation_file_summary: 0,
      navigation_generation: 0,
      navigation_occurrence: 0,
      navigation_unit: 0,
      navigation_unit_file: 0,
      short_gram: 0,
    });
    expect(
      db
        .prepare(
          "SELECT key FROM meta WHERE key LIKE 'fate_extra.preview-search.%' OR key LIKE 'fate_extra.preview-navigation.%'",
        )
        .all(),
    ).toEqual([]);
    expect(derived_writes).toEqual([]);
  });

  it("旧 assets 缺少 sort_order 时按 id 顺序补齐稳定文件顺序", () => {
    const db = open_database("legacy-assets.lg");
    db.exec(`
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        data BLOB NOT NULL,
        original_size INTEGER NOT NULL,
        compressed_size INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO assets (path, data, original_size, compressed_size) VALUES (?, ?, ?, ?)",
    ).run("b.txt", Buffer.from("b"), 1, 1);
    db.prepare(
      "INSERT INTO assets (path, data, original_size, compressed_size) VALUES (?, ?, ?, ?)",
    ).run("a.txt", Buffer.from("a"), 1, 1);

    ProjectSchemaMigration.run(db);

    expect(
      db
        .prepare("SELECT path, sort_order FROM assets ORDER BY id")
        .all()
        .map((row) => ({ path: String(row["path"]), sort_order: Number(row["sort_order"]) })),
    ).toEqual([
      { path: "b.txt", sort_order: 0 },
      { path: "a.txt", sort_order: 1 },
    ]);
  });
  it("fills blank compact machine drafts from source without changing status", () => {
    const db = open_database("compact-drafts.lg");
    ProjectSchemaMigration.run(db);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "fate_extra.compact.v1",
      JsonTool.stringifyStrict({ enabled: true }),
    );
    db.prepare("INSERT INTO items (data) VALUES (?)").run(
      JsonTool.stringifyStrict({ src: "おやすみなさい", dst: "", status: "NONE" }),
    );

    ProjectSchemaMigration.run(db);

    const item = JsonTool.parseStrict<Record<string, unknown>>(
      String(db.prepare("SELECT data FROM items").get()?.["data"]),
    );
    expect(item["dst"]).toBe("おやすみなさい");
    expect(item["status"]).toBe("NONE");
  });
});

type LegacyProjectKind = "plain" | "fate-extra" | "compact";

const DERIVED_SEARCH_DATA_TABLES = new Set([
  "fate_extra_preview_navigation_file_summary",
  "fate_extra_preview_navigation_generation",
  "fate_extra_preview_navigation_occurrence",
  "fate_extra_preview_navigation_unit",
  "fate_extra_preview_navigation_unit_file",
  "fate_extra_preview_search_document",
  "fate_extra_preview_search_file_summary",
  "fate_extra_preview_search_generation",
  "fate_extra_preview_search_item",
  "fate_extra_preview_search_mapping",
  "fate_extra_preview_search_short_gram",
]);

const DERIVED_SEARCH_WRITE_ACTIONS = new Set([
  sqlite_constants.SQLITE_DELETE,
  sqlite_constants.SQLITE_INSERT,
  sqlite_constants.SQLITE_UPDATE,
]);

/** 构造已具备 v6 事实表、但尚无 generation 搜索结构的三类旧项目。 */
function create_schema_6_fixture(db: DatabaseSync, kind: LegacyProjectKind): void {
  ProjectSchemaMigration.run(db);
  db.exec(`
    DROP TABLE fate_extra_preview_navigation_file_summary;
    DROP TABLE fate_extra_preview_navigation_unit_file;
    DROP TABLE fate_extra_preview_navigation_occurrence;
    DROP TABLE fate_extra_preview_navigation_unit;
    DROP TABLE fate_extra_preview_navigation_generation;
    DROP TABLE fate_extra_preview_search_fts;
    DROP TABLE fate_extra_preview_search_short_gram;
    DROP TABLE fate_extra_preview_search_file_summary;
    DROP TABLE fate_extra_preview_search_mapping;
    DROP TABLE fate_extra_preview_search_item;
    DROP TABLE fate_extra_preview_search_document;
    DROP TABLE fate_extra_preview_search_generation;
  `);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    JsonTool.stringifyStrict(6),
  );
  db.prepare("INSERT INTO items (id, data) VALUES (?, ?)").run(
    1,
    JsonTool.stringifyStrict({
      src: `${kind}-source`,
      dst: `${kind}-translation`,
      status: "PROCESSED",
      file_path: "route/0001.txt",
      row: 0,
    }),
  );
  if (kind === "plain") {
    return;
  }

  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "fate_extra.adapter.v1",
    JsonTool.stringifyStrict({ enabled: true, schema_version: 1, logical_text_count: 1 }),
  );
  db.prepare(
    "INSERT INTO fate_extra_text_unit (unit_id, source, representative_item_id, occurrence_count) VALUES (?, ?, ?, ?)",
  ).run(1, `${kind}-source`, 1, 1);
  db.prepare("INSERT INTO fate_extra_text_occurrence (item_id, unit_id) VALUES (?, ?)").run(1, 1);
  db.prepare(
    "INSERT INTO fate_extra_file_summary (file_path, occurrence_count, first_item_id) VALUES (?, ?, ?)",
  ).run("route/0001.txt", 1, 1);
  if (kind === "fate-extra") {
    return;
  }

  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "fate_extra.compact.v1",
    JsonTool.stringifyStrict({ enabled: true, schema_version: 2, physical_item_count: 1 }),
  );
  db.prepare(
    `INSERT INTO fate_extra_compact_source (
      source_hash, source, representative_original_item_id, compact_item_id,
      occurrence_count, excluded_reason
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("legacy-source-hash", `${kind}-source`, 1, 1, 1, "");
  db.prepare(
    `INSERT INTO fate_extra_compact_occurrence (
      original_item_id, source_hash, file_path, row_number, resource_path,
      char_offset, original_prefix, source_line_numbers, pass_through,
      original_machine_translation, original_proofread_translation, original_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    1,
    "legacy-source-hash",
    "route/0001.txt",
    0,
    "resource/0001.bin",
    16,
    "prefix",
    "[1]",
    "[]",
    `${kind}-translation`,
    "",
    "PROCESSED",
  );
}

/** 事实快照排除 schema_version 与全部可删除的派生搜索结构。 */
function read_project_facts(db: DatabaseSync): Record<string, unknown[]> {
  return {
    compact_occurrence: db
      .prepare("SELECT * FROM fate_extra_compact_occurrence ORDER BY original_item_id")
      .all(),
    compact_source: db
      .prepare("SELECT * FROM fate_extra_compact_source ORDER BY source_hash")
      .all(),
    file_summary: db.prepare("SELECT * FROM fate_extra_file_summary ORDER BY file_path").all(),
    items: db.prepare("SELECT * FROM items ORDER BY id").all(),
    meta: db.prepare("SELECT * FROM meta WHERE key <> 'schema_version' ORDER BY key").all(),
    text_occurrence: db.prepare("SELECT * FROM fate_extra_text_occurrence ORDER BY item_id").all(),
    text_unit: db.prepare("SELECT * FROM fate_extra_text_unit ORDER BY unit_id").all(),
  };
}

function read_preview_search_counts(db: DatabaseSync): Record<string, number> {
  return {
    navigation_generation: read_table_count(db, "fate_extra_preview_navigation_generation"),
    navigation_unit: read_table_count(db, "fate_extra_preview_navigation_unit"),
    navigation_occurrence: read_table_count(db, "fate_extra_preview_navigation_occurrence"),
    navigation_unit_file: read_table_count(db, "fate_extra_preview_navigation_unit_file"),
    navigation_file_summary: read_table_count(db, "fate_extra_preview_navigation_file_summary"),
    generation: read_table_count(db, "fate_extra_preview_search_generation"),
    document: read_table_count(db, "fate_extra_preview_search_document"),
    item: read_table_count(db, "fate_extra_preview_search_item"),
    mapping: read_table_count(db, "fate_extra_preview_search_mapping"),
    file_summary: read_table_count(db, "fate_extra_preview_search_file_summary"),
    short_gram: read_table_count(db, "fate_extra_preview_search_short_gram"),
  };
}

function read_table_count(db: DatabaseSync, table_name: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table_name}`).get()?.["count"] ?? 0);
}

/**
 * schema 测试使用真实 SQLite 文件，覆盖 PRAGMA table_info 和 ALTER TABLE 行为。
 */
function open_database(name: string): DatabaseSync {
  const db = new DatabaseSync(path.join(temp_dir, name));
  databases.push(db);
  return db;
}

/**
 * 读取 sqlite_master 只用于断言 schema 迁移产生的公开表集合。
 */
function read_table_names(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row["name"]));
}

/**
 * schema_version 按 JSON 数字存储，测试读取时保持同一序列化规则。
 */
function read_meta_number(db: DatabaseSync, key: string): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row === undefined ? 0 : Number(JsonTool.parseStrict(String(row["value"])));
}
