import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "./database-operations";
import {
  activate_fate_extra_preview_search_generation,
  cleanup_fate_extra_inactive_preview_search_generations,
  read_fate_extra_preview_search_index_state,
  refresh_fate_extra_preview_search_documents,
  run_fate_extra_index_maintenance,
} from "./fate-extra-preview-search-index";

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

function create_project(name: string): string {
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
      items: [
        { id: 1, src: "月海原学园", dst: "校园", file_path: "route-a.txt" },
        { id: 3, src: "教会", dst: "Church", file_path: "route-b.txt" },
      ].map((item) => ({
        ...item,
        status: "NONE",
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
