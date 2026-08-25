import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "./database-operations";
import {
  advance_fate_extra_preview_navigation_revision,
  FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY,
  FATE_EXTRA_PREVIEW_INDEX_FORMAT_VERSION,
  read_fate_extra_preview_navigation_state,
} from "./fate-extra-preview-navigation-index";
import {
  activate_fate_extra_preview_search_generation,
  advance_fate_extra_preview_index_revision,
  cleanup_fate_extra_inactive_preview_search_generations,
  read_fate_extra_index_state,
  read_fate_extra_preview_search_index_state,
  refresh_fate_extra_preview_search_documents,
  run_fate_extra_index_maintenance,
} from "./fate-extra-preview-search-index";

type TestItem = {
  id: number;
  src: string;
  dst: string;
  file_path: string;
  status?: string;
};

let temp_directory = "";

afterEach(() => {
  if (temp_directory === "") return;
  fs.rmSync(temp_directory, { recursive: true, force: true });
  temp_directory = "";
});

describe("fate-extra preview search generation", () => {
  it("结构 revision 间隔后拒绝把旧 generation 增量提升为当前 revision", () => {
    const project_path = create_project("stale-refresh");
    build_and_activate(project_path, 0);

    const db = new DatabaseSync(project_path);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE items SET data = json_set(data, '$.src', '结构已变化') WHERE id = 1").run();
    write_items_revision(db, 1);
    db.exec("COMMIT");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE items SET data = json_set(data, '$.dst', '新译文') WHERE id = 1").run();
    write_items_revision(db, 2);
    const refreshed = refresh_fate_extra_preview_search_documents(db, [1]);
    db.exec("COMMIT");

    expect(refreshed).toBe(false);
    expect(read_fate_extra_preview_search_index_state(db)).toMatchObject({
      ready: false,
      generation: 1,
      items_revision: 2,
      indexed_items_revision: 0,
    });
    expect(
      db
        .prepare(
          "SELECT items_revision FROM fate_extra_preview_search_generation WHERE generation = 1",
        )
        .get()?.["items_revision"],
    ).toBe(0);
    db.close();
  });

  it("冷建按批提交且只在最终短事务切换 active generation", () => {
    const project_path = create_project("batch-publish");
    build_and_activate(project_path, 0);
    structurally_change_project(project_path, 1);

    let observed_inactive_generation = false;
    const build = run_fate_extra_index_maintenance(project_path, 1, (completed) => {
      if (completed <= 0 || observed_inactive_generation) return;
      const concurrent_writer = new DatabaseSync(project_path);
      concurrent_writer.exec("PRAGMA busy_timeout=50");
      expect(read_meta_value(concurrent_writer, "fate_extra.preview-search.generation")).toBe("1");
      expect(
        concurrent_writer
          .prepare("SELECT complete FROM fate_extra_preview_search_generation WHERE generation = 2")
          .get()?.["complete"],
      ).toBe(0);
      expect(
        concurrent_writer
          .prepare(`
            SELECT COUNT(*) AS count
            FROM fate_extra_preview_search_fts AS search_fts
            JOIN fate_extra_preview_search_document AS document
              ON document.document_id = search_fts.rowid
            WHERE document.generation = 1 AND search_fts.search_text MATCH '月海原'
          `)
          .get()?.["count"],
      ).toBeGreaterThan(0);
      concurrent_writer
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('test.index-progress', '1')")
        .run();
      concurrent_writer.close();
      observed_inactive_generation = true;
    });

    expect(observed_inactive_generation).toBe(true);
    expect(build).toMatchObject({
      generation: 2,
      items_revision: 1,
    });
    const before_activation = new DatabaseSync(project_path, { readOnly: true });
    expect(read_meta_value(before_activation, "fate_extra.preview-search.generation")).toBe("1");
    expect(
      before_activation
        .prepare(
          "SELECT generation, complete FROM fate_extra_preview_search_generation ORDER BY generation",
        )
        .all(),
    ).toEqual([
      { generation: 1, complete: 1 },
      { generation: 2, complete: 1 },
    ]);
    before_activation.close();
    const db = new DatabaseSync(project_path);
    expect(
      activate_fate_extra_preview_search_generation(
        db,
        build.generation,
        build.items_revision,
        build.adapter_value,
      ),
    ).toMatchObject({
      search_ready: true,
      search_generation: 2,
      search_items_revision: 1,
    });
    expect(read_meta_value(db, "fate_extra.preview-search.generation")).toBe("2");
    db.close();
  });

  it("最终发布身份冲突会清理非活动 generation 并保留旧 active", () => {
    const project_path = create_project("conflict-cleanup");
    build_and_activate(project_path, 0);
    structurally_change_project(project_path, 1);

    let changed_revision = false;
    let completed_reports = 0;
    expect(() =>
      run_fate_extra_index_maintenance(project_path, 1, (completed) => {
        if (completed <= 0 || changed_revision) return;
        completed_reports += 1;
        if (completed_reports < 2) return;
        const writer = new DatabaseSync(project_path);
        write_items_revision(writer, 2);
        writer.close();
        changed_revision = true;
      }),
    ).toThrow(/identity_changed/);

    expect(changed_revision).toBe(true);
    expect(completed_reports).toBe(2);
    const db = new DatabaseSync(project_path, { readOnly: true });
    expect(read_meta_value(db, "fate_extra.preview-search.generation")).toBe("1");
    expect(
      db
        .prepare(
          "SELECT generation, complete FROM fate_extra_preview_search_generation ORDER BY generation",
        )
        .all(),
    ).toEqual([{ generation: 1, complete: 1 }]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM fate_extra_preview_search_document WHERE generation = 2",
        )
        .get()?.["count"],
    ).toBe(0);
    db.close();
  });

  it("标准 FE 冷建从物理、唯一、文件和搜索映射排除 EXCLUDED", () => {
    const project_path = create_project("excluded-standard", [
      { id: 1, src: "重复原文", dst: "旧代表", file_path: "route-a.txt", status: "EXCLUDED" },
      { id: 2, src: "重复原文", dst: "新代表", file_path: "route-a.txt" },
      { id: 3, src: "仅排除", dst: "隐藏", file_path: "route-b.txt", status: "EXCLUDED" },
      { id: 4, src: "保留", dst: "可见", file_path: "route-b.txt", status: "PROCESSED" },
    ]);
    build_and_activate(project_path, 0);

    const db = new DatabaseSync(project_path, { readOnly: true });
    expect(
      db
        .prepare(`
          SELECT position, item_id, occurrence_count
          FROM fate_extra_preview_navigation_unit
          WHERE generation = 1
          ORDER BY position
        `)
        .all(),
    ).toEqual([
      { position: 0, item_id: 2, occurrence_count: 1 },
      { position: 1, item_id: 4, occurrence_count: 1 },
    ]);
    expect(
      db
        .prepare(`
          SELECT occurrence_id, item_id, global_position
          FROM fate_extra_preview_navigation_occurrence
          WHERE generation = 1
          ORDER BY global_position
        `)
        .all(),
    ).toEqual([
      { occurrence_id: 2, item_id: 2, global_position: 0 },
      { occurrence_id: 4, item_id: 4, global_position: 1 },
    ]);
    expect(
      db
        .prepare(`
          SELECT file_path, occurrence_count, unique_count
          FROM fate_extra_preview_navigation_file_summary
          WHERE generation = 1
          ORDER BY file_path
        `)
        .all(),
    ).toEqual([
      { file_path: "route-a.txt", occurrence_count: 1, unique_count: 1 },
      { file_path: "route-b.txt", occurrence_count: 1, unique_count: 1 },
    ]);
    expect(
      db
        .prepare(`
          SELECT DISTINCT item_id
          FROM fate_extra_preview_search_mapping
          WHERE generation = 1
          ORDER BY item_id
        `)
        .all(),
    ).toEqual([{ item_id: 2 }, { item_id: 4 }]);
    expect(read_fate_extra_preview_navigation_state(db)).toMatchObject({
      ready: true,
      unique_count: 2,
      occurrence_count: 2,
      file_count: 2,
    });
    db.close();
  });

  it("精简 FE 代表项 EXCLUDED 会隐藏整组物理位置及搜索映射", () => {
    const project_path = create_project("excluded-compact", [
      { id: 1, src: "隐藏组", dst: "隐藏", file_path: "compact.txt", status: "EXCLUDED" },
      { id: 2, src: "可见组", dst: "可见", file_path: "compact.txt" },
    ]);
    const fixture = new DatabaseSync(project_path);
    fixture
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fate_extra.compact.v1', ?)")
      .run(JSON.stringify({ enabled: true, schema_version: 2 }));
    fixture.exec(`
      INSERT INTO fate_extra_compact_source (
        source_hash, source, representative_original_item_id, compact_item_id,
        occurrence_count, excluded_reason
      ) VALUES
        ('hidden-hash', '隐藏组', 10, 1, 2, ''),
        ('visible-hash', '可见组', 30, 2, 2, '');
      INSERT INTO fate_extra_compact_occurrence (
        original_item_id, source_hash, file_path, row_number, resource_path,
        char_offset, original_prefix, source_line_numbers, pass_through
      ) VALUES
        (10, 'hidden-hash', 'route-a.txt', 0, 'route-a.bin', 16, '', '[1]', '[]'),
        (20, 'hidden-hash', 'route-b.txt', 0, 'route-b.bin', 24, '', '[1]', '[]'),
        (30, 'visible-hash', 'route-a.txt', 1, 'route-a.bin', 32, '', '[2]', '[]'),
        (40, 'visible-hash', 'route-b.txt', 1, 'route-b.bin', 40, '', '[2]', '[]');
    `);
    fixture.close();
    build_and_activate(project_path, 0);

    const db = new DatabaseSync(project_path, { readOnly: true });
    expect(
      db
        .prepare(`
          SELECT position, item_id, occurrence_count
          FROM fate_extra_preview_navigation_unit
          WHERE generation = 1
        `)
        .all(),
    ).toEqual([{ position: 0, item_id: 2, occurrence_count: 2 }]);
    expect(
      db
        .prepare(`
          SELECT occurrence_id, item_id, global_position
          FROM fate_extra_preview_navigation_occurrence
          WHERE generation = 1
          ORDER BY global_position
        `)
        .all(),
    ).toEqual([
      { occurrence_id: 30, item_id: 2, global_position: 0 },
      { occurrence_id: 40, item_id: 2, global_position: 1 },
    ]);
    expect(
      db
        .prepare(`
          SELECT file_path, occurrence_count, unique_count
          FROM fate_extra_preview_navigation_file_summary
          WHERE generation = 1
          ORDER BY file_path
        `)
        .all(),
    ).toEqual([
      { file_path: "route-a.txt", occurrence_count: 1, unique_count: 1 },
      { file_path: "route-b.txt", occurrence_count: 1, unique_count: 1 },
    ]);
    expect(
      db
        .prepare(`
          SELECT DISTINCT item_id
          FROM fate_extra_preview_search_mapping
          WHERE generation = 1
          ORDER BY item_id
        `)
        .all(),
    ).toEqual([{ item_id: 2 }]);
    expect(read_fate_extra_preview_navigation_state(db)).toMatchObject({
      ready: true,
      unique_count: 1,
      occurrence_count: 2,
      file_count: 2,
    });
    db.close();
  });

  it("增量标记 EXCLUDED 会删除搜索映射并让导航 generation 等待重建", () => {
    const project_path = create_project("excluded-incremental");
    build_and_activate(project_path, 0);

    const db = new DatabaseSync(project_path);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE items SET data = json_set(data, '$.status', 'EXCLUDED') WHERE id = 1").run();
    write_items_revision(db, 1);
    expect(refresh_fate_extra_preview_search_documents(db, [1])).toBe(false);
    db.exec("COMMIT");

    expect(
      db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM fate_extra_preview_search_mapping
          WHERE generation = 1 AND item_id = 1
        `)
        .get()?.["count"],
    ).toBe(0);
    expect(
      db
        .prepare(`
          SELECT items_revision
          FROM fate_extra_preview_search_generation
          WHERE generation = 1
        `)
        .get()?.["items_revision"],
    ).toBe(0);
    expect(
      db
        .prepare(`
          SELECT items_revision
          FROM fate_extra_preview_navigation_generation
          WHERE generation = 1
        `)
        .get()?.["items_revision"],
    ).toBe(0);
    expect(read_fate_extra_preview_search_index_state(db).ready).toBe(false);
    expect(read_fate_extra_preview_navigation_state(db).ready).toBe(false);
    db.close();
  });

  it("仅改显示类型时轻量推进索引身份且不刷新搜索文档", () => {
    const project_path = create_project("display-only-revision");
    build_and_activate(project_path, 0);

    const db = new DatabaseSync(project_path);
    const source_adapter_value = read_meta_value(db, "fate_extra.adapter.v1")!;
    expect(JSON.parse(read_meta_value(db, "fate_extra.preview-search.adapter")!)).toEqual({
      format_version: 1,
      adapter_value: source_adapter_value,
    });
    const documents_before = db
      .prepare(`
        SELECT document_id, field, search_text
        FROM fate_extra_preview_search_document
        WHERE generation = 1
        ORDER BY document_id
      `)
      .all();
    const mappings_before = db
      .prepare(`
        SELECT item_id, occurrence_id, field, document_id
        FROM fate_extra_preview_search_mapping
        WHERE generation = 1
        ORDER BY item_id, occurrence_id, field, document_id
      `)
      .all();

    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      UPDATE items
      SET data = json_set(
        data,
        '$.extra_field.__linguagacha_fe_v1.display_mode',
        'poem'
      )
      WHERE id = 1
    `).run();
    write_items_revision(db, 1);
    expect(advance_fate_extra_preview_index_revision(db, 0, 1)).toBe(true);
    db.exec("COMMIT");

    expect(read_fate_extra_index_state(db)).toMatchObject({
      ready: true,
      search_items_revision: 1,
      navigation_items_revision: 1,
      text_unit_items_revision: 1,
    });
    expect(
      db
        .prepare(`
          SELECT document_id, field, search_text
          FROM fate_extra_preview_search_document
          WHERE generation = 1
          ORDER BY document_id
        `)
        .all(),
    ).toEqual(documents_before);
    expect(
      db
        .prepare(`
          SELECT item_id, occurrence_id, field, document_id
          FROM fate_extra_preview_search_mapping
          WHERE generation = 1
          ORDER BY item_id, occurrence_id, field, document_id
        `)
        .all(),
    ).toEqual(mappings_before);
    db.close();
  });

  it("无格式身份的旧 generation 不能被激活或增量写入认证", () => {
    const project_path = create_project("legacy-format");
    build_and_activate(project_path, 0);

    const db = new DatabaseSync(project_path);
    const adapter_value = read_meta_value(db, "fate_extra.adapter.v1")!;
    db.prepare(
      "UPDATE fate_extra_preview_search_generation SET adapter_value = ? WHERE generation = 1",
    ).run(adapter_value);
    db.prepare(
      "UPDATE fate_extra_preview_navigation_generation SET adapter_value = ? WHERE generation = 1",
    ).run(adapter_value);
    db.prepare("DELETE FROM meta WHERE key = ?").run(FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY);

    expect(read_fate_extra_preview_search_index_state(db).ready).toBe(false);
    expect(read_fate_extra_preview_navigation_state(db).ready).toBe(false);
    expect(() => activate_fate_extra_preview_search_generation(db, 1, 0, adapter_value)).toThrow(
      /activation_identity_changed/,
    );
    expect(read_meta_value(db, FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY)).toBeUndefined();

    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE items SET data = json_set(data, '$.dst', '新译文') WHERE id = 1").run();
    write_items_revision(db, 1);
    expect(refresh_fate_extra_preview_search_documents(db, [1])).toBe(false);
    expect(advance_fate_extra_preview_index_revision(db, 0, 1)).toBe(false);
    expect(advance_fate_extra_preview_navigation_revision(db, 1, 0, 1)).toBe(false);
    db.exec("COMMIT");

    expect(read_meta_value(db, FATE_EXTRA_PREVIEW_INDEX_FORMAT_META_KEY)).toBeUndefined();
    expect(
      db
        .prepare(`
          SELECT adapter_value, items_revision
          FROM fate_extra_preview_navigation_generation
          WHERE generation = 1
        `)
        .get(),
    ).toEqual({ adapter_value, items_revision: 0 });
    expect(FATE_EXTRA_PREVIEW_INDEX_FORMAT_VERSION).toBe(1);
    db.close();
  });

  it("硬终止遗留的已索引文档由清理任务定点移除且不破坏 active FTS", () => {
    const project_path = create_project("residual-cleanup");
    build_and_activate(project_path, 0);
    const staging = new DatabaseSync(project_path);
    const adapter_value = read_meta_value(staging, "fate_extra.adapter.v1")!;
    staging
      .prepare(`
        INSERT INTO fate_extra_preview_search_generation (
          generation, adapter_value, items_revision, item_count,
          document_count, short_gram_count, complete
        ) VALUES (2, ?, 0, 2, 0, 0, 0)
      `)
      .run(adapter_value);
    const document_id = Number(
      staging
        .prepare(`
          INSERT INTO fate_extra_preview_search_document (generation, field, search_text)
          VALUES (2, 'src', 'partial-residual')
        `)
        .run().lastInsertRowid,
    );
    staging
      .prepare("INSERT INTO fate_extra_preview_search_fts(rowid, search_text) VALUES (?, ?)")
      .run(document_id, "partial-residual");
    staging
      .prepare(`
        INSERT INTO fate_extra_preview_search_item (generation, item_id, unit_id, category)
        VALUES (2, 1, 1, '')
      `)
      .run();
    staging
      .prepare(`
        INSERT INTO fate_extra_preview_search_mapping (
          generation, item_id, occurrence_id, field, document_id
        ) VALUES (2, 1, 1, 'src', ?)
      `)
      .run(document_id);
    staging
      .prepare(`
        INSERT INTO fate_extra_preview_search_short_gram (generation, gram, document_id)
        VALUES (2, 'p', ?)
      `)
      .run(document_id);
    staging.close();

    expect(cleanup_fate_extra_inactive_preview_search_generations(project_path)).toBe(1);
    const db = new DatabaseSync(project_path, { readOnly: true });
    expect(
      db
        .prepare("SELECT generation FROM fate_extra_preview_search_generation ORDER BY generation")
        .all(),
    ).toEqual([{ generation: 1 }]);
    expect(
      db
        .prepare("SELECT rowid FROM fate_extra_preview_search_fts WHERE search_text MATCH ?")
        .all("partial"),
    ).toEqual([]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM fate_extra_preview_search_fts_docsize WHERE id = ?")
        .get(document_id)?.["count"],
    ).toBe(0);
    expect(
      db
        .prepare("SELECT rowid FROM fate_extra_preview_search_fts WHERE search_text MATCH ?")
        .all("月海原").length,
    ).toBeGreaterThan(0);
    db.close();
  });
});

