import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "../../database/database-operations";
import {
  run_fate_extra_preview_index_worker_task,
  run_fate_extra_preview_search_worker_task,
} from "./fate-extra-preview-worker-task";

let temp_directory = "";

afterEach(() => {
  if (temp_directory !== "") {
    fs.rmSync(temp_directory, { recursive: true, force: true });
    temp_directory = "";
  }
});

function activate_build(
  project_path: string,
  built: Record<string, unknown>,
): Record<string, unknown> {
  const database = new ProjectDatabase();
  const active = database.execute({
    name: "activateFateExtraPreviewSearchGeneration",
    args: {
      projectPath: project_path,
      generation: Number(built["built_generation"]),
      expectedItemsRevision: Number(built["built_items_revision"]),
      expectedAdapterValue: String(built["built_adapter_value"]),
    },
  }) as Record<string, unknown>;
  database.close();
  return { ...built, ...active };
}

function build_and_activate(
  project_path: string,
  expected_items_revision = 0,
): Record<string, unknown> {
  return activate_build(
    project_path,
    run_fate_extra_preview_index_worker_task({
      projectPath: project_path,
      expectedItemsRevision: expected_items_revision,
    }) as Record<string, unknown>,
  );
}

describe("fate-extra preview worker task", () => {
  const warning_metadata = (args: {
    path: string;
    char_offset: number;
    category?: string;
    capacity?: number | null;
    migration_review?: boolean;
  }) => ({
    __linguagacha_fe_v1: {
      schema_version: 1,
      path: args.path,
      char_offset: args.char_offset,
      original_prefix: "",
      source_hash: "",
      source_line_numbers: [],
      pass_through: [],
      migration_review: args.migration_review ?? false,
      migration_source: "",
      proofread_translation: "",
      display_mode: "dialogue",
      classification: {
        category: args.category ?? "ordinary_independent_slot",
        category_zh: "",
        confidence: "",
        reason: "",
        resource_path: args.path,
        byte_offset: null,
        source_bytes: null,
        slot_capacity: args.capacity ?? null,
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

  it("预览生产查询不再接受 OFFSET 分页", () => {
    const source = fs.readFileSync(
      path.resolve("src/backend/database/fate-extra-preview-readonly.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/\bOFFSET\b/u);
  });

  it("在独立连接重建索引并用派生投影搜索", () => {
    temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-preview-worker-"));
    const project_path = path.join(temp_directory, "preview.lg");
    const database = new ProjectDatabase();
    database.execute({
      name: "createProject",
      args: { projectPath: project_path, name: "preview" },
    });
    database.execute({
      name: "setMeta",
      args: {
        projectPath: project_path,
        key: "fate_extra.adapter.v1",
        value: { enabled: true, schema_version: 1, logical_text_count: 2 },
      },
    });
    database.execute({
      name: "setItems",
      args: {
        projectPath: project_path,
        items: [
          { id: 1, src: "月海原学园", dst: "校园", file_path: "route-a.txt" },
          { id: 2, src: "教会", dst: "Church", file_path: "route-b.txt" },
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

    expect(build_and_activate(project_path)).toMatchObject({
      ready: true,
      search_ready: true,
      search_generation: 1,
      built_generation: 1,
      built_items_revision: 0,
    });
    const result = run_fate_extra_preview_search_worker_task({
      projectPath: project_path,
      search: "月海原",
      filePath: "",
      category: "",
      position: 0,
      limit: 20,
      includeFiles: false,
      includeTotal: true,
      viewMode: "occurrence",
      expectedGeneration: 1,
      expectedItemsRevision: 0,
      expectedNavigationGeneration: 1,
      expectedNavigationRevision: 0,
    }) as Record<string, unknown>;

    expect(result["total"]).toBe(1);
    expect(result["items"]).toEqual([expect.objectContaining({ id: 1, src: "月海原学园" })]);
  });

  it("按 generation 位置跨越远距离分页并复用文件内位置", () => {
    temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-navigation-"));
    const project_path = path.join(temp_directory, "navigation.lg");
    const database = new ProjectDatabase();
    database.execute({
      name: "createProject",
      args: { projectPath: project_path, name: "navigation" },
    });
    database.execute({
      name: "setMeta",
      args: {
        projectPath: project_path,
        key: "fate_extra.adapter.v1",
        value: { enabled: true, schema_version: 1, logical_text_count: 260 },
      },
    });
    database.execute({
      name: "setItems",
      args: {
        projectPath: project_path,
        items: Array.from({ length: 260 }, (_, index) => ({
          id: index + 1,
          src: `原文${(index + 1).toString()}`,
          dst: "",
          file_path: index % 2 === 0 ? "route-a.txt" : "route-b.txt",
          row: index,
          status: "NONE",
          extra_field: warning_metadata({ path: "route.bin", char_offset: index }),
        })),
      },
    });
    database.close();
    expect(build_and_activate(project_path)).toMatchObject({
      navigation_ready: true,
      navigation_generation: 1,
      navigation_items_revision: 0,
    });

    const query = (position: number, filePath = "") =>
      run_fate_extra_preview_search_worker_task({
        projectPath: project_path,
        search: "",
        filePath,
        category: "",
        position,
        limit: 20,
        includeFiles: true,
        includeTotal: true,
        viewMode: "occurrence",
        expectedGeneration: 1,
        expectedItemsRevision: 0,
        expectedNavigationGeneration: 1,
        expectedNavigationRevision: 0,
      }) as Record<string, unknown>;
    expect(
      (query(240)["items"] as Array<Record<string, unknown>>).map((item) => item["id"]),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 241));
    const file_page = query(100, "route-b.txt");
    expect(file_page["total"]).toBe(130);
    expect(
      (file_page["items"] as Array<Record<string, unknown>>).slice(0, 3).map((item) => item["id"]),
    ).toEqual([202, 204, 206]);
    expect(file_page).toMatchObject({
      navigation_generation: 1,
      applied_navigation_revision: 0,
    });
  });

  it("只读查询不迁移工程，并按字段边界和 generation 身份复核", () => {
    temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-preview-readonly-"));
    const project_path = path.join(temp_directory, "readonly.lg");
    const database = new ProjectDatabase();
    database.execute({
      name: "createProject",
      args: { projectPath: project_path, name: "readonly" },
    });
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
          { id: 1, src: "abc", dst: "def", file_path: "route-a.txt" },
          { id: 2, src: "月海原", dst: "", file_path: "route-b.txt" },
          { id: 3, src: "İ", dst: "", file_path: "route-c.txt" },
          {
            id: 4,
            src: "#RUBS月#RUBEつき#REND\u0001終",
            dst: "",
            file_path: "route-d.txt",
          },
          { id: 5, src: "100%_完成", dst: "", file_path: "route-e.txt" },
          { id: 6, src: '引"号_%终', dst: "", file_path: "route-f.txt" },
          { id: 7, src: "a\\b_c%终", dst: "", file_path: "route-g.txt" },
        ].map((item) => ({
          ...item,
          status: "NONE",
          extra_field: {
            __linguagacha_fe_v1: {
              proofread_translation: "",
              classification: { category: "ordinary_independent_slot" },
            },
          },
        })),
      },
    });
    database.close();
    build_and_activate(project_path);

    const writable = new DatabaseSync(project_path);
    writable.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
    writable.close();
    const query = (text: string): Record<string, unknown> =>
      run_fate_extra_preview_search_worker_task({
        projectPath: project_path,
        search: text,
        filePath: "",
        category: "",
        position: 0,
        limit: 20,
        includeFiles: false,
        includeTotal: true,
        viewMode: "occurrence",
        expectedGeneration: 1,
        expectedItemsRevision: 0,
        expectedNavigationGeneration: 1,
        expectedNavigationRevision: 0,
      }) as Record<string, unknown>;
    const search = (text: string): number[] =>
      (query(text)["items"] as Array<Record<string, unknown>>).map((item) => Number(item["id"]));
    expect(search("c\nd")).toEqual([]);
    expect(search("ABC")).toEqual([1]);
    expect(search("DEF")).toEqual([1]);
    expect(search("ROUTE-A.TXT")).toEqual([1]);
    expect(search("月")).toEqual([2, 4]);
    expect(query("月")["total"]).toBe(2);
    expect(search("月海")).toEqual([2]);
    expect(search("月海原")).toEqual([2]);
    expect(search("i\u0307")).toEqual([3]);
    expect(search("#RUBS月")).toEqual([4]);
    expect(search("\u0001終")).toEqual([4]);
    expect(search("100%_")).toEqual([5]);
    expect(search('"号_%')).toEqual([6]);
    expect(search("a\\b_")).toEqual([7]);

    const readonly = new DatabaseSync(project_path, { readOnly: true });
    expect(
      readonly.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.["value"],
    ).toBe("6");
    const plan = readonly
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT mapping.item_id
        FROM fate_extra_preview_search_mapping AS mapping
        JOIN fate_extra_preview_search_document AS document
          ON document.document_id = mapping.document_id
        JOIN fate_extra_preview_search_fts AS search_fts
          ON search_fts.rowid = mapping.document_id
        WHERE mapping.generation = 1
          AND search_fts.search_text MATCH '"月海原"'
          AND INSTR(document.search_text, '月海原') > 0
      `)
      .all()
      .map((row) => String(row["detail"] ?? ""));
    expect(plan.join("\n")).toMatch(/search_fts VIRTUAL TABLE INDEX .*M/iu);
    expect(plan.join("\n")).not.toMatch(/SCAN (?:items|filtered_item)\b/iu);
    readonly.close();

    const changed = new DatabaseSync(project_path);
    changed
      .prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('project_runtime_revision.items', '1')",
      )
      .run();
    changed.close();
    expect(() => search("月海原")).toThrow(/identity_changed/);
    expect(() =>
      run_fate_extra_preview_index_worker_task({
        projectPath: project_path,
        expectedItemsRevision: 0,
      }),
    ).toThrow(/revision_changed/);
    const after_conflict = new DatabaseSync(project_path, { readOnly: true });
    expect(
      after_conflict
        .prepare("SELECT value FROM meta WHERE key = 'fate_extra.preview-search.generation'")
        .get()?.["value"],
    ).toBe("1");
    after_conflict.close();

    const staged = new DatabaseSync(project_path);
    staged
      .prepare("UPDATE meta SET value = '0' WHERE key = 'project_runtime_revision.items'")
      .run();
    const adapter_value = String(
      staged.prepare("SELECT value FROM meta WHERE key = 'fate_extra.adapter.v1'").get()?.[
        "value"
      ] ?? "",
    );
    staged
      .prepare(`
        INSERT INTO fate_extra_preview_search_generation (
          generation, adapter_value, items_revision, item_count,
          document_count, short_gram_count, complete
        ) VALUES (99, ?, 0, 7, 0, 0, 0)
      `)
      .run(adapter_value);
    staged.close();
    expect(search("月海原")).toEqual([2]);
    const rebuilt = run_fate_extra_preview_index_worker_task({
      projectPath: project_path,
      expectedItemsRevision: 0,
    }) as Record<string, unknown>;
    expect(rebuilt).toMatchObject({ built_generation: 100, built_items_revision: 0 });
    expect(search("月海原")).toEqual([2]);
    const generations = new DatabaseSync(project_path, { readOnly: true });
    expect(
      generations
        .prepare(
          "SELECT generation, complete FROM fate_extra_preview_search_generation ORDER BY generation",
        )
        .all(),
    ).toEqual([
      { generation: 1, complete: 1 },
      { generation: 100, complete: 1 },
    ]);
    generations.close();
    expect(activate_build(project_path, rebuilt)).toMatchObject({
      search_generation: 100,
      search_ready: true,
    });
  });

  it("在第 121 条以后才出现 warning 时仍返回精确 total 和可达分页", () => {
    temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-warning-page-"));
    const project_path = path.join(temp_directory, "warning-page.lg");
    const database = new ProjectDatabase();
    database.execute({
      name: "createProject",
      args: { projectPath: project_path, name: "warning-page" },
    });
    database.execute({
      name: "setMeta",
      args: {
        projectPath: project_path,
        key: "fate_extra.adapter.v1",
        value: { enabled: true, schema_version: 1, logical_text_count: 130 },
      },
    });
    database.execute({
      name: "setItems",
      args: {
        projectPath: project_path,
        items: Array.from({ length: 130 }, (_, index) => ({
          id: index + 1,
          src: `原文${index + 1}`,
          dst: "短文",
          file_path: "route.txt",
          row: index,
          status: "NONE",
          extra_field: warning_metadata({
            path: "route.bin",
            char_offset: index,
            migration_review: index === 129,
          }),
        })),
      },
    });
    database.close();
    build_and_activate(project_path);

    const result = run_fate_extra_preview_search_worker_task({
      projectPath: project_path,
      search: "",
      filePath: "",
      category: "",
      warning: "FE_MIGRATION_REVIEW",
      position: 0,
      limit: 120,
      includeFiles: false,
      includeTotal: true,
      viewMode: "occurrence",
      expectedGeneration: 1,
      expectedItemsRevision: 0,
      expectedNavigationGeneration: 1,
      expectedNavigationRevision: 0,
    }) as Record<string, unknown>;

    expect(result["total"]).toBe(1);
    expect(result["items"]).toEqual([
      expect.objectContaining({ id: 130, fe_warning_codes: ["FE_MIGRATION_REVIEW"] }),
    ]);
  });

  it("在 worker 内以统一语义精确筛选四类 warning", () => {
    temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-warning-kinds-"));
    const project_path = path.join(temp_directory, "warning-kinds.lg");
    const database = new ProjectDatabase();
    database.execute({
      name: "createProject",
      args: { projectPath: project_path, name: "warning-kinds" },
    });
    database.execute({
      name: "setMeta",
      args: {
        projectPath: project_path,
        key: "fate_extra.adapter.v1",
        value: { enabled: true, schema_version: 1, logical_text_count: 5 },
      },
    });
    database.execute({
      name: "setItems",
      args: {
        projectPath: project_path,
        items: [
          {
            id: 1,
            dst: "甲".repeat(21),
            extra_field: warning_metadata({ path: "a", char_offset: 1 }),
          },
          {
            id: 2,
            dst: "AB",
            extra_field: warning_metadata({ path: "b", char_offset: 2, capacity: 1 }),
          },
          {
            id: 3,
            dst: "短文",
            extra_field: warning_metadata({
              path: "c",
              char_offset: 3,
              category: "unresolved_candidate",
            }),
          },
          {
            id: 4,
            dst: "短文",
            extra_field: warning_metadata({ path: "d", char_offset: 4, migration_review: true }),
          },
          {
            id: 5,
            dst: "Ω",
            extra_field: warning_metadata({ path: "e", char_offset: 5, capacity: 1 }),
          },
        ].map((item) => ({
          ...item,
          src: "原文",
          file_path: "route.txt",
          row: item.id,
          status: "NONE",
        })),
      },
    });
    database.close();
    build_and_activate(project_path);

    const warning_items = (warning: string, encodedWidths: Array<[string, number]> = []) => {
      const result = run_fate_extra_preview_search_worker_task({
        projectPath: project_path,
        search: "",
        filePath: "",
        category: "",
        warning,
        encodedWidths,
        position: 0,
        limit: 20,
        includeFiles: false,
        includeTotal: true,
        viewMode: "occurrence",
        expectedGeneration: 1,
        expectedItemsRevision: 0,
        expectedNavigationGeneration: 1,
        expectedNavigationRevision: 0,
      }) as Record<string, unknown>;
      expect(result["total"]).toBe(1);
      return (result["items"] as Array<Record<string, unknown>>).map((item) => item["id"]);
    };
    expect(warning_items("FE_PSP_OVERFLOW")).toEqual([1]);
    expect(warning_items("FE_STORAGE_CAPACITY", [["Ω", 1]])).toEqual([2]);
    expect(warning_items("FE_SAFETY_BLOCKER")).toEqual([3]);
    expect(warning_items("FE_MIGRATION_REVIEW")).toEqual([4]);
  });

  it("compact warning 按物理 occurrence 计算并在 unique 视图聚合", () => {
    temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-warning-compact-"));
    const source_path = path.join(temp_directory, "source.lg");
    const compact_path = path.join(temp_directory, "compact.lg");
    const database = new ProjectDatabase();
    database.execute({ name: "createProject", args: { projectPath: source_path, name: "source" } });
    database.execute({
      name: "setMeta",
      args: {
        projectPath: source_path,
        key: "fate_extra.adapter.v1",
        value: { enabled: true, schema_version: 1, logical_text_count: 2 },
      },
    });
    database.execute({
      name: "setItems",
      args: {
        projectPath: source_path,
        items: [10, 200].map((capacity, index) => ({
          id: index + 1,
          src: "同文",
          dst: "AB",
          file_path: `route-${index + 1}.txt`,
          row: index,
          status: "NONE",
          extra_field: warning_metadata({
            path: `route-${index + 1}.bin`,
            char_offset: index,
            capacity: index === 0 ? capacity : 1,
          }),
        })),
      },
    });
    database.execute({
      name: "createFateExtraCompactProject",
      args: { projectPath: source_path, targetProjectPath: compact_path, name: "compact" },
    });
    database.close();
    build_and_activate(compact_path);

    const query = (viewMode: "unique" | "occurrence") =>
      run_fate_extra_preview_search_worker_task({
        projectPath: compact_path,
        search: "",
        filePath: "",
        category: "",
        warning: "FE_STORAGE_CAPACITY",
        position: 0,
        limit: 20,
        includeFiles: false,
        includeTotal: true,
        viewMode,
        expectedGeneration: 1,
        expectedItemsRevision: 0,
        expectedNavigationGeneration: 1,
        expectedNavigationRevision: 0,
      }) as Record<string, unknown>;
    expect(query("occurrence")).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ fe_physical_occurrence_id: 2 })],
    });
    expect(query("unique")).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ fe_warning_codes: ["FE_STORAGE_CAPACITY"] })],
    });
  });
});
