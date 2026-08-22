import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { NativeFs, type NativeTextWriter } from "../../native/native-fs";
import { ProjectEventBus } from "../project/project-events";
import { ProjectWriteStore } from "../project/project-write-store";
import { ProjectDatabase } from "./database-operations";
import {
  build_fate_extra_scan_apply_artifact_paths,
  FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY,
  read_fate_extra_scan_apply_receipt,
} from "./fate-extra-scan-apply-receipt";
import { apply_fate_extra_scan_staging } from "./fate-extra-scan-staging";

const temporary_directories: string[] = [];

afterEach(() => {
  for (const directory of temporary_directories.splice(0, temporary_directories.length)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FE scan staging", () => {
  it("拒绝不兼容的 staging schema 且不创建备份", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    create_project(project_path);
    create_staging(staging_path);
    update_staging_meta(staging_path, "schema_version", 99);

    await expect(
      apply_fate_extra_scan_staging({
        projectPath: project_path,
        stagingPath: staging_path,
        scanId: "scan-old-schema",
        applyToken: "apply-old-schema",
        expectedSectionRevisions: revision_record(1),
      }),
    ).rejects.toThrow("staging schema 已失效");

    expect(fs.readdirSync(directory).some((name) => name.includes("fe-backup"))).toBe(false);
  });

  it("外部输入 ENOENT 明确判为前置失效且不修改项目", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    const missing_input = path.join(directory, "deleted-input.txt");
    create_project(project_path);
    create_staging(staging_path);
    update_staging_meta(staging_path, "fingerprints", [
      { path: missing_input, kind: "file", size: 1, mtime_ms: 1, sha256: "missing" },
    ]);

    await expect(
      apply_fate_extra_scan_staging({
        projectPath: project_path,
        stagingPath: staging_path,
        scanId: "scan-missing-input",
        applyToken: "apply-missing-input",
        expectedSectionRevisions: revision_record(1),
      }),
    ).rejects.toThrow("扫描输入已失效：deleted-input.txt");

    const database = new DatabaseSync(project_path, { readOnly: true });
    try {
      expect(database.prepare("SELECT data FROM items WHERE id = 1").get()?.["data"]).toBe(
        '{"src":"old"}',
      );
      expect(read_meta_number(database, "project_runtime_revision.items")).toBe(1);
    } finally {
      database.close();
    }
    expect(fs.readdirSync(directory).some((name) => name.includes("fe-backup"))).toBe(false);
  });

  it("从 staging 在单事务内替换项目事实并推进四个 revision", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    create_project(project_path);
    create_staging(staging_path);

    const result = await apply_fate_extra_scan_staging({
      projectPath: project_path,
      stagingPath: staging_path,
      scanId: "scan-success",
      applyToken: "apply-success",
      expectedSectionRevisions: revision_record(1),
    });

    const database = new DatabaseSync(project_path, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM items").get()?.["count"]).toBe(1);
      expect(database.prepare("SELECT data FROM items WHERE id = 7").get()?.["data"]).toContain(
        '"src":"日文"',
      );
      expect(database.prepare("SELECT path FROM assets").get()?.["path"]).toBe("补漏.txt");
      expect(read_meta_number(database, "project_runtime_revision.files")).toBe(2);
      expect(read_meta_number(database, "project_runtime_revision.items")).toBe(2);
      expect(read_meta_number(database, "project_runtime_revision.analysis")).toBe(2);
      expect(read_meta_number(database, "proofreading_revision.proofreading")).toBe(2);
    } finally {
      database.close();
    }
    expect(result).toMatchObject({
      accepted: true,
      logical_text_count: 1,
      section_revisions: revision_record(2),
      migration_report_status: "succeeded",
    });
    expect(fs.existsSync(result.backup_path)).toBe(true);
    expect(fs.existsSync(result.migration_report_json)).toBe(true);
    expect(fs.existsSync(result.migration_report_csv)).toBe(true);
  });

  it("revision 冲突时不创建备份且不修改旧项目", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    create_project(project_path);
    create_staging(staging_path);

    await expect(
      apply_fate_extra_scan_staging({
        projectPath: project_path,
        stagingPath: staging_path,
        scanId: "scan-conflict",
        applyToken: "apply-conflict",
        expectedSectionRevisions: { ...revision_record(1), items: 9 },
      }),
    ).rejects.toThrow("revision 已失效：items");

    const database = new DatabaseSync(project_path, { readOnly: true });
    try {
      expect(database.prepare("SELECT data FROM items WHERE id = 1").get()?.["data"]).toBe(
        '{"src":"old"}',
      );
      expect(read_meta_number(database, "project_runtime_revision.items")).toBe(1);
    } finally {
      database.close();
    }
    expect(fs.readdirSync(directory).some((name) => name.includes("fe-backup"))).toBe(false);
  });

  it("备份后出现并发 revision 变化时在 BEGIN IMMEDIATE 内再次拒绝并清理备份", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    create_project(project_path);
    create_staging(staging_path);
    const native_fs = new RevisionRaceNativeFs(project_path);

    await expect(
      apply_fate_extra_scan_staging(
        {
          projectPath: project_path,
          stagingPath: staging_path,
          scanId: "scan-race",
          applyToken: "apply-race",
          expectedSectionRevisions: revision_record(1),
        },
        native_fs,
      ),
    ).rejects.toThrow("revision 已失效：items");

    const database = new DatabaseSync(project_path, { readOnly: true });
    try {
      expect(database.prepare("SELECT data FROM items WHERE id = 1").get()?.["data"]).toBe(
        '{"src":"old"}',
      );
      expect(database.prepare("SELECT data FROM items WHERE id = 7").get()).toBeUndefined();
      expect(read_meta_number(database, "project_runtime_revision.items")).toBe(2);
    } finally {
      database.close();
    }
    expect(fs.readdirSync(directory).some((name) => name.includes("fe-backup"))).toBe(false);
  });

  it("报告 IO 失败是明确的非致命结果且不会掩盖已提交项目事实", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    create_project(project_path);
    create_staging(staging_path);

    const result = await apply_fate_extra_scan_staging(
      {
        projectPath: project_path,
        stagingPath: staging_path,
        scanId: "scan-report-failure",
        applyToken: "apply-report-failure",
        expectedSectionRevisions: revision_record(1),
      },
      new ReportWriteFailureNativeFs(),
    );

    expect(result).toMatchObject({
      accepted: true,
      section_revisions: revision_record(2),
      migration_report_status: "failed",
      migration_report_error: "injected report write failure",
    });
    expect(fs.existsSync(result.migration_report_json)).toBe(false);
    expect(fs.existsSync(`${result.migration_report_json}.apply-report-failure.tmp`)).toBe(false);
    const database = new DatabaseSync(project_path, { readOnly: true });
    try {
      expect(database.prepare("SELECT data FROM items WHERE id = 7").get()?.["data"]).toContain(
        '"src":"日文"',
      );
      expect(read_meta_number(database, "project_runtime_revision.items")).toBe(2);
    } finally {
      database.close();
    }
  });

  it("COMMIT 后 worker 失联时 durable receipt 与项目事实保持可恢复", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    create_project(project_path);
    create_staging(staging_path);

    await expect(
      apply_fate_extra_scan_staging(
        {
          projectPath: project_path,
          stagingPath: staging_path,
          scanId: "scan-post-commit-failure",
          applyToken: "apply-post-commit-failure",
          expectedSectionRevisions: revision_record(1),
        },
        new NativeFs(),
        (progress) => {
          if (progress.phase === "commit-project" && progress.completed === 1) {
            throw new Error("injected worker exit after commit");
          }
        },
      ),
    ).rejects.toThrow("injected worker exit after commit");

    const database = new DatabaseSync(project_path, { readOnly: true });
    try {
      expect(database.prepare("SELECT data FROM items WHERE id = 7").get()?.["data"]).toContain(
        '"src":"日文"',
      );
      expect(read_meta_number(database, "project_runtime_revision.items")).toBe(2);
      const receipt = read_fate_extra_scan_apply_receipt(
        read_meta_value(database, FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY),
      );
      expect(receipt).toMatchObject({
        apply_token: "apply-post-commit-failure",
        scan_id: "scan-post-commit-failure",
        section_revisions: revision_record(2),
      });
      expect(fs.existsSync(receipt!.backup_path)).toBe(true);
      expect(
        fs.existsSync(
          build_fate_extra_scan_apply_artifact_paths(project_path, "apply-post-commit-failure")
            .pending_manifest_path,
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("COMMIT 前 worker 失败时回滚项目且不留下 receipt 或备份", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    create_project(project_path);
    create_staging(staging_path);

    await expect(
      apply_fate_extra_scan_staging(
        {
          projectPath: project_path,
          stagingPath: staging_path,
          scanId: "scan-pre-commit-failure",
          applyToken: "apply-pre-commit-failure",
          expectedSectionRevisions: revision_record(1),
        },
        new NativeFs(),
        (progress) => {
          if (progress.phase === "import-items" && progress.completed === 0) {
            throw new Error("injected worker exit before commit");
          }
        },
      ),
    ).rejects.toThrow("injected worker exit before commit");

    const database = new DatabaseSync(project_path, { readOnly: true });
    try {
      expect(database.prepare("SELECT data FROM items WHERE id = 1").get()?.["data"]).toBe(
        '{"src":"old"}',
      );
      expect(database.prepare("SELECT data FROM items WHERE id = 7").get()).toBeUndefined();
      expect(read_meta_number(database, "project_runtime_revision.items")).toBe(1);
      expect(read_meta_value(database, FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY)).toBeNull();
    } finally {
      database.close();
    }
    expect(fs.readdirSync(directory).some((name) => name.includes("fe-backup"))).toBe(false);
    expect(
      fs.existsSync(
        build_fate_extra_scan_apply_artifact_paths(project_path, "apply-pre-commit-failure")
          .pending_manifest_path,
      ),
    ).toBe(false);
  });

  it("主进程缓存连接可在 worker COMMIT 后读取 receipt 并发布 committed change", async () => {
    const directory = create_temporary_directory();
    const project_path = path.join(directory, "current-project.lg");
    const staging_path = path.join(directory, "scan.sqlite");
    const database = new ProjectDatabase();
    database.execute({
      name: "createProject",
      args: { projectPath: project_path, name: "receipt-recovery" },
    });
    database.execute({
      name: "upsertMetaEntries",
      args: {
        projectPath: project_path,
        meta: {
          "project_runtime_revision.files": 1,
          "project_runtime_revision.items": 1,
          "project_runtime_revision.analysis": 1,
          "proofreading_revision.proofreading": 1,
        },
      },
    });
    create_staging(staging_path);
    const event_bus = new ProjectEventBus();
    let items_changed = 0;
    event_bus.subscribe("project.items.changed", () => {
      items_changed += 1;
    });
    const store = new ProjectWriteStore(database, event_bus, null);

    try {
      const result = await store.apply_fate_extra_scan_staging({
        projectPath: project_path,
        scanId: "scan-dual-connection",
        applyToken: "apply-dual-connection",
        expectedSectionRevisions: revision_record(1),
        commit: async (expectedSectionRevisions) =>
          await apply_fate_extra_scan_staging(
            {
              projectPath: project_path,
              stagingPath: staging_path,
              scanId: "scan-dual-connection",
              applyToken: "apply-dual-connection",
              expectedSectionRevisions,
            },
            new NativeFs(),
            (progress) => {
              if (progress.phase === "commit-project" && progress.completed === 1) {
                throw new Error("injected worker exit after commit");
              }
            },
          ),
      });

      expect(result).toMatchObject({
        accepted: true,
        apply_receipt_recovered: true,
        section_revisions: revision_record(2),
      });
      expect(items_changed).toBe(1);
    } finally {
      database.close();
    }
  });
});

function create_temporary_directory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-stage-"));
  temporary_directories.push(directory);
  return directory;
}

