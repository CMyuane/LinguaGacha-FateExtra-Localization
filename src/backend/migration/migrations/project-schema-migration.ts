import type { DatabaseSync } from "node:sqlite";

import { JsonTool } from "../../../shared/utils/json-tool";
import type { MigrationDescriptor, ProjectDatabaseMigrationContext } from "../migration-types";

type SchemaRow = Record<string, unknown>;

export const PROJECT_DATABASE_SCHEMA_VERSION = 7; // 只表达当前表结构能力，不承载业务写回完成状态

/**
 * 迁移背景：
 * 当前 `.lg` 是 SQLite 项目文件，所有工程在业务读取前必须具备同一组表、索引和基础列。
 * 旧工程可能缺少新表或 `assets.sort_order`，而当前文件顺序、asset 读取和后续写回迁移都依赖它。
 *
 * 生效场景：
 * `ProjectDatabase` 首次打开任意 `.lg` 连接时执行，先补齐 schema，再允许其它迁移读取项目事实。
 *
 * 不处理范围：
 * 本文件只补物理结构和当前 schema 版本；规则、item、checkpoint 等业务数据写回由独立迁移点处理。
 */
export const project_schema_migration: MigrationDescriptor = {
  id: "project-schema",
  order: 100,
  /**
   * schema hook 每次首次打开都执行，确保空库和旧库都能补齐当前结构。
   */
  run_project_database_schema(context: ProjectDatabaseMigrationContext): void {
    ProjectSchemaMigration.run(context.db);
  },
};

/**
 * 负责补齐 `.lg` 的物理表结构、索引和 schema_version，是所有项目数据库迁移的前置层。
 */
export class ProjectSchemaMigration {
  /**
   * schema 迁移先建表/索引，再补旧 asset 排序列，最后写 schema_version。
   */
  public static run(db: DatabaseSync): void {
    this.ensure_current_schema(db);
    this.ensure_preview_search_schema(db);
    this.ensure_asset_sort_order_column(db);
    this.ensure_compact_occurrence_translation_columns(db);
    this.ensure_compact_machine_drafts(db);
    this.write_meta_version(db, "schema_version", PROJECT_DATABASE_SCHEMA_VERSION);
  }

