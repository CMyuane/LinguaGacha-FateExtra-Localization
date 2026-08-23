import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppPathService } from "../app/app-path-service";
import { ProjectDatabase } from "../database/database-operations";
import type { DatabaseJsonValue } from "../database/database-types";
import type { ProjectOperationGate } from "../project/project-gate";
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import type { BackendWorkerClient } from "../worker/worker-client";
import { capture_stable_sqlite_fingerprints } from "../database/fate-extra-compact-export-database";
import {
  run_fate_extra_export_worker_task,
  type FateExtraExportWorkerTaskInput,
  type FateExtraFontCorpusSync,
} from "../worker/tasks/fate-extra-compact-export-worker-task";
import { NativeFs } from "../../native/native-fs";
import type { FateExtraFontService } from "./fate-extra-font-service";
import { FateExtraService } from "./fate-extra-service";

type ExportRow = Record<string, unknown>;

let temp_directory = "";
let classification_database = "";
const test_font_build_input = {
  baseline_dir: "test-baseline",
  font_path: "test-font",
  helper_executable: "test-helper",
  helper_source: "test-helper.py",
  helper_working_directory: "test-root",
};
const test_font_sync: FateExtraFontCorpusSync = (corpus, output_directory, _input, native_fs) => {
  native_fs.make_dir(output_directory);
  native_fs.write_file_sync(path.join(output_directory, "font-manifest.json"), "{}\n");
  return {
    corpus_sha256: corpus.corpus_sha256,
    manifest_sha256: "manifest",
    remaining_extension_slots: 7,
  };
};