function build_and_activate(project_path: string, items_revision: number): void {
  const build = run_fate_extra_index_maintenance(project_path, items_revision);
  const db = new DatabaseSync(project_path);
  activate_fate_extra_preview_search_generation(
    db,
    build.generation,
    build.items_revision,
    build.adapter_value,
  );
  db.close();
}

function create_project(
  name: string,
  items: readonly TestItem[] = [
    { id: 1, src: "月海原学园", dst: "校园", file_path: "route-a.txt" },
    { id: 3, src: "教会", dst: "Church", file_path: "route-b.txt" },
  ],
): string {
  temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), `linguagacha-fe-${name}-`));
  const project_path = path.join(temp_directory, `${name}.lg`);
  const database = new ProjectDatabase();
  database.execute({ name: "createProject", args: { projectPath: project_path, name } });
  database.execute({
    name: "setMeta",
    args: {
      projectPath: project_path,
      key: "fate_extra.adapter.v1",
      value: { enabled: true, schema_version: 1 },
    },
  });
  database.execute({
    name: "setItems",
    args: {
      projectPath: project_path,
      items: items.map((item) => ({
        ...item,
        status: item.status ?? "NONE",
        extra_field: {
          __linguagacha_fe_v1: {
            proofread_translation: "",
            display_mode: "auto",
            classification: { category: "ordinary_independent_slot" },
          },
        },
      })),
    },
  });
  database.close();
  return project_path;
}

function structurally_change_project(project_path: string, revision: number): void {
  const db = new DatabaseSync(project_path);
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE items SET data = json_set(data, '$.src', '结构已变化') WHERE id = 1").run();
  write_items_revision(db, revision);
  db.exec("COMMIT");
  db.close();
}

function write_items_revision(db: DatabaseSync, revision: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('project_runtime_revision.items', ?)",
  ).run(String(revision));
}

function read_meta_value(db: DatabaseSync, key: string): string | undefined {
  const value = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.["value"];
  return typeof value === "string" ? value : undefined;
}
