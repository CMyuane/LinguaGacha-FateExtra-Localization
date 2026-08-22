import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeFs, type NativeTextWriter } from "../../native/native-fs";
import { NativePathPolicy } from "../../native/native-path";
import { JsonTool } from "../../shared/utils/json-tool";
import { ZstdTool } from "../../shared/utils/zstd-tool";
import { build_fate_extra_scan_staging } from "./fate-extra-scan-staging-builder";

let temporary_directory = "";
let native_fs: NativeFs;

beforeEach(() => {
  temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-stream-scan-"));
  native_fs = new NativeFs(new NativePathPolicy(process.platform));
});

afterEach(() => {
  vi.restoreAllMocks();
  native_fs.remove(temporary_directory, { recursive: true, force: true });
});

describe("FE 流式 scan staging", () => {
  it("逐行解析完整主库并保持路线、补漏、分类和 item 顺序", async () => {
    const fixture = create_fixture(3, 2);
    const read_file = vi.spyOn(native_fs, "read_file");
    const progress: Array<{ phase: string; completed: number; total: number | null }> = [];

    const result = await build_fate_extra_scan_staging(fixture.input, native_fs, (snapshot) => {
      progress.push(snapshot);
    });

    expect(result.report).toMatchObject({
      applicable: false,
      source_file_count: 1,
      physical_line_count: 3,
      logical_text_count: 3,
      route_logical_text_count: 2,
      complete_jp_text_count: 3,
      supplemental_text_count: 1,
      unique_index_count: 3,
      route_unique_index_count: 2,
      matched_classification_count: 3,
      missing_classification_count: 0,
      structural_issue_count: 0,
      migration_pending: 2,
    });
    expect(read_file.mock.calls.some(([file_path]) => file_path === fixture.complete_path)).toBe(
      false,
    );
    expect(progress.at(-1)).toEqual({ phase: "finalize-staging", completed: 1, total: 1 });
    expect(new Set(progress.map((snapshot) => snapshot.phase))).toContain("stage-items");

    const stage = new DatabaseSync(fixture.staging_path, { readOnly: true });
    try {
      expect(stage.prepare("SELECT COUNT(*) AS count FROM scan_items").get()?.["count"]).toBe(3);
      expect(stage.prepare("SELECT COUNT(*) AS count FROM scan_assets").get()?.["count"]).toBe(2);
      expect(
        stage.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'work_%'").all(),
      ).toEqual([]);
      const items = stage
        .prepare("SELECT id, data FROM scan_items ORDER BY id")
        .all()
        .map((row) => ({
          id: Number(row["id"]),
          data: JsonTool.parseStrict<Record<string, unknown>>(String(row["data"])),
        }));
      expect(items.map((item) => item.data["src"])).toEqual(["原文1", "原文2", "原文3"]);
      expect(items.map((item) => item.data["file_path"])).toEqual([
        fixture.route_name,
        fixture.route_name,
        "FE_补漏.txt",
      ]);
      expect(items[2]?.data).toMatchObject({ dst: "原文3", tag: "补漏", status: "NONE" });
      const supplement = stage
        .prepare("SELECT data FROM scan_assets WHERE path = 'FE_补漏.txt'")
        .get();
      expect(
        ZstdTool.decompress(Buffer.from(supplement?.["data"] as Uint8Array)).toString("utf-8"),
      ).toBe("field/test.dat | char:3 | 原文3\r\n");
    } finally {
      stage.close();
    }
  });

  it("合成大主库不调用整文件读取且计数无遗漏", async () => {
    native_fs = new CountingNativeFs();
    const fixture = create_fixture(20_000, 1);
    const read_file = vi.spyOn(native_fs, "read_file");
    const heap_before = process.memoryUsage().heapUsed;

    const result = await build_fate_extra_scan_staging(fixture.input, native_fs);

    const heap_growth = process.memoryUsage().heapUsed - heap_before;
    expect(result.report).toMatchObject({
      complete_jp_text_count: 20_000,
      logical_text_count: 20_000,
      route_logical_text_count: 1,
      supplemental_text_count: 19_999,
      unique_index_count: 20_000,
    });
    expect(read_file.mock.calls.some(([file_path]) => file_path === fixture.complete_path)).toBe(
      false,
    );
    expect(heap_growth).toBeLessThan(96 * 1024 * 1024);
    expect((native_fs as CountingNativeFs).supplement_write_count).toBeLessThanOrEqual(2);
    const stage = new DatabaseSync(fixture.staging_path, { readOnly: true });
    try {
      expect(stage.prepare("SELECT COUNT(*) AS count FROM scan_items").get()?.["count"]).toBe(
        20_000,
      );
    } finally {
      stage.close();
    }
  }, 30_000);

  it("带索引初翻在 worker staging 中按资源索引写入对应路线 item", async () => {
    const fixture = create_fixture(2, 2);
    const migration_directory = String(fixture.input.body["migration_text_directory"]);
    native_fs.make_dir(migration_directory);
    fs.writeFileSync(
      path.join(migration_directory, "FE_尼禄_拉妮_初翻_带索引.txt"),
      ["field/test.dat | char:1 | 译文一", "field/test.dat | char:2 | 译文二"].join("\r\n"),
      "utf-8",
    );

    await build_fate_extra_scan_staging(fixture.input, native_fs);

    const stage = new DatabaseSync(fixture.staging_path, { readOnly: true });
    try {
      const translations = stage
        .prepare("SELECT data FROM scan_items ORDER BY id")
        .all()
        .map((row) => JsonTool.parseStrict<Record<string, unknown>>(String(row["data"] ?? "{}")))
        .map((item) => item["dst"]);
      expect(translations).toEqual(["译文一", "译文二"]);
    } finally {
      stage.close();
    }
  });

  it("分类库以逻辑快照读取并记录主库、WAL、SHM 文件集合", async () => {
    const fixture = create_fixture(3, 2);
    const classification = new DatabaseSync(fixture.classification_path);
    try {
      classification.exec("PRAGMA journal_mode = WAL");
      classification.exec("BEGIN IMMEDIATE; UPDATE entries SET reason = 'wal-fixture'; COMMIT;");

      const result = await build_fate_extra_scan_staging(fixture.input, native_fs);
      const fingerprint = result.fingerprints.find(
        (candidate) => candidate.path === fixture.classification_path,
      );

      expect(fingerprint).toMatchObject({ kind: "sqlite" });
      expect(fingerprint?.sqlite_files?.map((file) => file.path)).toEqual([
        fixture.classification_path,
        `${fixture.classification_path}-wal`,
        `${fixture.classification_path}-shm`,
      ]);
      expect(fs.existsSync(`${fixture.staging_path}.classification.sqlite`)).toBe(false);
    } finally {
      classification.close();
    }
  });
});