  /**
   * 当前 `.lg` 所有表和索引集中在这里创建，避免建表规则散落到 operation 层。
   */
  private static ensure_current_schema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        data BLOB NOT NULL,
        original_size INTEGER NOT NULL,
        compressed_size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_item_checkpoint (
        item_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_candidate_aggregate (
        src TEXT PRIMARY KEY,
        dst_votes TEXT NOT NULL,
        info_votes TEXT NOT NULL,
        observation_count INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        case_sensitive INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fate_extra_text_unit (
        unit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL UNIQUE,
        representative_item_id INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fate_extra_text_occurrence (
        item_id INTEGER PRIMARY KEY,
        unit_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fate_extra_file_summary (
        file_path TEXT PRIMARY KEY,
        occurrence_count INTEGER NOT NULL,
        first_item_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fate_extra_preview_search_generation (
        generation INTEGER PRIMARY KEY,
        adapter_value TEXT NOT NULL,
        items_revision INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        document_count INTEGER NOT NULL,
        short_gram_count INTEGER NOT NULL,
        complete INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fate_extra_preview_search_document (
        document_id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation INTEGER NOT NULL,
        field TEXT NOT NULL,
        search_text TEXT NOT NULL,
        UNIQUE (generation, field, search_text)
      );
      CREATE TABLE IF NOT EXISTS fate_extra_preview_search_item (
        generation INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        unit_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        PRIMARY KEY (generation, item_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fate_extra_preview_search_mapping (
        generation INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        occurrence_id INTEGER NOT NULL,
        field TEXT NOT NULL,
        document_id INTEGER NOT NULL,
        PRIMARY KEY (generation, occurrence_id, field, document_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS fate_extra_preview_search_file_summary (
        generation INTEGER NOT NULL,
        document_id INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL,
        first_item_id INTEGER NOT NULL,
        PRIMARY KEY (generation, document_id)
      );
      CREATE TABLE IF NOT EXISTS fate_extra_preview_search_short_gram (
        generation INTEGER NOT NULL,
        gram TEXT NOT NULL,
        document_id INTEGER NOT NULL,
        PRIMARY KEY (generation, gram, document_id)
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE IF NOT EXISTS fate_extra_preview_search_fts USING fts5(
        search_text,
        content='fate_extra_preview_search_document',
        content_rowid='document_id',
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS fate_extra_compact_source (
        source_hash TEXT PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        representative_original_item_id INTEGER NOT NULL,
        compact_item_id INTEGER,
        occurrence_count INTEGER NOT NULL,
        excluded_reason TEXT NOT NULL DEFAULT '',
        machine_translation_count INTEGER NOT NULL DEFAULT 0,
        proofread_translation_count INTEGER NOT NULL DEFAULT 0,
        safety_category_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS fate_extra_compact_occurrence (
        original_item_id INTEGER PRIMARY KEY,
        source_hash TEXT NOT NULL,
        file_path TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        resource_path TEXT NOT NULL,
        char_offset INTEGER NOT NULL,
        original_prefix TEXT NOT NULL,
        source_line_numbers TEXT NOT NULL,
        pass_through TEXT NOT NULL,
        display_mode TEXT NOT NULL DEFAULT 'auto',
        safety_category TEXT NOT NULL DEFAULT '',
        slot_capacity INTEGER NOT NULL DEFAULT 0,
        allow_overlength INTEGER NOT NULL DEFAULT 0,
        original_machine_translation TEXT NOT NULL DEFAULT '',
        original_proofread_translation TEXT NOT NULL DEFAULT '',
        original_status TEXT NOT NULL DEFAULT 'NONE'
      );
      CREATE TABLE IF NOT EXISTS fate_extra_compact_override (
        original_item_id INTEGER PRIMARY KEY,
        translation TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);
      CREATE INDEX IF NOT EXISTS idx_rules_type ON rules(type);
      CREATE INDEX IF NOT EXISTS idx_analysis_item_checkpoint_status ON analysis_item_checkpoint(status);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_text_occurrence_unit_id
        ON fate_extra_text_occurrence(unit_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_file_summary_first_item_id
        ON fate_extra_file_summary(first_item_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_preview_search_item_document
        ON fate_extra_preview_search_mapping(generation, document_id, item_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_preview_search_mapping_item
        ON fate_extra_preview_search_mapping(generation, item_id, document_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_preview_search_item_unit
        ON fate_extra_preview_search_item(generation, unit_id, item_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_preview_search_item_file
        ON fate_extra_preview_search_mapping(generation, field, document_id, item_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_preview_search_item_category
        ON fate_extra_preview_search_item(generation, category, item_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_compact_occurrence_source_hash
        ON fate_extra_compact_occurrence(source_hash);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_compact_source_item
        ON fate_extra_compact_source(compact_item_id);
      CREATE INDEX IF NOT EXISTS idx_fate_extra_compact_occurrence_file_row
        ON fate_extra_compact_occurrence(file_path, row_number, original_item_id);
    `);
  }

  /**
   * schema 7 开发快照曾使用无 generation 的拼接文档；派生数据可以安全丢弃并按当前结构重建。
   */
  private static ensure_preview_search_schema(db: DatabaseSync): void {
    const document_columns = new Set(
      db
        .prepare("PRAGMA table_info(fate_extra_preview_search_document)")
        .all()
        .map((row) => row_text(row, "name")),
    );
    const mapping_columns = new Set(
      db
        .prepare("PRAGMA table_info(fate_extra_preview_search_mapping)")
        .all()
        .map((row) => row_text(row, "name")),
    );
    if (
      document_columns.has("generation") &&
      document_columns.has("field") &&
      mapping_columns.has("occurrence_id")
    ) {
      return;
    }
    db.exec(`
      DROP TABLE IF EXISTS fate_extra_preview_search_fts;
      DROP TABLE IF EXISTS fate_extra_preview_search_short_gram;
      DROP TABLE IF EXISTS fate_extra_preview_search_file_summary;
      DROP TABLE IF EXISTS fate_extra_preview_search_mapping;
      DROP TABLE IF EXISTS fate_extra_preview_search_item;
      DROP TABLE IF EXISTS fate_extra_preview_search_document;
      DROP TABLE IF EXISTS fate_extra_preview_search_generation;

      CREATE TABLE fate_extra_preview_search_generation (
        generation INTEGER PRIMARY KEY,
        adapter_value TEXT NOT NULL,
        items_revision INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        document_count INTEGER NOT NULL,
        short_gram_count INTEGER NOT NULL,
        complete INTEGER NOT NULL
      );
      CREATE TABLE fate_extra_preview_search_document (
        document_id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation INTEGER NOT NULL,
        field TEXT NOT NULL,
        search_text TEXT NOT NULL,
        UNIQUE (generation, field, search_text)
      );
      CREATE TABLE fate_extra_preview_search_item (
        generation INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        unit_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        PRIMARY KEY (generation, item_id)
      ) WITHOUT ROWID;
      CREATE TABLE fate_extra_preview_search_mapping (
        generation INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        occurrence_id INTEGER NOT NULL,
        field TEXT NOT NULL,
        document_id INTEGER NOT NULL,
        PRIMARY KEY (generation, occurrence_id, field, document_id)
      ) WITHOUT ROWID;
      CREATE TABLE fate_extra_preview_search_file_summary (
        generation INTEGER NOT NULL,
        document_id INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL,
        first_item_id INTEGER NOT NULL,
        PRIMARY KEY (generation, document_id)
      );
      CREATE TABLE fate_extra_preview_search_short_gram (
        generation INTEGER NOT NULL,
        gram TEXT NOT NULL,
        document_id INTEGER NOT NULL,
        PRIMARY KEY (generation, gram, document_id)
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE fate_extra_preview_search_fts USING fts5(
        search_text,
        content='fate_extra_preview_search_document',
        content_rowid='document_id',
        tokenize='trigram'
      );
      CREATE INDEX idx_fate_extra_preview_search_item_document
        ON fate_extra_preview_search_mapping(generation, document_id, item_id);
      CREATE INDEX idx_fate_extra_preview_search_mapping_item
        ON fate_extra_preview_search_mapping(generation, item_id, document_id);
      CREATE INDEX idx_fate_extra_preview_search_item_unit
        ON fate_extra_preview_search_item(generation, unit_id, item_id);
      CREATE INDEX idx_fate_extra_preview_search_item_file
        ON fate_extra_preview_search_mapping(generation, field, document_id, item_id);
      CREATE INDEX idx_fate_extra_preview_search_item_category
        ON fate_extra_preview_search_item(generation, category, item_id);
    `);
  }

  /**
   * 旧 assets 表缺少 sort_order 时，用自增 id 顺序还原导入顺序。
   */
  private static ensure_asset_sort_order_column(db: DatabaseSync): void {
    const columns = db
      .prepare("PRAGMA table_info(assets)")
      .all()
      .map((row) => row_text(row, "name"));
    if (columns.includes("sort_order")) {
      return;
    }
    db.exec("ALTER TABLE assets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    const rows = db.prepare("SELECT id FROM assets ORDER BY id").all();
    const statement = db.prepare("UPDATE assets SET sort_order = ? WHERE id = ?");
    for (const [index, row] of rows.entries()) {
      statement.run(index, row_number(row, "id"));
    }
  }

  /**
   * Schema v5 retains the translation and status attached to every physical
   * occurrence. This makes exact-source deduplication auditable and prevents a
   * blank representative from silently discarding a translated occurrence.
   */
  private static ensure_compact_occurrence_translation_columns(db: DatabaseSync): void {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(fate_extra_compact_occurrence)")
        .all()
        .map((row) => row_text(row, "name")),
    );
    const additions = [
      ["original_machine_translation", "TEXT NOT NULL DEFAULT ''"],
      ["original_proofread_translation", "TEXT NOT NULL DEFAULT ''"],
      ["original_status", "TEXT NOT NULL DEFAULT 'NONE'"],
    ] as const;
    for (const [column, definition] of additions) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE fate_extra_compact_occurrence ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  /**
   * Older compact FE projects left `dst` empty when no translation existed.
   * The preview then fell back to `src`, while the machine-draft editor stayed
   * blank. Persist the Japanese placeholder so editor, preview and QA agree.
   * Status is deliberately left unchanged, so a source copy is not counted as
   * a completed translation.
   */
  private static ensure_compact_machine_drafts(db: DatabaseSync): void {
    const compact_meta = db
      .prepare("SELECT value FROM meta WHERE key = 'fate_extra.compact.v1'")
      .get()?.["value"];
    if (typeof compact_meta !== "string") {
      return;
    }
    let enabled = false;
    try {
      const parsed = JsonTool.parseStrict<unknown>(compact_meta);
      enabled =
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)["enabled"] === true;
    } catch {
      return;
    }
    if (!enabled) {
      return;
    }
    db.exec(`
      UPDATE items
      SET data = json_set(data, '$.dst', COALESCE(json_extract(data, '$.src'), ''))
      WHERE COALESCE(json_extract(data, '$.dst'), '') = '';
    `);
  }

  /**
   * schema_version 使用严格 JSON 数字写入 meta，和其它 meta 序列化保持一致。
   */
  private static write_meta_version(db: DatabaseSync, key: string, version: number): void {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      key,
      JsonTool.stringifyStrict(version),
    );
  }
}

/**
 * PRAGMA / SQLite 行值可能不是字符串，读取列名时统一收窄。
 */
function row_text(row: SchemaRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * SQLite INTEGER 可能以 number 或 bigint 返回，写回 id 前统一转 number。
 */
function row_number(row: SchemaRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return Number(value ?? 0);
}
