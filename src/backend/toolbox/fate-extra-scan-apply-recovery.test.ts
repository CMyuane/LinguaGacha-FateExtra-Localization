import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppPathService } from "../app/app-path-service";
import { ProjectDatabase } from "../database/database-operations";
import {
  build_fate_extra_scan_apply_artifact_paths,
  build_fate_extra_scan_apply_pending_manifest,
  FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY,
  FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION,
  type FateExtraScanApplyReceipt,
} from "../database/fate-extra-scan-apply-receipt";
import type { ProjectOperationGate } from "../project/project-gate";
import { create_project_opened_for_cache_event, ProjectEventBus } from "../project/project-events";
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import { NativeFs } from "../../native/native-fs";
import type { FateExtraFontService } from "./fate-extra-font-service";
import { FateExtraService } from "./fate-extra-service";

const OLD_APPLY_TOKEN = "37a371b8-fc4a-4dd4-91af-57930c0f34f1";
const PENDING_APPLY_TOKEN = "ba2350a0-ef04-46ae-9512-3b5475f06ec6";
const COMMITTED_APPLY_TOKEN = "84ca87ae-1522-42bb-a7a7-5e684b14a68f";

const temporary_directories: string[] = [];

afterEach(() => {
  for (const directory of temporary_directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FE scan-apply 启动恢复", () => {
  it("旧 receipt 未变化时删除新 apply 的 pending backup 与报告临时文件", async () => {
    const fixture = create_recovery_fixture();
    try {
      const old_artifacts = build_fate_extra_scan_apply_artifact_paths(
        fixture.project_path,
        OLD_APPLY_TOKEN,
      );
      write_receipt(fixture.database, fixture.project_path, OLD_APPLY_TOKEN);
      fs.writeFileSync(old_artifacts.backup_path, "committed rollback point");

      const pending = build_fate_extra_scan_apply_artifact_paths(
        fixture.project_path,
        PENDING_APPLY_TOKEN,
      );
      write_pending_manifest(fixture.project_path, PENDING_APPLY_TOKEN, OLD_APPLY_TOKEN);
      fs.writeFileSync(pending.backup_path, "uncommitted backup");
      fs.writeFileSync(pending.migration_report_json_temporary, "partial json");
      fs.writeFileSync(pending.migration_report_csv_temporary, "partial csv");
      const unrelated = path.join(fixture.directory, "project.fe-apply-not-a-uuid.pending.json");
      fs.writeFileSync(unrelated, "user file");

      await open_project(fixture);

      expect(fs.existsSync(pending.backup_path)).toBe(false);
      expect(fs.existsSync(pending.migration_report_json_temporary)).toBe(false);
      expect(fs.existsSync(pending.migration_report_csv_temporary)).toBe(false);
      expect(fs.existsSync(pending.pending_manifest_path)).toBe(false);
      expect(fs.readFileSync(old_artifacts.backup_path, "utf-8")).toBe("committed rollback point");
      expect(fs.readFileSync(unrelated, "utf-8")).toBe("user file");
    } finally {
      fixture.service.dispose();
      fixture.database.close();
    }
  });

  it("receipt 已提交时保留 rollback backup 并清理 pending manifest 与报告临时文件", async () => {
    const fixture = create_recovery_fixture();
    try {
      const artifacts = build_fate_extra_scan_apply_artifact_paths(
        fixture.project_path,
        COMMITTED_APPLY_TOKEN,
      );
      write_receipt(fixture.database, fixture.project_path, COMMITTED_APPLY_TOKEN);
      write_pending_manifest(fixture.project_path, COMMITTED_APPLY_TOKEN, null);
      fs.writeFileSync(artifacts.backup_path, "durable rollback point");
      fs.writeFileSync(artifacts.migration_report_json_temporary, "partial json");
      fs.writeFileSync(artifacts.migration_report_csv_temporary, "partial csv");

      await open_project(fixture);

      expect(fs.readFileSync(artifacts.backup_path, "utf-8")).toBe("durable rollback point");
      expect(fs.existsSync(artifacts.migration_report_json_temporary)).toBe(false);
      expect(fs.existsSync(artifacts.migration_report_csv_temporary)).toBe(false);
      expect(fs.existsSync(artifacts.pending_manifest_path)).toBe(false);
    } finally {
      fixture.service.dispose();
      fixture.database.close();
    }
  });

  it("manifest 身份不匹配或 receipt 损坏时保守保留所有路径", async () => {
    const fixture = create_recovery_fixture();
    try {
      const artifacts = build_fate_extra_scan_apply_artifact_paths(
        fixture.project_path,
        PENDING_APPLY_TOKEN,
      );
      const manifest = build_fate_extra_scan_apply_pending_manifest(
        fixture.project_path,
        PENDING_APPLY_TOKEN,
        null,
      );
      fs.writeFileSync(
        artifacts.pending_manifest_path,
        JSON.stringify({ ...manifest, backup_path: path.join(fixture.directory, "user.txt") }),
      );
      fs.writeFileSync(artifacts.backup_path, "do not delete");
      fs.writeFileSync(artifacts.migration_report_json_temporary, "do not delete");
      fixture.database.execute({
        name: "setMeta",
        args: {
          projectPath: fixture.project_path,
          key: FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY,
          value: { damaged: true },
        },
      });

      await open_project(fixture);

      expect(fs.readFileSync(artifacts.backup_path, "utf-8")).toBe("do not delete");
      expect(fs.readFileSync(artifacts.migration_report_json_temporary, "utf-8")).toBe(
        "do not delete",
      );
      expect(fs.existsSync(artifacts.pending_manifest_path)).toBe(true);
    } finally {
      fixture.service.dispose();
      fixture.database.close();
    }
  });
});

function create_recovery_fixture(): {
  directory: string;
  project_path: string;
  database: ProjectDatabase;
  event_bus: ProjectEventBus;
  service: FateExtraService;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-fe-apply-recovery-"));
  temporary_directories.push(directory);
  const project_path = path.join(directory, "project.lg");
  const database = new ProjectDatabase();
  database.execute({
    name: "createProject",
    args: { projectPath: project_path, name: "scan-apply recovery" },
  });
  const event_bus = new ProjectEventBus();
  const service = new FateExtraService(
    {} as AppPathService,
    database,
    { snapshot: () => ({ loaded: true, projectPath: project_path }) } as ProjectSessionState,
    {} as ProjectOperationGate,
    {} as ProjectWriteStore,
    {} as FateExtraFontService,
    new NativeFs(),
  );
  service.subscribe(event_bus);
  return { directory, project_path, database, event_bus, service };
}

async function open_project(fixture: ReturnType<typeof create_recovery_fixture>): Promise<void> {
  const results = await fixture.event_bus.publish(
    create_project_opened_for_cache_event({
      projectPath: fixture.project_path,
      sectionRevisions: {},
    }),
  );
  expect(results).toEqual([expect.objectContaining({ ok: true })]);
}

function write_pending_manifest(
  project_path: string,
  apply_token: string,
  previous_receipt_apply_token: string | null,
): void {
  const artifacts = build_fate_extra_scan_apply_artifact_paths(project_path, apply_token);
  const manifest = build_fate_extra_scan_apply_pending_manifest(
    project_path,
    apply_token,
    previous_receipt_apply_token,
  );
  fs.writeFileSync(artifacts.pending_manifest_path, `${JSON.stringify(manifest)}\n`);
}

function write_receipt(database: ProjectDatabase, project_path: string, apply_token: string): void {
  const artifacts = build_fate_extra_scan_apply_artifact_paths(project_path, apply_token);
  const receipt: FateExtraScanApplyReceipt = {
    schema_version: FATE_EXTRA_SCAN_APPLY_RECEIPT_SCHEMA_VERSION,
    apply_token,
    scan_id: `scan-${apply_token}`,
    committed_at: new Date().toISOString(),
    backup_path: artifacts.backup_path,
    migration_report_json: artifacts.migration_report_json,
    migration_report_csv: artifacts.migration_report_csv,
    logical_text_count: 1,
    section_revisions: { files: 1, items: 1, analysis: 1, proofreading: 1 },
  };
  database.execute({
    name: "setMeta",
    args: {
      projectPath: project_path,
      key: FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY,
      value: receipt,
    },
  });
}