beforeEach(() => {
  temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-compact-export-"));
  classification_database = path.join(temp_directory, "classification.sqlite");
  create_classification_database(classification_database, [
    ["route/a.dat", 10, "原文甲"],
    ["route/a.dat", 20, "原文甲"],
    ["route/a.dat", 40, "原文乙"],
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp_directory, { recursive: true, force: true });
});

describe("Fate/Extra compact export", () => {
  it("专用 worker 以游标跨过 ID 空洞并直接生成完整 staging", async () => {
    const staging_directory = path.join(temp_directory, "worker-stage");
    fs.mkdirSync(staging_directory, { recursive: true });
    const rows = build_rows();
    const cursors: number[] = [];
    const database = create_worker_database(rows, cursors);

    const result = await run_fate_extra_export_worker_task(
      build_worker_input(staging_directory, rows.length),
      undefined,
      new NativeFs(),
      database as unknown as ProjectDatabase,
      test_font_sync,
    );

    expect(cursors).toEqual([0, 20, 40]);
    expect(fs.readFileSync(path.join(staging_directory, "route.txt"), "utf-8")).toBe(
      "\uFEFF译文甲\r\n译文甲\r\n译文乙\r\n",
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(staging_directory, "fate-extra-qa-report.json"), "utf-8"),
      ),
    ).toMatchObject({ schema_version: 1, compact_export: true, warning_count: 0 });
    expect(fs.readFileSync(path.join(staging_directory, "fate-extra-qa-report.csv"), "utf-8")).toBe(
      '"file_path","row_number","path","char_offset","warning","message"\r\n',
    );
    expect(result).toMatchObject({ exported_count: 3, output_files: ["route.txt"] });
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("专用 worker writer 中途失败时关闭全部句柄", async () => {
    const staging_directory = path.join(temp_directory, "worker-write-failure");
    fs.mkdirSync(staging_directory, { recursive: true });
    const native_fs = new CompactWriterFailureNativeFs();
    const database = create_worker_database(build_rows(), []);

    await expect(
      run_fate_extra_export_worker_task(
        build_worker_input(staging_directory, 3),
        undefined,
        native_fs,
        database as unknown as ProjectDatabase,
        test_font_sync,
      ),
    ).rejects.toThrow("injected compact writer failure");

    expect(() => fs.rmSync(staging_directory, { recursive: true, force: true })).not.toThrow();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("专用 worker 在发布前拒绝迟到的 project revision", async () => {
    const staging_directory = path.join(temp_directory, "worker-revision-conflict");
    fs.mkdirSync(staging_directory, { recursive: true });
    let meta_reads = 0;
    const database = create_worker_database(build_rows(), [], () => {
      meta_reads += 1;
      return meta_reads === 1 ? revision_record(1, 2, 3, 4) : revision_record(1, 9, 3, 4);
    });

    await expect(
      run_fate_extra_export_worker_task(
        build_worker_input(staging_directory, 3),
        undefined,
        new NativeFs(),
        database as unknown as ProjectDatabase,
        test_font_sync,
      ),
    ).rejects.toThrow("items revision 已变化");
  });

  it("专用 worker 检测导出期间 WAL 内容变化", async () => {
    const staging_directory = path.join(temp_directory, "worker-wal-conflict");
    fs.mkdirSync(staging_directory, { recursive: true });
    const writer = new DatabaseSync(classification_database);
    const database = create_worker_database(build_rows(), []);
    let changed = false;
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      await expect(
        run_fate_extra_export_worker_task(
          build_worker_input(staging_directory, 3),
          (progress) => {
            if (!changed && progress.phase === "compact-export-items" && progress.completed === 3) {
              changed = true;
              writer.exec(
                "BEGIN IMMEDIATE; UPDATE entries SET reason = 'changed-in-wal' WHERE char_offset = 10; COMMIT;",
              );
            }
          },
          new NativeFs(),
          database as unknown as ProjectDatabase,
          test_font_sync,
        ),
      ).rejects.toThrow("主库、WAL 或 SHM 已变化");
    } finally {
      writer.close();
    }
    expect(changed).toBe(true);
  });

  it("分类库输入身份覆盖主库、WAL 与 SHM", async () => {
    const database = new DatabaseSync(classification_database);
    try {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec(
        "BEGIN IMMEDIATE; UPDATE entries SET reason = 'wal-visible' WHERE char_offset = 10; COMMIT;",
      );
      expect(fs.existsSync(`${classification_database}-wal`)).toBe(true);
      expect(fs.existsSync(`${classification_database}-shm`)).toBe(true);

      const fingerprints = await capture_stable_sqlite_fingerprints(classification_database);

      expect(fingerprints.map((fingerprint) => fingerprint.path)).toEqual([
        classification_database,
        `${classification_database}-wal`,
        `${classification_database}-shm`,
      ]);

      const staging_directory = path.join(temp_directory, "worker-stable-wal");
      fs.mkdirSync(staging_directory, { recursive: true });
      await expect(
        run_fate_extra_export_worker_task(
          build_worker_input(staging_directory, 3),
          undefined,
          new NativeFs(),
          create_worker_database(build_rows(), []) as unknown as ProjectDatabase,
          test_font_sync,
        ),
      ).resolves.toMatchObject({ exported_count: 3 });
    } finally {
      database.close();
    }
  });

  it("以主键游标逐页生成并在成功后一次发布兼容格式", async () => {
    const output_directory = path.join(temp_directory, "output");
    fs.mkdirSync(output_directory, { recursive: true });
    fs.writeFileSync(path.join(output_directory, "stale.txt"), "旧目录残留", "utf-8");
    const rows = build_rows();
    const { service, database, write_store, compact_export_worker } = create_service(rows);
    const append_sync = vi.spyOn(fs, "appendFileSync");

    const result = await service.export_project({
      project_path: path.join(temp_directory, "compact.lg"),
      output_directory,
    });

    expect(
      database.execute.mock.calls
        .map(([operation]) => operation)
        .filter((operation) => operation.name === "getFateExtraCompactExportPage"),
    ).toEqual([]);
    expect(compact_export_worker.run).toHaveBeenCalledOnce();
    expect(append_sync).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(output_directory, "route.txt"), "utf-8")).toBe(
      "\uFEFF译文甲\r\n译文甲\r\n译文乙\r\n",
    );
    expect(JSON.parse(fs.readFileSync(String(result["qa_report"]), "utf-8"))).toMatchObject({
      schema_version: 1,
      compact_export: true,
      warning_count: 0,
      blocker_count: 0,
      warnings: [],
    });
    const safety_manifest = JSON.parse(
      fs.readFileSync(String(result["safety_manifest"]), "utf-8"),
    ) as { entries: unknown[] } & Record<string, unknown>;
    expect(safety_manifest).toMatchObject({
      schema_version: 1,
      compact_export: true,
      entry_count: 3,
      blocker_count: 0,
    });
    expect(safety_manifest.entries).toHaveLength(3);
    expect(safety_manifest.entries[0]).toMatchObject({ path: "route/a.dat", char_offset: 10 });
    expect(result).toMatchObject({
      accepted: true,
      compact_export: true,
      exported_count: 3,
      output_files: [path.join(output_directory, "route.txt")],
    });
    expect(write_store.apply_project_settings_meta).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(output_directory, "stale.txt"))).toBe(false);
    expect(fs.readdirSync(temp_directory).some((name) => name.includes(".linguagacha-old-"))).toBe(
      false,
    );
    expect(
      fs.readdirSync(temp_directory).filter((name) => name.startsWith(".linguagacha-fe-export-")),
    ).toEqual([]);
  });

  it("分页失败时清理临时产物且不覆盖既有输出", async () => {
    const output_directory = path.join(temp_directory, "output");
    fs.mkdirSync(output_directory, { recursive: true });
    const existing_output = path.join(output_directory, "route.txt");
    fs.writeFileSync(existing_output, "既有导出", "utf-8");
    fs.writeFileSync(path.join(output_directory, "old-only.txt"), "旧目录完整性", "utf-8");
    const { service, database, write_store } = create_service(build_rows(), true);

    await expect(
      service.export_project({
        project_path: path.join(temp_directory, "compact.lg"),
        output_directory,
      }),
    ).rejects.toThrow("模拟第二页读取失败");

    expect(fs.readFileSync(existing_output, "utf-8")).toBe("既有导出");
    expect(fs.readFileSync(path.join(output_directory, "old-only.txt"), "utf-8")).toBe(
      "旧目录完整性",
    );
    expect(fs.existsSync(path.join(output_directory, "fate-extra-qa-report.json"))).toBe(false);
    expect(write_store.apply_project_settings_meta).not.toHaveBeenCalled();
    expect(
      database.execute.mock.calls
        .map(([operation]) => operation)
        .filter((operation) => operation.name === "getFateExtraCompactExportPage"),
    ).toEqual([]);
    expect(
      fs.readdirSync(temp_directory).filter((name) => name.startsWith(".linguagacha-fe-export-")),
    ).toEqual([]);
  });

  it("adapter meta 写入失败时恢复既有输出并清理新产物", async () => {
    const output_directory = path.join(temp_directory, "output");
    fs.mkdirSync(output_directory, { recursive: true });
    const existing_output = path.join(output_directory, "route.txt");
    fs.writeFileSync(existing_output, "既有导出", "utf-8");
    const { service } = create_service(build_rows(), false, true);

    await expect(
      service.export_project({
        project_path: path.join(temp_directory, "compact.lg"),
        output_directory,
      }),
    ).rejects.toThrow("模拟 meta 写入失败");

    expect(fs.readFileSync(existing_output, "utf-8")).toBe("既有导出");
    expect(fs.existsSync(path.join(output_directory, "fate-extra-qa-report.json"))).toBe(false);
    expect(fs.readdirSync(output_directory).some((name) => name.endsWith(".backup"))).toBe(false);
  });

  it("目录级 staging 发布失败时原样恢复旧目录", async () => {
    const output_directory = path.join(temp_directory, "output");
    fs.mkdirSync(output_directory, { recursive: true });
    fs.writeFileSync(path.join(output_directory, "route.txt"), "既有导出", "utf-8");
    fs.writeFileSync(path.join(output_directory, "old-only.txt"), "旧目录完整性", "utf-8");
    const { service, write_store } = create_service(build_rows(), false, false, false, true);

    await expect(
      service.export_project({
        project_path: path.join(temp_directory, "compact.lg"),
        output_directory,
      }),
    ).rejects.toThrow("injected directory publication failure");

    expect(fs.readFileSync(path.join(output_directory, "route.txt"), "utf-8")).toBe("既有导出");
    expect(fs.readFileSync(path.join(output_directory, "old-only.txt"), "utf-8")).toBe(
      "旧目录完整性",
    );
    expect(write_store.apply_project_settings_meta).not.toHaveBeenCalled();
    expect(fs.readdirSync(temp_directory).some((name) => name.includes(".linguagacha-old-"))).toBe(
      false,
    );
  });

  it("分类库内容指纹变化时丢弃 staging 且不发布输出或 adapter meta", async () => {
    const output_directory = path.join(temp_directory, "output");
    const { service, write_store } = create_service(build_rows(), false, false, true);

    await expect(
      service.export_project({
        project_path: path.join(temp_directory, "compact.lg"),
        output_directory,
      }),
    ).rejects.toThrow("安全分类数据库主库、WAL 或 SHM 已变化");

    expect(fs.existsSync(output_directory)).toBe(false);
    expect(write_store.apply_project_settings_meta).not.toHaveBeenCalled();
    expect(
      fs.readdirSync(temp_directory).filter((name) => name.startsWith(".linguagacha-fe-export-")),
    ).toEqual([]);
  });
});

