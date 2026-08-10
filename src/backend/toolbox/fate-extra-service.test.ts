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

  it("仅修改显示类型时不触发重复组译文写回", async () => {
    const item = {
      id: 7,
      src: "原文",
      dst: "",
      extra_field: {
        __linguagacha_fe_v1: {
          schema_version: 1,
          path: "field/001/0000.dat",
          char_offset: 123,
          original_prefix: "field/001/0000.dat | char:123 | ",
          source_hash: "",
          source_line_numbers: [1],
          pass_through: [],
          migration_review: false,
          migration_source: "test",
          proofread_translation: "",
          display_mode: "auto",
          classification: {
            category: "ordinary_independent_slot",
            category_zh: "普通独立槽位",
            confidence: "confirmed",
            reason: "test",
            resource_path: "field/001/0000.dat",
            byte_offset: 123,
            source_bytes: 8,
            slot_capacity: 16,
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
      },
    };
    const { service, write_store } = create_service({ meta: revision_meta({}), items: [item] });

    await service.save_review({
      item_id: 7,
      text_unit_id: 3,
      review_scope: "unit",
      proofread_translation: "",
      display_mode: "fullscreen",
      expected_section_revisions: { items: 1, proofreading: 2 },
    });

    expect(write_store.apply_fate_extra_item_metadata).toHaveBeenCalledOnce();
    expect(write_store.apply_fate_extra_text_unit_review).not.toHaveBeenCalled();
  });

  it("带索引初翻按资源索引导入并剥离路线透传空行", () => {
    const { service } = create_service({ meta: revision_meta({}) });
    const importer = service as unknown as {
      read_indexed_translation_file(
        text: string,
        file: {
          relative_path: string;
          kind: "route";
          entries: Array<{
            path: string;
            char_offset: number;
            source: string;
            pass_through: Array<{ after_source_line: number; text: string }>;
          }>;
        },
        signature: string,
      ): { translations: Map<string, string>; indexed_keys: Set<string>; issues: string[] };
    };
    const result = importer.read_indexed_translation_file(
      [
        "field/016/0000.dat | char:10 | 译文第一行",
        "译文第二行",
        "",
        "field/016/0000.dat | char:20 | 下一条译文",
      ].join("\r\n"),
      {
        relative_path: "FE_尼禄_救拉妮_日文原版_带索引.txt",
        kind: "route",
        entries: [
          {
            path: "field/016/0000.dat",
            char_offset: 10,
            source: "原文一\n原文二",
            pass_through: [{ after_source_line: 1, text: "" }],
          },
          {
            path: "field/016/0000.dat",
            char_offset: 20,
            source: "下一条原文",
            pass_through: [],
          },
        ],
      },
      "nero:rani",
    );

    expect(result.issues).toEqual([]);
    expect(result.translations.get("nero:rani\u0000field/016/0000.dat\u000010")).toBe(
      "译文第一行\n译文第二行",
    );
    expect(result.translations.get("nero:rani\u0000field/016/0000.dat\u000020")).toBe("下一条译文");
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

function create_service(args: {
  meta: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}): {
  service: FateExtraService;
  stat: ReturnType<typeof vi.fn>;
  write_store: {
    apply_fate_extra_item_metadata: ReturnType<typeof vi.fn>;
    apply_fate_extra_text_unit_review: ReturnType<typeof vi.fn>;
  };
} {
  const database = {
    execute: vi.fn((operation: { name: string }) => {
      if (operation.name === "getAllMeta") return args.meta;
      if (operation.name === "getItemsByIds") return args.items ?? [];
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
  const write_store = {
    apply_fate_extra_item_metadata: vi.fn(async () => ({ accepted: true, changes: [] })),
    apply_fate_extra_text_unit_review: vi.fn(async () => ({ accepted: true, changes: [] })),
  };
  const service = new FateExtraService(
    {} as AppPathService,
    database as unknown as ProjectDatabase,
    session_state as unknown as ProjectSessionState,
    {} as ProjectOperationGate,
    write_store as unknown as ProjectWriteStore,
    {} as FateExtraFontService,
    native_fs as unknown as NativeFs,
  );
  return { service, stat, write_store };
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
