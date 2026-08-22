import { describe, expect, it, vi } from "vitest";

import type { AppPathService } from "../app/app-path-service";
import type { ProjectDatabase } from "../database/database-operations";
import type { ProjectOperationGate } from "../project/project-gate";
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import type { NativeFs } from "../../native/native-fs";
import { FATE_EXTRA_ADAPTER_META_KEY } from "../../shared/fate-extra/fate-extra-types";
import type { FateExtraFontService } from "./fate-extra-font-service";
import { FateExtraService } from "./fate-extra-service";

const PROJECT_PATH = String.raw`D:\work\project.lg`;

describe("FateExtraService", () => {
  it("缺少专用 preview worker 时拒绝同步查询兼容路径", () => {
    const { service, database_execute } = create_service({ meta: revision_meta({}) });
    database_execute.mockClear();

    let thrown: unknown;
    try {
      void service.list_items({ project_path: PROJECT_PATH });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "runtime.internal_invariant",
      diagnostic_context: { reason: "fate_extra_preview_query_worker_missing" },
    });
    expect(database_execute).not.toHaveBeenCalled();
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
      compact_enabled: false,
      compact_item_count: 0,
      physical_item_count: 0,
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

  it("保留 readonly worker 的精确 warning total 和 unit occurrence 命中标记", () => {
    const item = {
      id: 7,
      src: "同文",
      dst: "短文",
      file_path: "representative.txt",
      row: 7,
      status: "NONE",
      fe_warning_codes: ["FE_MIGRATION_REVIEW"],
      fe_warning_occurrence_id: 130,
      extra_field: {
        __linguagacha_fe_v1: {
          schema_version: 1,
          path: "representative.dat",
          char_offset: 7,
          original_prefix: "",
          source_hash: "",
          source_line_numbers: [],
          pass_through: [],
          migration_review: false,
          migration_source: "",
          proofread_translation: "",
          display_mode: "dialogue",
          classification: {
            category: "ordinary_independent_slot",
            slot_capacity: null,
            allow_overlength: false,
          },
        },
      },
    };
    const { service, database_execute } = create_service({ meta: revision_meta({}) });
    database_execute.mockClear();
    const result = (
      service as unknown as {
        assemble_preview_items_page: (
          body: Record<string, unknown>,
          page: Record<string, unknown>,
          state: Record<string, unknown>,
          file_summary: {
            files: string[];
            file_counts: Record<string, unknown>;
            total: number;
          },
        ) => Record<string, unknown>;
      }
    ).assemble_preview_items_page(
      { warning: "FE_MIGRATION_REVIEW", view_mode: "unique" },
      { total: 1, items: [item], review_scope: "unit" },
      {
        ready: true,
        search_ready: true,
        search_generation: 3,
        search_items_revision: 0,
        items_revision: 0,
      },
      { files: [], file_counts: {}, total: 1 },
    );

    expect(database_execute).not.toHaveBeenCalled();
    expect(result["total"]).toBe(1);
    expect(result["items"]).toEqual([
      expect.objectContaining({
        item_id: 7,
        warnings: expect.arrayContaining(["FE_MIGRATION_REVIEW"]),
        classification: expect.objectContaining({ category: "ordinary_independent_slot" }),
      }),
    ]);
  });
});

function create_service(args: {
  meta: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}): {
  service: FateExtraService;
  database_execute: ReturnType<typeof vi.fn>;
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
  const native_fs = {
    to_identity_path: (file_path: string) => file_path.toLocaleLowerCase(),
    exists: () => false,
  };
  const write_store = {
    apply_fate_extra_item_metadata: vi.fn(async () => ({ accepted: true, changes: [] })),
    apply_fate_extra_text_unit_review: vi.fn(async () => ({ accepted: true, changes: [] })),
  };
  const service = new FateExtraService(
    {} as AppPathService,
    database as unknown as ProjectDatabase,
    session_state as unknown as ProjectSessionState,
    {
      run_exclusive_project_write: async <T>(run: () => Promise<T>) => await run(),
    } as ProjectOperationGate,
    write_store as unknown as ProjectWriteStore,
    {
      measure_encoded_bytes: (text: string) => Buffer.byteLength(text, "utf-8"),
      read_encoded_width_snapshot: () => [],
    } as unknown as FateExtraFontService,
    native_fs as unknown as NativeFs,
  );
  return { service, database_execute: database.execute, write_store };
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