describe("Fate/Extra full export", () => {
  it("数据库普通导出页使用主键范围并跨过 ID 空洞", () => {
    const project_path = path.join(temp_directory, "full-keyset.lg");
    const project_database = new ProjectDatabase();
    try {
      project_database.execute({
        name: "createProject",
        args: { projectPath: project_path, name: "full-keyset" },
      });
      project_database.execute({
        name: "setItems",
        args: {
          projectPath: project_path,
          items: build_full_rows().map((row) => row["item"]) as DatabaseJsonValue,
        },
      });
      const first = project_database.execute({
        name: "getFateExtraFullExportPage",
        args: { projectPath: project_path, afterOriginalItemId: 0, limit: 2 },
      }) as { next_original_item_id: number; rows: ExportRow[] };
      expect(first.rows.map((row) => row["original_item_id"])).toEqual([10, 20]);
      expect(first.next_original_item_id).toBe(20);
      const second = project_database.execute({
        name: "getFateExtraFullExportPage",
        args: {
          projectPath: project_path,
          afterOriginalItemId: first.next_original_item_id,
          limit: 2,
        },
      }) as { next_original_item_id: number; rows: ExportRow[] };
      expect(second.rows.map((row) => row["original_item_id"])).toEqual([40]);
      const plan_database = new DatabaseSync(project_path, { readOnly: true });
      try {
        const plan = plan_database
          .prepare("EXPLAIN QUERY PLAN SELECT id, data FROM items WHERE id > ? ORDER BY id LIMIT ?")
          .all(0, 2)
          .map((row) => String(row["detail"] ?? ""))
          .join("\n");
        expect(plan).toContain("SEARCH items USING INTEGER PRIMARY KEY");
        expect(plan.toLocaleUpperCase()).not.toContain("OFFSET");
      } finally {
        plan_database.close();
      }
    } finally {
      project_database.close();
    }
  });

  it("专用 worker 以主键游标跨过 ID 空洞并保持普通导出字节格式", async () => {
    const staging_directory = path.join(temp_directory, "full-worker-stage");
    fs.mkdirSync(staging_directory, { recursive: true });
    const rows = build_full_rows();
    const cursors: number[] = [];
    const database = create_full_worker_database(rows, cursors);

    const result = await run_fate_extra_export_worker_task(
      build_full_worker_input(staging_directory, rows.length),
      undefined,
      new NativeFs(),
      database as unknown as ProjectDatabase,
      test_font_sync,
    );

    expect(cursors).toEqual([0, 20, 40]);
    expect(fs.readFileSync(path.join(staging_directory, "route.txt"), "utf-8")).toBe(
      "\uFEFF译文甲\r\n译文乙\r\n译文丙",
    );
    const qa_text = fs.readFileSync(
      path.join(staging_directory, "fate-extra-qa-report.json"),
      "utf-8",
    );
    const qa = JSON.parse(qa_text) as Record<string, unknown>;
    expect(Object.keys(qa)).toEqual([
      "schema_version",
      "exported_at",
      "mode",
      "warning_count",
      "blocker_count",
      "warnings",
      "font_manifest",
    ]);
    expect(qa_text).toBe(`${JSON.stringify(qa, null, 2)}\n`);
    expect(fs.readFileSync(path.join(staging_directory, "fate-extra-qa-report.csv"), "utf-8")).toBe(
      '"file_path","row_number","path","char_offset","warning","message"',
    );
    const safety_text = fs.readFileSync(
      path.join(staging_directory, "fate-extra-injection-safety.json"),
      "utf-8",
    );
    const safety = JSON.parse(safety_text) as Record<string, unknown>;
    expect(Object.keys(safety)).toEqual([
      "schema_version",
      "generated_at",
      "entry_count",
      "blocker_count",
      "entries",
    ]);
    expect(safety_text).toBe(`${JSON.stringify(safety, null, 2)}\n`);
    expect(result).toMatchObject({
      exported_count: 3,
      output_files: ["route.txt"],
      classification_fingerprints: [],
    });
    expect(database.close).toHaveBeenCalledOnce();
    expect(fs.readdirSync(staging_directory).some((name) => name.endsWith(".partial"))).toBe(false);
  });

  it("普通模式不依赖已经移动的外部分类库", async () => {
    const staging_directory = path.join(temp_directory, "full-without-classification");
    fs.mkdirSync(staging_directory, { recursive: true });
    const input = build_full_worker_input(staging_directory, 3);
    input.classificationDatabase = path.join(temp_directory, "missing-classification.sqlite");

    await expect(
      run_fate_extra_export_worker_task(
        input,
        undefined,
        new NativeFs(),
        create_full_worker_database(build_full_rows(), []) as unknown as ProjectDatabase,
        test_font_sync,
      ),
    ).resolves.toMatchObject({ exported_count: 3, classification_fingerprints: [] });
  });

  it("普通模式在发布前拒绝迟到 revision", async () => {
    const staging_directory = path.join(temp_directory, "full-revision-conflict");
    fs.mkdirSync(staging_directory, { recursive: true });
    let meta_reads = 0;
    const database = create_full_worker_database(build_full_rows(), [], () => {
      meta_reads += 1;
      return meta_reads === 1 ? revision_record(1, 2, 3, 4) : revision_record(1, 8, 3, 4);
    });

    await expect(
      run_fate_extra_export_worker_task(
        build_full_worker_input(staging_directory, 3),
        undefined,
        new NativeFs(),
        database as unknown as ProjectDatabase,
        test_font_sync,
      ),
    ).rejects.toThrow("items revision 已变化");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("拒绝越界与绝对路线路径", async () => {
    const malicious_paths = [
      path.join("..", "escape.txt"),
      path.resolve(temp_directory, "absolute-escape.txt"),
    ];
    for (const [index, malicious_path] of malicious_paths.entries()) {
      const staging_directory = path.join(temp_directory, `full-path-escape-${index.toString()}`);
      fs.mkdirSync(staging_directory, { recursive: true });
      const rows = build_full_rows();
      (rows[0]!["item"] as Record<string, unknown>)["file_path"] = malicious_path;
      await expect(
        run_fate_extra_export_worker_task(
          build_full_worker_input(staging_directory, rows.length),
          undefined,
          new NativeFs(),
          create_full_worker_database(rows, []) as unknown as ProjectDatabase,
          test_font_sync,
        ),
      ).rejects.toThrow(/必须是非空相对路径|越过输出目录/u);
    }
    const invalid_format_staging = path.join(temp_directory, "full-format-path-escape");
    fs.mkdirSync(invalid_format_staging, { recursive: true });
    const invalid_format_input = build_full_worker_input(invalid_format_staging, 3);
    invalid_format_input.adapter["file_formats"] = [
      {
        relative_path: path.join("..", "escaped-format.txt"),
        encoding: "utf-8",
        eol: "\n",
        trailing_eol: true,
      },
    ];
    await expect(
      run_fate_extra_export_worker_task(
        invalid_format_input,
        undefined,
        new NativeFs(),
        create_full_worker_database(build_full_rows(), []) as unknown as ProjectDatabase,
        test_font_sync,
      ),
    ).rejects.toThrow("越过输出目录");
    expect(fs.existsSync(path.join(temp_directory, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(temp_directory, "absolute-escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(temp_directory, "escaped-format.txt"))).toBe(false);
  });

  it("拒绝把文件系统根或项目文件作为输出目录", async () => {
    const root_service = create_full_service();
    await expect(
      root_service.service.export_project({
        project_path: path.join(temp_directory, "full.lg"),
        output_directory: path.parse(temp_directory).root,
      }),
    ).rejects.toMatchObject({
      public_details: { reason: "FE 导出目录不能是文件系统根目录。" },
    });
    await expect(
      root_service.service.export_project({
        project_path: path.join(temp_directory, "full.lg"),
        output_directory: path.join(temp_directory, "full.lg"),
      }),
    ).rejects.toMatchObject({
      public_details: { reason: "FE 导出目录不能与当前项目文件相同。" },
    });
    expect(root_service.export_worker.run).not.toHaveBeenCalled();
  });

  it("普通模式只替换拥有的文件并保留输出目录中的无关内容", async () => {
    const output_directory = path.join(temp_directory, "full-output");
    fs.mkdirSync(output_directory, { recursive: true });
    fs.writeFileSync(path.join(output_directory, "unrelated.txt"), "用户文件", "utf-8");
    fs.writeFileSync(path.join(output_directory, "route.txt"), "旧路线", "utf-8");
    const { service, database, write_store, export_worker } = create_full_service();

    const result = await service.export_project({
      project_path: path.join(temp_directory, "full.lg"),
      output_directory,
    });

    expect(fs.readFileSync(path.join(output_directory, "unrelated.txt"), "utf-8")).toBe("用户文件");
    expect(fs.readFileSync(path.join(output_directory, "route.txt"), "utf-8")).toBe("新路线");
    expect(result).not.toHaveProperty("compact_export");
    expect(export_worker.run).toHaveBeenCalledOnce();
    expect(write_store.apply_project_settings_meta).toHaveBeenCalledOnce();
    expect(database.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "getAllItems" }),
    );
  });

  it("普通 worker 失败时清理 staging 且保留既有输出", async () => {
    const output_directory = path.join(temp_directory, "full-failed-output");
    fs.mkdirSync(output_directory, { recursive: true });
    fs.writeFileSync(path.join(output_directory, "route.txt"), "旧路线", "utf-8");
    const { service, write_store } = create_full_service(true);

    await expect(
      service.export_project({
        project_path: path.join(temp_directory, "full.lg"),
        output_directory,
      }),
    ).rejects.toThrow("模拟普通导出 worker 失败");

    expect(fs.readFileSync(path.join(output_directory, "route.txt"), "utf-8")).toBe("旧路线");
    expect(write_store.apply_project_settings_meta).not.toHaveBeenCalled();
    expect(
      fs.readdirSync(temp_directory).filter((name) => name.startsWith(".linguagacha-fe-export-")),
    ).toEqual([]);
  });

  it("普通 adapter meta 失败时逐项回滚且保留无关文件", async () => {
    const output_directory = path.join(temp_directory, "full-meta-failed-output");
    fs.mkdirSync(output_directory, { recursive: true });
    fs.writeFileSync(path.join(output_directory, "route.txt"), "旧路线", "utf-8");
    fs.writeFileSync(path.join(output_directory, "unrelated.txt"), "用户文件", "utf-8");
    const { service } = create_full_service(false, true);

    await expect(
      service.export_project({
        project_path: path.join(temp_directory, "full.lg"),
        output_directory,
      }),
    ).rejects.toThrow("模拟普通 meta 写入失败");

    expect(fs.readFileSync(path.join(output_directory, "route.txt"), "utf-8")).toBe("旧路线");
    expect(fs.readFileSync(path.join(output_directory, "unrelated.txt"), "utf-8")).toBe("用户文件");
    expect(fs.readdirSync(temp_directory).some((name) => name.includes("fe-export-old"))).toBe(
      false,
    );
  });
});

function create_service(
  rows: ExportRow[],
  fail_second_page = false,
  fail_meta_write = false,
  fail_classification_fingerprint = false,
  fail_directory_publish = false,
): {
  service: FateExtraService;
  database: { execute: ReturnType<typeof vi.fn> };
  write_store: { apply_project_settings_meta: ReturnType<typeof vi.fn> };
  native_fs: NativeFs;
  compact_export_worker: { run: ReturnType<typeof vi.fn> };
} {
  const project_path = path.join(temp_directory, "compact.lg");
  const meta = {
    "project_runtime_revision.files": 1,
    "project_runtime_revision.items": 2,
    "project_runtime_revision.analysis": 3,
    "proofreading_revision.proofreading": 4,
    "fate_extra.adapter.v1": {
      enabled: true,
      schema_version: 1,
      classification_database,
      file_formats: [
        {
          relative_path: "route.txt",
          encoding: "utf-8-bom",
          eol: "\r\n",
          trailing_eol: true,
        },
      ],
    },
  };
  const database = {
    execute: vi.fn((operation: { name: string; args?: Record<string, unknown> }) => {
      if (operation.name === "getAllMeta") return meta;
      if (operation.name === "getFateExtraCompactState") {
        return { enabled: true, physical_item_count: rows.length };
      }
      if (operation.name === "getAllItems") {
        return [rows[0]?.["compact_item"], rows.at(-1)?.["compact_item"]];
      }
      if (operation.name === "getFateExtraCompactExportPage") {
        const cursor = Number(operation.args?.["afterOriginalItemId"] ?? 0);
        if (fail_second_page && cursor === 20) throw new Error("模拟第二页读取失败");
        const page_rows = rows
          .filter((row) => Number(row["original_item_id"]) > cursor)
          .slice(0, 2);
        return {
          after_original_item_id: cursor,
          next_original_item_id:
            page_rows.length === 0
              ? cursor
              : Number(page_rows[page_rows.length - 1]?.["original_item_id"]),
          rows: page_rows,
        };
      }
      return [];
    }),
  };
  const session_state = {
    snapshot: vi.fn(() => ({ loaded: true, projectPath: project_path })),
  };
  const native_fs = fail_directory_publish ? new CompactPublishFailureNativeFs() : new NativeFs();
  const font_service = {
    measure_encoded_bytes: vi.fn((text: string) => Buffer.byteLength(text, "utf-8")),
    read_encoded_width_snapshot: vi.fn(() => []),
    read_worker_build_input: vi.fn(() => test_font_build_input),
  };
  const write_store = {
    apply_project_settings_meta: vi.fn(async () => {
      if (fail_meta_write) throw new Error("模拟 meta 写入失败");
      return { accepted: true };
    }),
  };
  const compact_export_worker = {
    run: vi.fn(async (task: { input: { stagingDirectory: string } }) => {
      if (fail_second_page) throw new Error("模拟第二页读取失败");
      if (fail_classification_fingerprint) {
        throw new Error("安全分类数据库主库、WAL 或 SHM 已变化，请重新导出。");
      }
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "route.txt"),
        "\uFEFF译文甲\r\n译文甲\r\n译文乙\r\n",
      );
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "fate-extra-qa-report.json"),
        '{"schema_version":1,"compact_export":true,"warnings":[],"warning_count":0,"blocker_count":0}\n',
      );
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "fate-extra-qa-report.csv"),
        '"file_path","row_number","path","char_offset","warning","message"\r\n',
      );
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "fate-extra-injection-safety.json"),
        '{"schema_version":1,"compact_export":true,"entries":[{"path":"route/a.dat","char_offset":10},{},{}],"entry_count":3,"blocker_count":0}\n',
      );
      return {
        output_files: ["route.txt"],
        qa_report: "fate-extra-qa-report.json",
        qa_report_csv: "fate-extra-qa-report.csv",
        safety_manifest: "fate-extra-injection-safety.json",
        warning_count: 0,
        blocker_count: 0,
        exported_count: rows.length,
        font_manifest: {
          corpus_sha256: "corpus",
          manifest_sha256: "manifest",
          remaining_extension_slots: 7,
        },
        classification_fingerprints: [],
      };
    }),
  };
  const service = new FateExtraService(
    {} as AppPathService,
    database as unknown as ProjectDatabase,
    session_state as unknown as ProjectSessionState,
    {
      run_exclusive_project_write: async (work: () => Promise<unknown>) => await work(),
    } as unknown as ProjectOperationGate,
    write_store as unknown as ProjectWriteStore,
    font_service as unknown as FateExtraFontService,
    native_fs,
    {
      scanApply: { run: vi.fn() } as unknown as BackendWorkerClient,
      export: compact_export_worker as unknown as BackendWorkerClient,
      index: { run: vi.fn() } as unknown as BackendWorkerClient,
      preview: { run: vi.fn() } as unknown as BackendWorkerClient,
    },
  );
  return { service, database, write_store, native_fs, compact_export_worker };
}