function create_project(project_path: string): void {
  const database = new DatabaseSync(project_path);
  try {
    database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE assets (
        path TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        data BLOB NOT NULL,
        original_size INTEGER NOT NULL,
        compressed_size INTEGER NOT NULL
      );
      CREATE TABLE analysis_item_checkpoint (item_id INTEGER PRIMARY KEY);
      CREATE TABLE analysis_candidate_aggregate (candidate_key TEXT PRIMARY KEY);
      INSERT INTO items (id, data) VALUES (1, '{"src":"old"}');
      INSERT INTO assets (path, sort_order, data, original_size, compressed_size)
      VALUES ('old.txt', 0, X'00', 1, 1);
    `);
    const insert_meta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insert_meta.run("project_runtime_revision.files", "1");
    insert_meta.run("project_runtime_revision.items", "1");
    insert_meta.run("project_runtime_revision.analysis", "1");
    insert_meta.run("proofreading_revision.proofreading", "1");
  } finally {
    database.close();
  }
}

function create_staging(staging_path: string): void {
  const database = new DatabaseSync(staging_path);
  try {
    database.exec(`
      CREATE TABLE scan_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE scan_items (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE scan_assets (
        sort_order INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        data BLOB NOT NULL,
        original_size INTEGER NOT NULL,
        compressed_size INTEGER NOT NULL
      );
      CREATE TABLE scan_migration_issues (issue_order INTEGER PRIMARY KEY, data TEXT NOT NULL);
    `);
    const insert_meta = database.prepare("INSERT INTO scan_meta (key, value) VALUES (?, ?)");
    insert_meta.run("schema_version", "1");
    insert_meta.run("fingerprints", "[]");
    insert_meta.run(
      "adapter_meta",
      JSON.stringify({ schema_version: 1, enabled: true, logical_text_count: 1 }),
    );
    database
      .prepare("INSERT INTO scan_items (id, data) VALUES (?, ?)")
      .run(7, JSON.stringify({ src: "日文", dst: "译文", status: "PROCESSED", extra_field: {} }));
    database
      .prepare(
        `INSERT INTO scan_assets (sort_order, path, data, original_size, compressed_size)
         VALUES (0, '补漏.txt', X'01', 1, 1)`,
      )
      .run();
    database.prepare("INSERT INTO scan_migration_issues (issue_order, data) VALUES (?, ?)").run(
      0,
      JSON.stringify({
        file_path: "补漏.txt",
        path: "field/001.dat",
        char_offset: 4,
        source: "日文",
        reason: "test",
      }),
    );
  } finally {
    database.close();
  }
}

function update_staging_meta(staging_path: string, key: string, value: unknown): void {
  const database = new DatabaseSync(staging_path);
  try {
    database
      .prepare("INSERT OR REPLACE INTO scan_meta (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  } finally {
    database.close();
  }
}

function revision_record(
  value: number,
): Record<"files" | "items" | "analysis" | "proofreading", number> {
  return { files: value, items: value, analysis: value, proofreading: value };
}

function read_meta_number(database: DatabaseSync, key: string): number {
  return Number(read_meta_value(database, key));
}

function read_meta_value(database: DatabaseSync, key: string): unknown {
  const value = database.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.["value"];
  return value === undefined ? null : JSON.parse(String(value));
}

class RevisionRaceNativeFs extends NativeFs {
  private injected = false;

  public constructor(private readonly project_path: string) {
    super();
  }

  public override to_native_path(file_path: string): string {
    if (!this.injected && file_path.includes(".fe-backup-")) {
      this.injected = true;
      const database = new DatabaseSync(super.to_native_path(this.project_path));
      try {
        database
          .prepare("UPDATE meta SET value = ? WHERE key = ?")
          .run("2", "project_runtime_revision.items");
      } finally {
        database.close();
      }
    }
    return super.to_native_path(file_path);
  }
}

class ReportWriteFailureNativeFs extends NativeFs {
  public override open_text_writer(file_path: string, initial_text = ""): NativeTextWriter {
    if (file_path.includes(".fe-migration-report.")) {
      throw new Error("injected report write failure");
    }
    return super.open_text_writer(file_path, initial_text);
  }
}
