import { describe, expect, it, vi } from "vitest";

import type { AppPathService } from "../app/app-path-service";
import type { ProjectDatabase } from "../database/database-operations";
import type { ProjectOperationGate } from "../project/project-gate";
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import type { NativeFs } from "../../native/native-fs";
import { RequestValidationError } from "../../shared/error";
import { FATE_EXTRA_ADAPTER_META_KEY } from "../../shared/fate-extra/fate-extra-types";
import type { FateExtraFontService } from "./fate-extra-font-service";
import { FateExtraService } from "./fate-extra-service";

type DraftGuardProbe = {
  assert_draft_unchanged(draft: unknown): void;
};

const PROJECT_PATH = String.raw`D:\work\project.lg`;
const SOURCE_DIRECTORY = String.raw`D:\work\indexed`;
const CLASSIFICATION_DATABASE = String.raw`D:\work\classification.sqlite`;

describe("FateExtraService", () => {
  it("扫描后读取 manifest 即使改变 SQLite 文件时间也不会让草稿失效", () => {
    const { service, stat } = create_service({
      meta: revision_meta({ files: 8, items: 817, analysis: 295, proofreading: 51 }),
    });

    expect(() => assert_draft(service)).not.toThrow();
    expect(stat).not.toHaveBeenCalledWith(PROJECT_PATH);
  });

  it("项目语义 revision 变化时拒绝应用旧扫描草稿并返回可读原因", () => {
    const { service } = create_service({
      meta: revision_meta({ files: 8, items: 818, analysis: 295, proofreading: 51 }),
    });

    let thrown: unknown;
    try {
      assert_draft(service);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RequestValidationError);
    expect(thrown).toMatchObject({
      code: "request.validation_failed",
      public_details: {
        reason: "项目、索引原稿或分类数据库已变化，请重新扫描。",
      },
    });
  });

  it("未启用适配时导出返回业务校验错误而不是内部状态异常", async () => {
    const { service } = create_service({ meta: revision_meta({}) });

    await expect(
      service.export_project({
        project_path: PROJECT_PATH,
        output_directory: String.raw`D:\work\export`,
      }),
    ).rejects.toMatchObject({
      code: "request.validation_failed",
      public_details: {
        reason: "当前项目尚未启用 Fate/Extra 汉化适配。请先生成扫描报告，再应用 FE 适配。",
      },
    });
  });

  it("状态接口从项目元数据识别已经应用的 FE 适配", () => {
    const meta = revision_meta({});
    meta[FATE_EXTRA_ADAPTER_META_KEY] = {
      enabled: true,
      schema_version: 1,
      logical_text_count: 34_693,
      applied_at: "2026-07-28T00:00:00.000Z",
    };
    const { service } = create_service({ meta });

    expect(service.status({ project_path: PROJECT_PATH })).toEqual({
      enabled: true,
      schema_version: 1,
      logical_text_count: 34_693,
      applied_at: "2026-07-28T00:00:00.000Z",
    });
  });
});

function assert_draft(service: FateExtraService): void {
  (service as unknown as DraftGuardProbe).assert_draft_unchanged({
    project_path: PROJECT_PATH,
    project_section_revisions: {
      files: 8,
      items: 817,
      analysis: 295,
      proofreading: 51,
    },
    source_directory: SOURCE_DIRECTORY,
    source_mtime_ms: 10,
    classification_database: CLASSIFICATION_DATABASE,
    database_mtime_ms: 20,
  });
}

function create_service(args: { meta: Record<string, unknown> }): {
  service: FateExtraService;
  stat: ReturnType<typeof vi.fn>;
} {
  const database = {
    execute: vi.fn((operation: { name: string }) => {
      if (operation.name === "getAllMeta") return args.meta;
      if (operation.name === "getAllItems") return [];
      return [];
    }),
  };
  const session_state = {
    snapshot: vi.fn(() => ({ loaded: true, projectPath: PROJECT_PATH })),
  };
  const stat = vi.fn((file_path: string) => {
    if (file_path === SOURCE_DIRECTORY) return { mtimeMs: 10 };
    if (file_path === CLASSIFICATION_DATABASE) return { mtimeMs: 20 };
    throw new Error(`不应使用文件时间保护项目数据库：${file_path}`);
  });
  const native_fs = {
    stat,
    to_identity_path: (file_path: string) => file_path.toLocaleLowerCase(),
  };
  const service = new FateExtraService(
    {} as AppPathService,
    database as unknown as ProjectDatabase,
    session_state as unknown as ProjectSessionState,
    {} as ProjectOperationGate,
    {} as ProjectWriteStore,
    {} as FateExtraFontService,
    native_fs as unknown as NativeFs,
  );
  return { service, stat };
}

function revision_meta(
  revisions: Partial<Record<"files" | "items" | "analysis" | "proofreading", number>>,
): Record<string, unknown> {
  return {
    "project_runtime_revision.files": revisions.files ?? 0,
    "project_runtime_revision.items": revisions.items ?? 0,
    "project_runtime_revision.analysis": revisions.analysis ?? 0,
    "proofreading_revision.proofreading": revisions.proofreading ?? 0,
  };
}