function create_full_service(
  fail_worker = false,
  fail_meta_write = false,
): {
  service: FateExtraService;
  database: { execute: ReturnType<typeof vi.fn> };
  write_store: { apply_project_settings_meta: ReturnType<typeof vi.fn> };
  export_worker: { run: ReturnType<typeof vi.fn> };
} {
  const project_path = path.join(temp_directory, "full.lg");
  const meta = {
    "project_runtime_revision.files": 1,
    "project_runtime_revision.items": 2,
    "project_runtime_revision.analysis": 3,
    "proofreading_revision.proofreading": 4,
    "fate_extra.adapter.v1": {
      enabled: true,
      schema_version: 1,
      logical_text_count: 3,
      file_formats: [
        { relative_path: "route.txt", encoding: "utf-8", eol: "\n", trailing_eol: false },
      ],
    },
  };
  const database = {
    execute: vi.fn((operation: { name: string }) => {
      if (operation.name === "getAllMeta") return meta;
      if (operation.name === "getFateExtraCompactState") return { enabled: false };
      if (operation.name === "getAllItems") throw new Error("主进程不得读取普通工程全部 items");
      return [];
    }),
  };
  const native_fs = new NativeFs();
  const write_store = {
    apply_project_settings_meta: vi.fn(async () => {
      if (fail_meta_write) throw new Error("模拟普通 meta 写入失败");
      return { accepted: true };
    }),
  };
  const export_worker = {
    run: vi.fn(async (task: { input: { stagingDirectory: string; projectMode: string } }) => {
      expect(task.input.projectMode).toBe("full");
      if (fail_worker) throw new Error("模拟普通导出 worker 失败");
      native_fs.write_file_sync(path.join(task.input.stagingDirectory, "route.txt"), "新路线");
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "fate-extra-qa-report.json"),
        "{}\n",
      );
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "fate-extra-qa-report.csv"),
        '"file_path","row_number","path","char_offset","warning","message"',
      );
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "fate-extra-injection-safety.json"),
        "{}\n",
      );
      native_fs.write_file_sync(
        path.join(task.input.stagingDirectory, "fate-extra-font", "NPJH50247", "manifest.json"),
        "{}\n",
      );
      return {
        output_files: ["route.txt"],
        qa_report: "fate-extra-qa-report.json",
        qa_report_csv: "fate-extra-qa-report.csv",
        safety_manifest: "fate-extra-injection-safety.json",
        warning_count: 0,
        blocker_count: 0,
        exported_count: 3,
        font_manifest: {
          corpus_sha256: "full-corpus",
          manifest_sha256: "full-manifest",
          remaining_extension_slots: 7,
        },
        classification_fingerprints: [],
      };
    }),
  };
  const service = new FateExtraService(
    {} as AppPathService,
    database as unknown as ProjectDatabase,
    {
      snapshot: vi.fn(() => ({ loaded: true, projectPath: project_path })),
    } as unknown as ProjectSessionState,
    {
      run_exclusive_project_write: async (work: () => Promise<unknown>) => await work(),
    } as unknown as ProjectOperationGate,
    write_store as unknown as ProjectWriteStore,
    {
      read_encoded_width_snapshot: vi.fn(() => []),
      read_worker_build_input: vi.fn(() => test_font_build_input),
    } as unknown as FateExtraFontService,
    native_fs,
    {
      scanApply: { run: vi.fn() } as unknown as BackendWorkerClient,
      export: export_worker as unknown as BackendWorkerClient,
      index: { run: vi.fn() } as unknown as BackendWorkerClient,
      preview: { run: vi.fn() } as unknown as BackendWorkerClient,
    },
  );
  return { service, database, write_store, export_worker };
}