function create_fixture(
  complete_count: number,
  route_count: number,
): {
  input: Parameters<typeof build_fate_extra_scan_staging>[0];
  complete_path: string;
  staging_path: string;
  classification_path: string;
  route_name: string;
} {
  const source_directory = path.join(temporary_directory, "routes");
  native_fs.make_dir(source_directory);
  const route_name = "FE_尼禄_拉妮_日文原版_带索引.txt";
  const complete_path = path.join(temporary_directory, "complete.txt");
  const classification_path = path.join(temporary_directory, "classification.sqlite");
  const staging_path = path.join(temporary_directory, "scan.sqlite");
  const complete_lines = ["===== fixture (0 strings) ====="];
  for (let index = 1; index <= complete_count; index += 1) {
    complete_lines.push(`field/test.dat | char:${index} | 原文${index}`);
  }
  fs.writeFileSync(complete_path, complete_lines.join("\r\n"), "utf-8");
  fs.writeFileSync(
    path.join(source_directory, route_name),
    complete_lines.slice(1, route_count + 1).join("\r\n"),
    "utf-8",
  );
  create_classification_database(classification_path, complete_count);
  return {
    input: {
      projectPath: path.join(temporary_directory, "project.lg"),
      projectEpoch: 7,
      projectMeta: {
        "project_runtime_revision.files": 1,
        "project_runtime_revision.items": 2,
        "project_runtime_revision.analysis": 3,
        "proofreading_revision.proofreading": 4,
      },
      body: {
        source_directory,
        complete_jp_source_file: complete_path,
        classification_database: classification_path,
        migration_project: path.join(temporary_directory, "missing-legacy.lg"),
        migration_text_directory: path.join(temporary_directory, "missing-translations"),
      },
      stagingPath: staging_path,
    },
    complete_path,
    staging_path,
    classification_path,
    route_name,
  };
}

class CountingNativeFs extends NativeFs {
  public supplement_write_count = 0;

  public override open_text_writer(file_path: string, initial_text = ""): NativeTextWriter {
    const writer = super.open_text_writer(file_path, initial_text);
    if (!file_path.endsWith(".supplement.tmp")) return writer;
    return {
      write: (text) => {
        this.supplement_write_count += 1;
        writer.write(text);
      },
      close: () => writer.close(),
    };
  }
}

function create_classification_database(database_path: string, count: number): void {
  const database = new DatabaseSync(database_path);
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
    );
  `);
  const insert = database.prepare(`
    INSERT INTO entries VALUES (
      ?, ?, ?, 'ordinary_independent_slot', '普通独立槽位', 'confirmed', 'fixture', ?,
      NULL, NULL, NULL, NULL, 0, 0, '', '[]', NULL, 0, '', NULL, NULL, NULL, ''
    )
  `);
  database.exec("BEGIN;");
  for (let index = 1; index <= count; index += 1) {
    insert.run("field/test.dat", index, `原文${index}`, "field/test.dat");
  }
  database.exec("COMMIT;");
  database.close();
}