function build_full_worker_input(
  staging_directory: string,
  expected_count: number,
): FateExtraExportWorkerTaskInput {
  return {
    projectPath: path.join(temp_directory, "full.lg"),
    stagingDirectory: staging_directory,
    classificationDatabase: "",
    projectMode: "full",
    restoreIndex: false,
    adapter: {
      file_formats: [
        {
          relative_path: "route.txt",
          encoding: "utf-8-bom",
          eol: "\r\n",
          trailing_eol: false,
        },
      ],
    },
    expectedItemCount: expected_count,
    guardedRevisions: { files: 1, items: 2, analysis: 3, proofreading: 4 },
    fontBuildInput: test_font_build_input,
    encodedWidths: [],
  };
}

function create_full_worker_database(
  rows: ExportRow[],
  cursors: number[],
  read_revisions: () => Record<string, number> = () => revision_record(1, 2, 3, 4),
) {
  return {
    execute: vi.fn((operation: { name: string; args?: Record<string, unknown> }) => {
      if (operation.name === "getAllMeta") {
        const revisions = read_revisions();
        return {
          "project_runtime_revision.files": revisions["files"],
          "project_runtime_revision.items": revisions["items"],
          "project_runtime_revision.analysis": revisions["analysis"],
          "proofreading_revision.proofreading": revisions["proofreading"],
        };
      }
      if (operation.name !== "getFateExtraFullExportPage") return [];
      const cursor = Number(operation.args?.["afterOriginalItemId"] ?? 0);
      cursors.push(cursor);
      const page_rows = rows.filter((row) => Number(row["original_item_id"]) > cursor).slice(0, 2);
      return {
        after_original_item_id: cursor,
        next_original_item_id:
          page_rows.length === 0
            ? cursor
            : Number(page_rows[page_rows.length - 1]?.["original_item_id"]),
        rows: page_rows,
      };
    }),
    close: vi.fn(),
  };
}

function build_full_rows(): ExportRow[] {
  return [
    build_full_row(10, 0, 10, "原文甲", "译文甲"),
    build_full_row(20, 1, 20, "原文乙", "译文乙"),
    build_full_row(40, 2, 40, "原文丙", "译文丙"),
  ];
}

function build_full_row(
  id: number,
  row_number: number,
  char_offset: number,
  source: string,
  translation: string,
): ExportRow {
  const source_hash = createHash("sha256").update(source, "utf-8").digest("hex");
  return {
    original_item_id: id,
    item: {
      id,
      src: source,
      dst: translation,
      file_path: "route.txt",
      row: row_number,
      status: "PROCESSED",
      extra_field: {
        __linguagacha_fe_v1: {
          schema_version: 1,
          path: "route/a.dat",
          char_offset,
          original_prefix: `route/a.dat | char:${char_offset} | `,
          source_hash,
          source_line_numbers: [1],
          pass_through: [],
          classification: {
            category: "ordinary_independent_slot",
            category_zh: "普通独立槽位",
            source_bytes: Buffer.byteLength(source, "utf-8"),
            slot_capacity: 64,
            allow_overlength: false,
            allow_relocation: false,
            pointer_offsets: [],
            address_limit: null,
            preserve_high16: false,
            shared_storage_group: "",
            format_handler: "",
          },
          migration_review: false,
          migration_source: "test",
          proofread_translation: "",
          display_mode: "auto",
        },
      },
    },
  };
}

function build_worker_input(
  staging_directory: string,
  expected_count: number,
): FateExtraExportWorkerTaskInput {
  return {
    projectPath: path.join(temp_directory, "compact.lg"),
    stagingDirectory: staging_directory,
    classificationDatabase: classification_database,
    projectMode: "compact",
    restoreIndex: false,
    adapter: {
      file_formats: [
        {
          relative_path: "route.txt",
          encoding: "utf-8-bom",
          eol: "\r\n",
          trailing_eol: true,
        },
      ],
    },
    expectedItemCount: expected_count,
    guardedRevisions: { files: 1, items: 2, analysis: 3, proofreading: 4 },
    fontBuildInput: test_font_build_input,
    encodedWidths: [],
  };
}

function create_worker_database(
  rows: ExportRow[],
  cursors: number[],
  read_revisions: () => Record<string, number> = () => revision_record(1, 2, 3, 4),
) {
  return {
    execute: vi.fn((operation: { name: string; args?: Record<string, unknown> }) => {
      if (operation.name === "getAllMeta") {
        const revisions = read_revisions();
        return {
          "project_runtime_revision.files": revisions["files"],
          "project_runtime_revision.items": revisions["items"],
          "project_runtime_revision.analysis": revisions["analysis"],
          "proofreading_revision.proofreading": revisions["proofreading"],
        };
      }
      if (operation.name !== "getFateExtraCompactExportPage") return [];
      const cursor = Number(operation.args?.["afterOriginalItemId"] ?? 0);
      cursors.push(cursor);
      const page_rows = rows.filter((row) => Number(row["original_item_id"]) > cursor).slice(0, 2);
      return {
        after_original_item_id: cursor,
        next_original_item_id:
          page_rows.length === 0
            ? cursor
            : Number(page_rows[page_rows.length - 1]?.["original_item_id"]),
        rows: page_rows,
      };
    }),
    close: vi.fn(),
  };
}

function revision_record(
  files: number,
  items: number,
  analysis: number,
  proofreading: number,
): Record<string, number> {
  return { files, items, analysis, proofreading };
}

function build_rows(): ExportRow[] {
  return [
    build_row(10, 10, "原文甲", "译文甲"),
    build_row(20, 20, "原文甲", "译文甲"),
    build_row(40, 40, "原文乙", "译文乙"),
  ];
}

function build_row(
  original_item_id: number,
  char_offset: number,
  source: string,
  translation: string,
): ExportRow {
  const source_hash = createHash("sha256").update(source, "utf-8").digest("hex");
  return {
    original_item_id,
    file_path: "route.txt",
    row_number: original_item_id,
    resource_path: "route/a.dat",
    char_offset,
    original_prefix: `route/a.dat | char:${char_offset} | `,
    source_line_numbers: [1],
    pass_through: [],
    display_mode: "auto",
    original_machine_translation: "",
    source_hash,
    source,
    excluded_reason: "",
    override_translation: "",
    compact_item: {
      id: original_item_id,
      src: source,
      dst: translation,
      file_path: "route.txt",
      row: original_item_id,
      status: "PROCESSED",
      extra_field: {
        __linguagacha_fe_v1: {
          schema_version: 1,
          path: "route/a.dat",
          char_offset,
          original_prefix: `route/a.dat | char:${char_offset} | `,
          source_hash,
          source_line_numbers: [1],
          pass_through: [],
          classification: { category: "ordinary_independent_slot" },
          migration_review: false,
          migration_source: "test",
          proofread_translation: "",
          display_mode: "auto",
        },
      },
    },
  };
}

function create_classification_database(
  database_path: string,
  rows: Array<[path: string, char_offset: number, source: string]>,
): void {
  const database = new DatabaseSync(database_path);
  try {
    database.exec(`
      CREATE TABLE entries (
        path TEXT NOT NULL,
        char_offset INTEGER NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        category_zh TEXT NOT NULL,
        confidence TEXT NOT NULL,
        reason TEXT NOT NULL,
        resource_path TEXT NOT NULL,
        byte_offset INTEGER,
        source_bytes INTEGER,
        slot_capacity INTEGER,
        slot_end INTEGER,
        allow_overlength INTEGER NOT NULL,
        allow_relocation INTEGER NOT NULL,
        translator_message TEXT NOT NULL,
        pointer_offsets_json TEXT NOT NULL,
        address_limit INTEGER,
        preserve_high16 INTEGER NOT NULL,
        shared_group_id TEXT NOT NULL,
        shared_group_start INTEGER,
        shared_group_end INTEGER,
        shared_group_members INTEGER,
        format_handler TEXT NOT NULL
      )
    `);
    const insert = database.prepare(`
      INSERT INTO entries VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    for (const [resource_path, char_offset, source] of rows) {
      insert.run(
        resource_path,
        char_offset,
        source,
        "ordinary_independent_slot",
        "普通独立槽位",
        "confirmed",
        "test",
        resource_path,
        char_offset,
        Buffer.byteLength(source, "utf-8"),
        64,
        null,
        0,
        0,
        "",
        "[]",
        null,
        0,
        "",
        null,
        null,
        null,
        "",
      );
    }
  } finally {
    database.close();
  }
}

class CompactWriterFailureNativeFs extends NativeFs {
  private write_count = 0;

  public override open_text_writer(file_path: string, initial_text = "") {
    const writer = super.open_text_writer(file_path, initial_text);
    return {
      write: (text: string) => {
        this.write_count += 1;
        if (this.write_count === 2) throw new Error("injected compact writer failure");
        writer.write(text);
      },
      close: () => writer.close(),
    };
  }
}

class CompactPublishFailureNativeFs extends NativeFs {
  private injected = false;

  public override rename(source_path: string, destination_path: string): void {
    if (!this.injected && path.basename(source_path).startsWith(".linguagacha-fe-export-")) {
      this.injected = true;
      throw new Error("injected directory publication failure");
    }
    super.rename(source_path, destination_path);
  }
}
