import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AppPathService } from "../app/app-path-service";
import type { ApiJsonValue } from "../api/api-types";
import type { ProjectDatabase } from "../database/database-operations";
import {
  build_fate_extra_scan_apply_artifact_paths,
  FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY,
  parse_fate_extra_scan_apply_pending_manifest_name,
  read_fate_extra_scan_apply_pending_manifest,
  read_fate_extra_scan_apply_receipt,
  type FateExtraScanApplyReceipt,
} from "../database/fate-extra-scan-apply-receipt";
import { normalize_fate_extra_preview_search_text } from "../database/fate-extra-preview-search-index";
import type { ProjectOperationGate } from "../project/project-gate";
import { build_section_revisions_from_meta, get_section_revision } from "../project/project-data";
import type { ProjectEventBus } from "../project/project-events";
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import type { BackendWorkerClient } from "../worker/worker-client";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import * as AppErrors from "../../shared/error";
import { JsonTool } from "../../shared/utils/json-tool";
import {
  layout_fate_extra_preview,
  type FateExtraResolvedDisplayMode,
} from "../../shared/fate-extra/fate-extra-layout";
import { resolve_fate_extra_display_mode } from "../../shared/fate-extra/fate-extra-display-mode";
import { resolve_fate_extra_export_path } from "../../shared/fate-extra/fate-extra-export-path";
import {
  evaluate_fate_extra_preview_warnings,
  is_fate_extra_preview_warning_code,
} from "../../shared/fate-extra/fate-extra-warning";
import {
  FATE_EXTRA_ADAPTER_META_KEY,
  FATE_EXTRA_DEFAULT_CLASSIFICATION_DATABASE,
  FATE_EXTRA_DEFAULT_INDEXED_SOURCE_DIRECTORY,
  FATE_EXTRA_SCHEMA_VERSION,
  merge_fate_extra_item_metadata,
  read_fate_extra_display_mode,
  read_fate_extra_item_metadata,
  read_fate_extra_proofread_translation,
  resolve_fate_extra_project_mode,
  type FateExtraDisplayMode,
  type FateExtraItemMetadata,
} from "../../shared/fate-extra/fate-extra-types";
import type { FateExtraFontService } from "./fate-extra-font-service";
import { FateExtraIndexCoordinator } from "./fate-extra-index-coordinator";
import {
  FateExtraCommittedJobOutcome,
  FateExtraJobCoordinator,
  type FateExtraJobSnapshot,
} from "./fate-extra-job-coordinator";

type JsonRecord = Record<string, ApiJsonValue>;
type MutableRecord = Record<string, unknown>;

type FateExtraServiceWorkers = {
  scanApply: BackendWorkerClient;
  export: BackendWorkerClient;
  index: BackendWorkerClient;
  preview: BackendWorkerClient;
};

type ScanDraftHandle = {
  scan_id: string;
  project_path: string;
  project_epoch: number;
  project_section_revisions: Record<string, number>;
  staging_path: string;
  fingerprints: Array<{ path: string; size: number; mtime_ms: number; sha256: string }>;
  status: "ready";
  summary: JsonRecord;
  expires_at: number;
};

type FateExtraGuardedSection = "files" | "items" | "analysis" | "proofreading";

type ExportPublication = {
  finalize: () => void;
  rollback: () => void;
};

type ScanApplyReceiptReadResult =
  | { status: "absent"; receipt: null }
  | { status: "valid"; receipt: FateExtraScanApplyReceipt }
  | { status: "invalid"; receipt: null };

const FATE_EXTRA_GUARDED_SECTIONS: readonly FateExtraGuardedSection[] = [
  "files",
  "items",
  "analysis",
  "proofreading",
];
const FATE_EXTRA_SCAN_DRAFT_TTL_MS = 30 * 60 * 1000;
const FATE_EXTRA_SCAN_STAGING_PREFIX = ".linguagacha-fe-scan-";

function read_record(value: unknown): MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as MutableRecord)
    : {};
}

/**
 * Fate/Extra project adapter. It keeps indexes out of the ordinary Item model,
 * but retains enough namespaced metadata to reconstruct byte-for-byte layout.
 */
export class FateExtraService {
  private readonly jobs = new FateExtraJobCoordinator();
  private readonly index_coordinator = new FateExtraIndexCoordinator(this.jobs);
  private scan_draft_handle: ScanDraftHandle | null = null;
  private scan_draft_expiry_timer: NodeJS.Timeout | null = null;
  private project_epoch = 0;
  private project_identity = "";
  private readonly project_event_unsubscribers: Array<() => void> = [];
  private readonly display_file_summary_cache = new Map<
    string,
    {
      files: string[];
      file_counts: MutableRecord;
      total: number;
      view_mode: "unique" | "occurrence";
      navigation_generation: number;
    }
  >();
  private readonly duplicate_index_ready = new Set<string>();

  public constructor(
    private readonly paths: AppPathService,
    private readonly database: ProjectDatabase,
    private readonly session_state: ProjectSessionState,
    private readonly operation_gate: ProjectOperationGate,
    private readonly write_store: ProjectWriteStore,
    private readonly font_service: FateExtraFontService,
    private readonly native_fs: NativeFs = default_native_fs,
    private readonly workers: FateExtraServiceWorkers | null = null,
  ) {}

  /**
   * 项目 epoch 与 staging 清理由生命周期事件驱动，避免同路径重载复用旧 generation。
   */
  public subscribe(project_event_bus: ProjectEventBus): void {
    if (this.project_event_unsubscribers.length > 0) return;
    this.project_event_unsubscribers.push(
      project_event_bus.subscribe("project.opened_for_cache", (event) => {
        this.advance_project_epoch(event.projectPath);
        this.cleanup_residual_scan_staging(event.projectPath);
        this.recover_scan_apply_artifacts(event.projectPath);
      }),
      project_event_bus.subscribe("project.unloaded", () => {
        this.advance_project_epoch("");
        this.cancel_active_jobs_and_cleanup_draft();
      }),
      project_event_bus.subscribe("project.items.changed", (event) => {
        this.display_file_summary_cache.delete(event.projectPath);
        this.duplicate_index_ready.delete(event.projectPath);
        if (this.workers === null) return;
        const state = this.session_state.snapshot();
        if (
          !state.loaded ||
          this.native_fs.to_identity_path(state.projectPath) !==
            this.native_fs.to_identity_path(event.projectPath)
        ) {
          return;
        }
        const adapter = read_record(
          this.read_record_operation("getAllMeta", event.projectPath)[FATE_EXTRA_ADAPTER_META_KEY],
        );
        if (
          adapter["enabled"] !== true ||
          Number(adapter["schema_version"] ?? 0) !== FATE_EXTRA_SCHEMA_VERSION
        ) {
          return;
        }
        const index_state = read_record(
          this.database.execute({
            name: "getFateExtraTextUnitIndexState",
            args: { projectPath: event.projectPath },
          }),
        );
        if (index_state["ready"] === true && index_state["search_ready"] === true) {
          this.duplicate_index_ready.add(event.projectPath);
          return;
        }
        this.rebuild_duplicate_index({ project_path: event.projectPath });
      }),
    );
  }

  public dispose(): void {
    for (const unsubscribe of this.project_event_unsubscribers.splice(
      0,
      this.project_event_unsubscribers.length,
    )) {
      unsubscribe();
    }
    this.jobs.dispose();
    this.cleanup_scan_draft_handle();
  }

  public scan(body: JsonRecord): JsonRecord {
    if (this.workers === null) {
      throw new Error("FE 扫描必须在专用 worker 通道中运行。");
    }
    return this.start_scan_job(body);
  }

  public async apply(body: JsonRecord): Promise<JsonRecord> {
    if (this.workers === null) {
      throw new Error("FE staging 应用必须在专用 worker 通道中运行。");
    }
    return this.start_apply_job(body);
  }

  private start_scan_job(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    this.assert_full_project_for_scan_or_apply(project_path);
    const source_directory = this.optional_string(
      body,
      "source_directory",
      FATE_EXTRA_DEFAULT_INDEXED_SOURCE_DIRECTORY,
    );
    const classification_database = this.optional_string(
      body,
      "classification_database",
      FATE_EXTRA_DEFAULT_CLASSIFICATION_DATABASE,
    );
    const complete_jp_source_file = this.require_string(body, "complete_jp_source_file");
    this.assert_directory(source_directory, "索引原稿目录");
    this.assert_file(complete_jp_source_file, "Fate_Extra_JP_完整文本汇总.txt");
    this.assert_file(classification_database, "FE 文本安全分类数据库");

    this.jobs.cancel_kind("scan");
    this.cleanup_scan_draft_handle();
    const project_epoch = this.ensure_project_epoch(project_path);
    const project_meta = this.read_record_operation("getAllMeta", project_path) as JsonRecord;
    const revisions = this.read_guarded_project_revisions(project_path);
    const staging_path = path.join(
      path.dirname(project_path),
      `${FATE_EXTRA_SCAN_STAGING_PREFIX}${randomUUID()}.sqlite`,
    );
    const worker_body: JsonRecord = {
      ...body,
      project_path,
      source_directory,
      classification_database,
      complete_jp_source_file,
    };
    const workers = this.workers;
    if (workers === null) throw new Error("FE worker 尚未初始化。");

    const snapshot = this.jobs.start({
      kind: "scan",
      identityKey: `scan:${project_epoch.toString()}:${randomUUID()}`,
      projectEpoch: project_epoch,
      sourceRevision: revisions.items,
      phase: "scan-staging",
      run: async (signal, report_progress) => {
        let staging_installed = false;
        try {
          const result = await workers.scanApply.run(
            {
              type: "fate_extra_scan_stage",
              input: {
                projectPath: project_path,
                projectEpoch: project_epoch,
                projectMeta: project_meta,
                body: worker_body,
                stagingPath: staging_path,
              },
            },
            signal,
            report_progress,
          );
          this.assert_worker_result_is_current(
            project_path,
            project_epoch,
            result.project_section_revisions,
          );
          if (result.staging_path !== "") {
            this.cleanup_scan_draft_handle();
            this.scan_draft_handle = {
              scan_id: result.scan_id,
              project_path,
              project_epoch,
              project_section_revisions: { ...result.project_section_revisions },
              staging_path: result.staging_path,
              fingerprints: result.fingerprints.map((fingerprint) => ({ ...fingerprint })),
              status: "ready",
              summary: { ...result.report },
              expires_at: Date.now() + FATE_EXTRA_SCAN_DRAFT_TTL_MS,
            };
            this.schedule_scan_draft_expiry(result.scan_id);
            staging_installed = true;
          }
          return result.report as unknown as ApiJsonValue;
        } finally {
          if (!staging_installed) this.remove_staging_file(staging_path);
        }
      },
    });
    return this.job_snapshot_json(snapshot);
  }

  private start_apply_job(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    this.assert_full_project_for_scan_or_apply(project_path);
    this.prune_expired_scan_draft();
    const scan_id = this.require_string(body, "scan_id");
    const handle = this.scan_draft_handle;
    if (
      handle === null ||
      handle.scan_id !== scan_id ||
      this.native_fs.to_identity_path(handle.project_path) !==
        this.native_fs.to_identity_path(project_path)
    ) {
      this.throw_validation_error("FE 扫描报告已失效，请重新扫描。");
    }
    try {
      this.assert_worker_result_is_current(
        project_path,
        handle.project_epoch,
        handle.project_section_revisions,
      );
    } catch (error) {
      this.cleanup_scan_draft_handle();
      throw error;
    }
    const workers = this.workers;
    if (workers === null) throw new Error("FE worker 尚未初始化。");
    const expected_section_revisions =
      body["expected_section_revisions"] ??
      (handle.project_section_revisions as unknown as ApiJsonValue);
    const apply_token = randomUUID();
    const snapshot = this.jobs.start({
      kind: "scan-apply",
      identityKey: `scan-apply:${handle.scan_id}`,
      projectEpoch: handle.project_epoch,
      sourceRevision: handle.project_section_revisions.items ?? 0,
      phase: "apply-staging",
      run: async (signal, report_progress) => {
        const remaining_ttl = this.pause_scan_draft_expiry(handle.scan_id);
        try {
          if (this.scan_draft_handle?.scan_id !== handle.scan_id) {
            this.throw_validation_error("FE 扫描报告已失效，请重新扫描。");
          }
          const result = await this.operation_gate.run_exclusive_project_write(async () => {
            return await this.write_store.apply_fate_extra_scan_staging({
              projectPath: project_path,
              scanId: handle.scan_id,
              applyToken: apply_token,
              expectedSectionRevisions: expected_section_revisions,
              commit: async (expected_revisions) => {
                return (await workers.scanApply.run(
                  {
                    type: "fate_extra_apply_stage",
                    input: {
                      projectPath: project_path,
                      stagingPath: handle.staging_path,
                      scanId: handle.scan_id,
                      applyToken: apply_token,
                      expectedSectionRevisions: expected_revisions,
                    },
                  },
                  signal,
                  report_progress,
                )) as unknown as Record<string, ApiJsonValue>;
              },
            });
          });
          this.cleanup_scan_draft_handle();
          this.remove_staging_file(handle.staging_path);
          this.cleanup_scan_apply_artifacts(project_path, apply_token, true);
          this.display_file_summary_cache.delete(project_path);
          this.duplicate_index_ready.delete(project_path);
          return new FateExtraCommittedJobOutcome(result as unknown as ApiJsonValue);
        } catch (error) {
          const commit_state = this.read_scan_apply_commit_state(
            project_path,
            handle.scan_id,
            apply_token,
          );
          const committed = commit_state === "committed";
          const invalidates_draft = this.scan_apply_error_invalidates_draft(error);
          const draft_retryable =
            commit_state === "not-committed" && !invalidates_draft && !signal.aborted;
          if (commit_state !== "unknown") {
            this.cleanup_scan_apply_artifacts(project_path, apply_token, committed);
          }
          if (commit_state !== "not-committed" || invalidates_draft) {
            this.cleanup_scan_draft_handle();
            this.remove_staging_file(handle.staging_path);
          } else if (draft_retryable) {
            this.resume_scan_draft_expiry(handle.scan_id, remaining_ttl);
          }
          throw this.annotate_scan_apply_failure(error, draft_retryable);
        } finally {
          if (signal.aborted) {
            this.cleanup_scan_draft_handle();
            // Windows 上取消瞬间 SQLite 可能仍持有 staging；worker 退出后在此重试。
            this.remove_staging_file(handle.staging_path);
          }
        }
      },
    });
    return this.job_snapshot_json(snapshot);
  }

  public jobs_status(body: JsonRecord): JsonRecord {
    const job_id = this.require_string(body, "job_id");
    const snapshot = this.jobs.status(job_id);
    if (snapshot === null) this.throw_validation_error("FE 后台任务不存在或已过期。");
    return this.job_snapshot_json(snapshot);
  }

  public jobs_cancel(body: JsonRecord): JsonRecord {
    const job_id = this.require_string(body, "job_id");
    const previous = this.jobs.status(job_id);
    const snapshot = this.jobs.cancel(job_id);
    if (snapshot === null) this.throw_validation_error("FE 后台任务不存在或已过期。");
    if (
      previous?.status === "queued" &&
      (snapshot.kind === "scan" || snapshot.kind === "scan-apply")
    ) {
      // 尚未进入 worker 时没有 SQLite 句柄；运行中任务则由 run() 在 worker
      // 完全终止、连接回滚后再清 staging，不能在这里抢先删除。
      this.cleanup_scan_draft_handle();
    }
    return this.job_snapshot_json(snapshot);
  }

  public status(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const meta = this.read_record_operation("getAllMeta", project_path);
    const adapter = read_record(meta[FATE_EXTRA_ADAPTER_META_KEY]);
    const enabled =
      adapter["enabled"] === true &&
      Number(adapter["schema_version"]) === FATE_EXTRA_SCHEMA_VERSION;
    const compact = read_record(
      this.database.execute({
        name: "getFateExtraCompactState",
        args: { projectPath: project_path },
      }),
    );
    return {
      enabled,
      schema_version: enabled ? FATE_EXTRA_SCHEMA_VERSION : 0,
      logical_text_count: enabled ? Number(adapter["logical_text_count"] ?? 0) : 0,
      applied_at: enabled ? String(adapter["applied_at"] ?? "") : "",
      compact_enabled: compact["enabled"] === true,
      compact_item_count: Number(compact["compact_item_count"] ?? 0),
      physical_item_count: Number(compact["physical_item_count"] ?? 0),
    };
  }

  public async create_compact_project(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const target_project_path = this.require_string(body, "target_project_path");
    const target_with_extension =
      path.extname(target_project_path).toLocaleLowerCase() === ".lg"
        ? target_project_path
        : `${target_project_path}.lg`;
    const project_name = this.optional_string(
      body,
      "name",
      `${path.parse(project_path).name}-FE-精简工程`,
    );
    return await this.operation_gate.run_exclusive_project_write(async () => {
      return read_record(
        this.database.execute({
          name: "createFateExtraCompactProject",
          args: {
            projectPath: project_path,
            targetProjectPath: target_with_extension,
            name: project_name,
          },
        }),
      ) as unknown as JsonRecord;
    });
  }

  public list_items(body: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
    if (this.workers === null) {
      throw new AppErrors.InternalInvariantError({
        diagnostic_context: { reason: "fate_extra_preview_query_worker_missing" },
      });
    }
    return this.list_items_in_preview_worker(body, signal ?? new AbortController().signal);
  }

  private async list_items_in_preview_worker(
    body: JsonRecord,
    signal: AbortSignal,
  ): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const query_project_epoch = this.ensure_project_epoch(project_path);
    const section_revisions = build_section_revisions_from_meta(
      this.read_record_operation("getAllMeta", project_path) as JsonRecord,
    );
    const requested_view_mode =
      String(body["view_mode"] ?? "unique") === "occurrence" ? "occurrence" : "unique";
    const index_state = read_record(
      this.database.execute({
        name: "getFateExtraTextUnitIndexState",
        args: { projectPath: project_path },
      }),
    );
    const view_mode = requested_view_mode;
    const search = normalize_fate_extra_preview_search_text(
      this.optional_raw_string(body, "search", ""),
    );
    const file_filter = this.optional_string(body, "file_path", "");
    const category_filter = this.optional_string(body, "category", "");
    const requested_warning = this.optional_string(body, "warning", "");
    const warning_filter = is_fate_extra_preview_warning_code(requested_warning)
      ? requested_warning
      : "";
    const position = Math.max(0, Math.trunc(Number(body["position"] ?? 0)));
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(body["limit"] ?? 120))));
    const query_id = Math.trunc(Number(body["query_id"] ?? 0));
    const requires_search_index =
      search !== "" || category_filter !== "" || (warning_filter !== "" && file_filter !== "");
    if (index_state["navigation_ready"] !== true || index_state["search_ready"] !== true) {
      const index_job = this.rebuild_duplicate_index({ project_path });
      const cached = this.display_file_summary_cache.get(project_path);
      return {
        total: 0,
        sectionRevisions: section_revisions,
        index_job,
        position,
        items: [],
        files: cached?.files ?? [],
        file_counts: cached?.file_counts ?? {},
        view_mode,
        requested_view_mode,
        review_scope: view_mode === "unique" ? "unit" : "occurrence",
        index_ready: false,
        index_state,
        query_id,
        index_generation: Number(index_state["search_generation"] ?? 0),
        applied_items_revision: Number(index_state["items_revision"] ?? 0),
        navigation_generation: Number(index_state["navigation_generation"] ?? 0),
        applied_navigation_revision: Number(index_state["navigation_items_revision"] ?? 0),
        navigation_state: "updating",
        search_state: "updating",
      } as unknown as JsonRecord;
    }

    const cached_file_summary_candidate = this.display_file_summary_cache.get(project_path);
    const cached_file_summary =
      cached_file_summary_candidate?.view_mode === view_mode &&
      cached_file_summary_candidate.navigation_generation ===
        Number(index_state["navigation_generation"] ?? 0)
        ? cached_file_summary_candidate
        : undefined;
    const should_read_file_summary =
      index_state["ready"] === true &&
      cached_file_summary === undefined &&
      search === "" &&
      file_filter === "" &&
      category_filter === "" &&
      warning_filter === "";
    const has_index_filters = requires_search_index;
    const has_any_filters = has_index_filters || warning_filter !== "";
    const requires_index = has_index_filters;
    const expected_generation = Number(index_state["search_generation"] ?? 0);
    const expected_items_revision = Number(
      index_state[requires_index ? "search_items_revision" : "items_revision"] ?? -1,
    );
    const expected_navigation_generation = Number(index_state["navigation_generation"] ?? 0);
    const expected_navigation_revision = Number(index_state["navigation_items_revision"] ?? -1);
    const page = await this.workers!.preview.run(
      {
        type: "fate_extra_preview_search",
        input: {
          projectPath: project_path,
          search,
          filePath: file_filter,
          category: category_filter,
          warning: warning_filter,
          encodedWidths:
            warning_filter === "FE_STORAGE_CAPACITY"
              ? this.font_service.read_encoded_width_snapshot()
              : [],
          projectEpoch: query_project_epoch,
          position,
          limit,
          includeFiles: should_read_file_summary,
          includeTotal:
            view_mode === "unique" || cached_file_summary === undefined || has_any_filters,
          viewMode: view_mode,
          expectedGeneration: expected_generation,
          expectedItemsRevision: expected_items_revision,
          expectedNavigationGeneration: expected_navigation_generation,
          expectedNavigationRevision: expected_navigation_revision,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      this.project_epoch !== query_project_epoch ||
      this.native_fs.to_identity_path(this.require_loaded_project(body)) !==
        this.native_fs.to_identity_path(project_path)
    ) {
      this.throw_validation_error("项目已切换或重新打开，已丢弃旧的 FE 预览查询。");
    }
    const page_record = read_record(page);
    if (
      Number(page_record["index_generation"] ?? -1) !== expected_generation ||
      Number(page_record["applied_items_revision"] ?? -1) !== expected_items_revision ||
      Number(page_record["navigation_generation"] ?? -1) !== expected_navigation_generation ||
      Number(page_record["applied_navigation_revision"] ?? -1) !== expected_navigation_revision
    ) {
      this.throw_validation_error("FE 预览索引已更新，已丢弃旧查询。");
    }
    const verified_index_state = read_record(
      this.database.execute({
        name: "getFateExtraTextUnitIndexState",
        args: { projectPath: project_path },
      }),
    );
    const verified_revision = Number(
      verified_index_state[requires_index ? "search_items_revision" : "items_revision"] ?? -1,
    );
    if (
      verified_revision !== expected_items_revision ||
      verified_index_state["navigation_ready"] !== true ||
      Number(verified_index_state["navigation_generation"] ?? -1) !==
        expected_navigation_generation ||
      Number(verified_index_state["navigation_items_revision"] ?? -1) !==
        expected_navigation_revision ||
      (requires_index &&
        (verified_index_state["search_ready"] !== true ||
          Number(verified_index_state["search_generation"] ?? -1) !== expected_generation))
    ) {
      this.throw_validation_error("FE 预览索引身份已变化，已丢弃旧查询。");
    }
    if (verified_index_state["ready"] === true) {
      this.duplicate_index_ready.add(project_path);
    }
    if (should_read_file_summary) {
      this.display_file_summary_cache.set(project_path, {
        files: Array.isArray(page_record["files"])
          ? page_record["files"].map((value) => String(value))
          : [],
        file_counts: read_record(page_record["file_counts"]),
        total: Number(page_record["total"] ?? 0),
        view_mode,
        navigation_generation: expected_navigation_generation,
      });
    }
    const stored_file_summary = this.display_file_summary_cache.get(project_path);
    const file_summary =
      stored_file_summary?.view_mode === view_mode &&
      stored_file_summary.navigation_generation === expected_navigation_generation
        ? stored_file_summary
        : ({
            files: [],
            file_counts: {},
            total: 0,
            view_mode,
            navigation_generation: expected_navigation_generation,
          } as const);
    const current_revisions = build_section_revisions_from_meta(
      this.read_record_operation("getAllMeta", project_path) as JsonRecord,
    );
    if (
      current_revisions.items !== section_revisions.items ||
      current_revisions.proofreading !== section_revisions.proofreading
    ) {
      this.throw_validation_error("FE 预览内容已更新，已丢弃旧查询。");
    }
    return {
      ...this.assemble_preview_items_page(body, page_record, verified_index_state, file_summary),
      sectionRevisions: current_revisions,
    };
  }

  private assemble_preview_items_page(
    body: JsonRecord,
    page: MutableRecord,
    index_state: MutableRecord,
    file_summary: Readonly<{
      files: readonly string[];
      file_counts: MutableRecord;
      total: number;
    }>,
  ): JsonRecord {
    const requested_view_mode =
      String(body["view_mode"] ?? "unique") === "occurrence" ? "occurrence" : "unique";
    const view_mode = requested_view_mode;
    const search = normalize_fate_extra_preview_search_text(
      this.optional_raw_string(body, "search", ""),
    );
    const position = Math.max(0, Math.trunc(Number(body["position"] ?? 0)));
    const source_items = Array.isArray(page["items"])
      ? page["items"].filter(
          (item): item is MutableRecord =>
            typeof item === "object" && item !== null && !Array.isArray(item),
        )
      : [];
    const rows = source_items.flatMap((item) => {
      const stored_metadata = read_fate_extra_item_metadata(
        item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
      );
      if (stored_metadata === null) return [];
      const metadata: FateExtraItemMetadata = stored_metadata;
      const src = String(item["src"] ?? "");
      const dst = String(item["dst"] ?? "");
      const warning_evaluation = evaluate_fate_extra_preview_warnings({
        src,
        dst,
        metadata,
        measure_encoded_bytes: (text) => this.font_service.measure_encoded_bytes(text),
      });
      const proofread_translation = warning_evaluation.proofread_translation;
      const translated = warning_evaluation.translated;
      const display_resolution = resolve_fate_extra_display_mode(
        metadata,
        read_fate_extra_display_mode(metadata),
      );
      const display_mode = display_resolution.mode;
      const encoded_bytes = warning_evaluation.encoded_bytes;
      const machine_encoded_bytes = this.font_service.measure_encoded_bytes(dst || src);
      const proofread_encoded_bytes = this.font_service.measure_encoded_bytes(
        proofread_translation || dst || src,
      );
      const capacity = metadata.classification.slot_capacity;
      const overflow = warning_evaluation.overflow;
      const worker_warnings = Array.isArray(item["fe_warning_codes"])
        ? item["fe_warning_codes"].map(String)
        : [];
      const warnings = [...new Set([...warning_evaluation.warnings, ...worker_warnings])];
      return [
        {
          item_id: Number(item["id"] ?? item["item_id"] ?? 0),
          occurrence_id: Number(
            item["fe_physical_occurrence_id"] ?? item["id"] ?? item["item_id"] ?? 0,
          ),
          text_unit_id: Number(item["fe_text_unit_id"] ?? 0),
          occurrence_count: Math.max(1, Number(item["fe_occurrence_count"] ?? 1)),
          file_path: String(item["file_path"] ?? ""),
          row_number: Number(item["row"] ?? item["row_number"] ?? 0),
          src,
          dst,
          machine_translation: dst,
          proofread_translation,
          effective_translation: translated,
          status: String(item["status"] ?? "NONE"),
          warnings,
          overflow,
          display_mode: read_fate_extra_display_mode(metadata),
          resolved_display_mode: display_mode,
          display_resolution,
          encoded_bytes,
          machine_encoded_bytes,
          proofread_encoded_bytes,
          slot_capacity: capacity,
          classification: metadata.classification,
          index: { path: metadata.path, char_offset: metadata.char_offset },
        },
      ];
    });
    return {
      total: Number(page["total"] ?? -1) >= 0 ? Number(page["total"] ?? 0) : file_summary.total,
      position,
      items: rows,
      files: file_summary.files,
      file_counts: file_summary.file_counts,
      view_mode,
      requested_view_mode,
      review_scope:
        page["review_scope"] === "unit" ? "unit" : view_mode === "unique" ? "unit" : "occurrence",
      index_ready: index_state["ready"] === true,
      index_state,
      query_id: Math.trunc(Number(body["query_id"] ?? 0)),
      index_generation: Number(index_state["search_generation"] ?? 0),
      navigation_generation: Number(index_state["navigation_generation"] ?? 0),
      applied_navigation_revision: Number(index_state["navigation_items_revision"] ?? 0),
      navigation_state: index_state["navigation_ready"] === true ? "ready" : "updating",
      applied_items_revision: Number(
        index_state["search_ready"] === true
          ? (index_state["search_items_revision"] ?? 0)
          : (index_state["items_revision"] ?? 0),
      ),
      search_state: search === "" || index_state["search_ready"] === true ? "ready" : "updating",
    } as unknown as JsonRecord;
  }

  public rebuild_duplicate_index(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    if (this.workers === null) {
      throw new AppErrors.InternalInvariantError({
        diagnostic_context: { reason: "fate_extra_preview_index_worker_missing" },
      });
    }
    const project_epoch = this.ensure_project_epoch(project_path);
    const project_meta = this.read_record_operation("getAllMeta", project_path) as JsonRecord;
    const items_revision = get_section_revision(project_meta, "items");
    const database_identity = JSON.stringify(project_meta[FATE_EXTRA_ADAPTER_META_KEY] ?? null);
    const index_state = read_record(
      this.database.execute({
        name: "getFateExtraTextUnitIndexState",
        args: { projectPath: project_path },
      }),
    );
    const workers = this.workers;
    const snapshot = this.index_coordinator.start({
      projectIdentity: this.native_fs.to_identity_path(project_path),
      projectEpoch: project_epoch,
      itemsRevision: items_revision,
      databaseIdentity: database_identity,
      reuseSucceeded:
        index_state["ready"] === true &&
        index_state["search_ready"] === true &&
        index_state["navigation_ready"] === true &&
        Number(index_state["search_items_revision"] ?? -1) === items_revision,
      run: async (signal, report_progress) => {
        try {
          const result = read_record(
            await workers.index.run(
              {
                type: "fate_extra_preview_index",
                input: {
                  projectPath: project_path,
                  expectedItemsRevision: items_revision,
                },
              },
              signal,
              report_progress,
            ),
          );
          this.assert_worker_result_is_current(project_path, project_epoch, {
            items: items_revision,
          });
          const built_generation = Number(result["built_generation"] ?? 0);
          const built_adapter_value = String(result["built_adapter_value"] ?? "");
          if (
            Number(result["built_items_revision"] ?? -1) !== items_revision ||
            built_generation <= 0 ||
            built_adapter_value === ""
          ) {
            throw new AppErrors.InternalInvariantError({
              diagnostic_context: {
                reason: "fate_extra_preview_index_incomplete",
                expected_items_revision: items_revision,
                result,
              },
            });
          }
          // assert epoch/revision 与同步短事务之间没有 await；同路径 close/reopen
          // 事件无法插入并把旧 epoch 的 inactive generation 激活。
          report_progress({ phase: "publishing", completed: 0, total: null });
          const activated = read_record(
            this.database.execute({
              name: "activateFateExtraPreviewSearchGeneration",
              args: {
                projectPath: project_path,
                generation: built_generation,
                expectedItemsRevision: items_revision,
                expectedAdapterValue: built_adapter_value,
              },
            }),
          );
          // 发布已提交；后续取消不能把 durable generation 报告为未提交。
          await workers.index.run(
            {
              type: "fate_extra_preview_index_cleanup",
              input: { projectPath: project_path },
            },
            new AbortController().signal,
          );
          this.duplicate_index_ready.add(project_path);
          return new FateExtraCommittedJobOutcome({
            ...activated,
            built_generation,
            built_items_revision: items_revision,
          } as unknown as ApiJsonValue);
        } catch (error) {
          try {
            await workers.index.run(
              {
                type: "fate_extra_preview_index_cleanup",
                input: { projectPath: project_path },
              },
              new AbortController().signal,
            );
          } catch (cleanup_error) {
            throw new AggregateError(
              [error, cleanup_error],
              "FE 预览索引任务失败且非活动 generation 清理失败。",
            );
          }
          throw error;
        }
      },
    });
    return this.job_snapshot_json(snapshot);
  }

  /** Return the current master-script entry with two neighbours on each side.
   * The order is DAT-local and follows char offsets from the complete JP source,
   * not route-file order or exact-source deduplication order.
   */
  public context(body: JsonRecord): JsonRecord {
    const project_path = this.require_loaded_project(body);
    const resource_path = this.require_string(body, "resource_path");
    const char_offset = Math.trunc(Number(body["char_offset"] ?? -1));
    const radius = Math.max(0, Math.min(20, Math.trunc(Number(body["radius"] ?? 2))));
    if (resource_path === "" || char_offset < 0) {
      this.throw_validation_error("Invalid Fate/Extra context index.");
    }
    const result = read_record(
      this.database.execute({
        name: "getFateExtraContext",
        args: {
          projectPath: project_path,
          resourcePath: resource_path,
          charOffset: char_offset,
          radius,
        },
      }),
    );
    const rows = Array.isArray(result["items"]) ? result["items"] : [];
    return {
      found: result["found"] === true,
      resource_path: String(result["resource_path"] ?? resource_path),
      target_ordinal: Number(result["target_ordinal"] ?? -1),
      block_count: Number(result["block_count"] ?? 0),
      radius,
      items: rows.map((value) => {
        const row = read_record(value);
        const item = read_record(row["item"]);
        const fallback_source = String(row["fallback_source"] ?? "");
        const source = String(item["src"] ?? fallback_source);
        const machine_translation = String(item["dst"] ?? "") || source;
        const metadata = read_fate_extra_item_metadata(
          item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
        );
        return {
          item_id: Number(item["id"] ?? row["representative_item_id"] ?? 0),
          char_offset: Number(row["char_offset"] ?? -1),
          block_ordinal: Number(row["block_ordinal"] ?? -1),
          is_current: Number(row["char_offset"] ?? -1) === char_offset,
          source,
          machine_translation,
          proofread_translation:
            metadata === null ? "" : read_fate_extra_proofread_translation(metadata),
          status: String(item["status"] ?? "NONE"),
        };
      }),
    } as unknown as JsonRecord;
  }

  private assert_duplicate_index_ready(project_path: string): void {
    if (this.duplicate_index_ready.has(project_path)) return;
    const state = read_record(
      this.database.execute({
        name: "getFateExtraTextUnitIndexState",
        args: { projectPath: project_path },
      }),
    );
    if (state["ready"] !== true) {
      throw new AppErrors.RequestValidationError({
        diagnostic_context: {
          reason: "fate_extra_preview_index_updating",
          item_count: state["item_count"],
          occurrence_count: state["occurrence_count"],
        },
      });
    }
    this.duplicate_index_ready.add(project_path);
  }

  public preview(body: JsonRecord): JsonRecord {
    const text = String(body["text"] ?? "");
    const requested_mode = String(body["display_mode"] ?? "unknown");
    const display_mode: FateExtraResolvedDisplayMode =
      requested_mode === "dialogue" || requested_mode === "fullscreen" || requested_mode === "poem"
        ? requested_mode
        : "unknown";
    const layout = layout_fate_extra_preview({
      text,
      display_mode,
      line_limit: Number(body["line_limit"] ?? 0),
      state: {
        servant_index: Number(body["servant_index"] ?? 0),
        gender_index: Number(body["gender_index"] ?? 0),
      },
    });
    return {
      ...layout,
      encoded_bytes: this.font_service.measure_encoded_bytes(text),
    } as unknown as JsonRecord;
  }

  public async save_review(body: JsonRecord): Promise<JsonRecord> {
    return await this.operation_gate.run_exclusive_project_write(async () => {
      const result = await this.save_review_with_write_lease(body);
      const project_path = this.require_loaded_project(body);
      const row = this.database.execute({
        name: "getFateExtraPreviewOccurrence",
        args: {
          projectPath: project_path,
          occurrenceId: Number(body["occurrence_id"]),
        },
      });
      const page = this.assemble_preview_items_page(
        body,
        { items: row === null ? [] : [row] },
        {},
        { files: [], file_counts: {}, total: 1 },
      );
      return {
        ...result,
        item: Array.isArray(page["items"]) ? (page["items"][0] ?? null) : null,
        sectionRevisions: build_section_revisions_from_meta(
          this.read_record_operation("getAllMeta", project_path) as JsonRecord,
        ),
      };
    });
  }

  /** FE 校对读取、revision 校验与提交共享同一项目写租约。 */
  private async save_review_with_write_lease(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const item_id = Math.trunc(Number(body["item_id"] ?? 0));
    if (!Number.isInteger(item_id) || item_id <= 0) {
      this.throw_validation_error("无效的 FE 文本条目编号。");
    }
    const occurrence_id = Math.trunc(Number(body["occurrence_id"] ?? 0));
    if (!Number.isInteger(occurrence_id) || occurrence_id <= 0) {
      this.throw_validation_error("无效的 FE 物理位置编号。");
    }
    const project_mode = resolve_fate_extra_project_mode(
      this.read_record_operation("getAllMeta", project_path),
    );
    const compact = project_mode === "fate-extra-compact";
    const rows = this.database.execute({
      name: "getItemsByIds",
      args: { projectPath: project_path, itemIds: [item_id] },
    });
    const item = Array.isArray(rows) ? read_record(rows[0]) : {};
    const metadata = read_fate_extra_item_metadata(
      item["extra_field"] as Parameters<typeof read_fate_extra_item_metadata>[0],
    );
    if (metadata === null) this.throw_validation_error("该条目不是有效的 FE 文本。");
    const requested_mode = String(body["display_mode"] ?? "auto");
    const display_mode: FateExtraDisplayMode =
      requested_mode === "dialogue" || requested_mode === "fullscreen" || requested_mode === "poem"
        ? requested_mode
        : "auto";
    const review_scope = String(body["review_scope"] ?? "occurrence");
    const unit_id = Math.trunc(Number(body["text_unit_id"] ?? 0));
    const proofread_translation = String(body["proofread_translation"] ?? "");
    if (proofread_translation === read_fate_extra_proofread_translation(metadata)) {
      return (await this.write_store.apply_fate_extra_display_mode({
        projectPath: project_path,
        expectedSectionRevisions: body["expected_section_revisions"],
        itemId: item_id,
        occurrenceId: occurrence_id,
        displayMode: display_mode,
        compact,
      })) as unknown as JsonRecord;
    }
    if (review_scope === "unit") {
      if (!Number.isInteger(unit_id) || unit_id <= 0) {
        this.throw_validation_error("无效的 FE 严格重复组编号。");
      }
      this.assert_duplicate_index_ready(project_path);
      return (await this.write_store.apply_fate_extra_text_unit_review({
        projectPath: project_path,
        expectedSectionRevisions: body["expected_section_revisions"],
        unitId: unit_id,
        compact,
        itemId: item_id,
        occurrenceId: occurrence_id,
        proofreadTranslation: proofread_translation,
        displayMode: display_mode,
      })) as unknown as JsonRecord;
    }
    const next_metadata: FateExtraItemMetadata = {
      ...metadata,
      proofread_translation,
      ...(compact ? {} : { display_mode }),
    };
    const result = await this.write_store.apply_fate_extra_item_metadata({
      projectPath: project_path,
      expectedSectionRevisions: body["expected_section_revisions"],
      itemId: item_id,
      extraField: merge_fate_extra_item_metadata(
        item["extra_field"] as Parameters<typeof merge_fate_extra_item_metadata>[0],
        next_metadata,
      ) as ApiJsonValue,
      ...(compact
        ? {
            occurrenceDisplay: {
              occurrenceId: occurrence_id,
              displayMode: display_mode,
            },
          }
        : {}),
    });
    return result as unknown as JsonRecord;
  }

  public async export_project(body: JsonRecord): Promise<JsonRecord> {
    return await this.operation_gate.run_exclusive_project_write(
      async () => await this.export_project_with_write_lease(body),
    );
  }

  /** 导出快照、文件发布和 adapter meta 提交共享同一项目租约。 */
  private async export_project_with_write_lease(body: JsonRecord): Promise<JsonRecord> {
    const project_path = this.require_loaded_project(body);
    const output_directory = path.resolve(this.require_string(body, "output_directory"));
    if (path.parse(output_directory).root === output_directory) {
      this.throw_validation_error("FE 导出目录不能是文件系统根目录。");
    }
    if (
      this.native_fs.to_identity_path(output_directory) ===
      this.native_fs.to_identity_path(path.resolve(project_path))
    ) {
      this.throw_validation_error("FE 导出目录不能与当前项目文件相同。");
    }
    if (
      this.native_fs.exists(output_directory) &&
      !this.native_fs.stat(output_directory).isDirectory()
    ) {
      this.throw_validation_error("FE 导出目标必须是目录。");
    }
    const restore_index = body["restore_index"] === true || body["mode"] === "restore-index";
    const meta = this.read_record_operation("getAllMeta", project_path);
    const adapter = read_record(meta[FATE_EXTRA_ADAPTER_META_KEY]);
    if (adapter["enabled"] !== true || Number(adapter["schema_version"]) !== 1) {
      this.throw_validation_error(
        "当前项目尚未启用 Fate/Extra 汉化适配。请先生成扫描报告，再应用 FE 适配。",
      );
    }
    const compact_state = read_record(
      this.database.execute({
        name: "getFateExtraCompactState",
        args: { projectPath: project_path },
      }),
    );
    const compact_export = compact_state["enabled"] === true;
    return await this.export_fate_extra_project({
      project_path,
      output_directory,
      restore_index,
      adapter,
      compact_export,
      expected_item_count: compact_export
        ? Number(compact_state["physical_item_count"] ?? 0)
        : Number(adapter["logical_text_count"] ?? 0),
    });
  }

  /** 普通与精简工程的遍历、文件生成和字库构建均在专用 worker 中执行。 */
  private async export_fate_extra_project(args: {
    project_path: string;
    output_directory: string;
    restore_index: boolean;
    adapter: MutableRecord;
    compact_export: boolean;
    expected_item_count: number;
  }): Promise<JsonRecord> {
    const classification_database = String(args.adapter["classification_database"] ?? "");
    if (
      args.compact_export &&
      (classification_database === "" || !this.native_fs.exists(classification_database))
    ) {
      this.throw_validation_error("FE 工程导出需要有效的文本安全分类数据库。");
    }
    const workers = this.workers;
    if (workers === null) throw new Error("FE export worker 尚未初始化。");
    const guarded_revisions = this.read_guarded_project_revisions(args.project_path);
    const staging_directory = path.join(
      path.dirname(args.output_directory),
      `.linguagacha-fe-export-${randomUUID()}`,
    );
    const font_relative_path = path.join("fate-extra-font", "NPJH50247");
    const font_output = path.join(args.output_directory, font_relative_path);
    this.native_fs.make_dir(staging_directory);
    try {
      const worker_result = await workers.export.run(
        {
          type: "fate_extra_export_stage",
          input: {
            projectPath: args.project_path,
            stagingDirectory: staging_directory,
            classificationDatabase: classification_database,
            projectMode: args.compact_export ? "compact" : "full",
            restoreIndex: args.restore_index,
            adapter: args.adapter as unknown as JsonRecord,
            expectedItemCount: args.expected_item_count,
            guardedRevisions: guarded_revisions,
            fontBuildInput: this.font_service.read_worker_build_input(),
            encodedWidths: this.font_service.read_encoded_width_snapshot(),
          },
        },
        new AbortController().signal,
      );
      const current_revisions = this.read_guarded_project_revisions(args.project_path);
      if (
        FATE_EXTRA_GUARDED_SECTIONS.some(
          (section) => current_revisions[section] !== guarded_revisions[section],
        )
      ) {
        this.throw_validation_error("导出期间 FE 工程 revision 已变化，请重新导出。");
      }
      const publication = args.compact_export
        ? this.publish_compact_export_staging({
            staging_directory,
            output_directory: args.output_directory,
          })
        : this.publish_full_export_staging({
            staging_directory,
            output_directory: args.output_directory,
          });
      try {
        await this.write_store.apply_project_settings_meta({
          projectPath: args.project_path,
          meta: {
            [FATE_EXTRA_ADAPTER_META_KEY]: {
              ...args.adapter,
              font_corpus_hash: String(worker_result.font_manifest["corpus_sha256"] ?? ""),
              font_manifest_hash: String(worker_result.font_manifest["manifest_sha256"] ?? ""),
              remaining_extension_slots: Number(
                worker_result.font_manifest["remaining_extension_slots"] ?? 0,
              ),
            } as unknown as ApiJsonValue,
          },
        });
        publication.finalize();
      } catch (error) {
        try {
          publication.rollback();
        } catch (rollback_error) {
          throw new AggregateError(
            [error, rollback_error],
            "FE 工程 adapter meta 写入与输出回滚均失败。",
          );
        }
        throw error;
      }
      return {
        accepted: true,
        ...(args.compact_export ? { compact_export: true } : {}),
        mode: args.restore_index ? "restore-index" : "without-index",
        output_files: worker_result.output_files.map((relative_path) =>
          path.join(args.output_directory, relative_path),
        ),
        qa_report: path.join(args.output_directory, worker_result.qa_report),
        qa_report_csv: path.join(args.output_directory, worker_result.qa_report_csv),
        safety_manifest: path.join(args.output_directory, worker_result.safety_manifest),
        warning_count: worker_result.warning_count,
        blocker_count: worker_result.blocker_count,
        exported_count: worker_result.exported_count,
        font_output,
        font_manifest: worker_result.font_manifest,
      } as unknown as JsonRecord;
    } finally {
      if (this.native_fs.exists(staging_directory)) {
        this.native_fs.remove(staging_directory, { recursive: true, force: true });
      }
    }
  }

  private publish_compact_export_staging(args: {
    staging_directory: string;
    output_directory: string;
  }): ExportPublication {
    const previous_directory = this.native_fs.exists(args.output_directory)
      ? `${args.output_directory}.linguagacha-old-${randomUUID()}`
      : "";
    if (previous_directory !== "") {
      this.native_fs.rename(args.output_directory, previous_directory);
    }
    try {
      this.native_fs.rename(args.staging_directory, args.output_directory);
    } catch (error) {
      if (previous_directory !== "") {
        this.native_fs.rename(previous_directory, args.output_directory);
      }
      throw error;
    }
    let active = true;
    return {
      finalize: () => {
        if (!active) return;
        active = false;
        if (previous_directory !== "") {
          try {
            this.native_fs.remove(previous_directory, { recursive: true, force: true });
          } catch {
            // 新目录与 adapter meta 已提交；唯一 old 目录仅作为可人工清理的恢复副本。
          }
        }
      },
      rollback: () => {
        if (!active) return;
        this.native_fs.remove(args.output_directory, { recursive: true, force: true });
        if (previous_directory !== "") {
          this.native_fs.rename(previous_directory, args.output_directory);
        }
        active = false;
      },
    };
  }

  /** 普通工程只发布本次生成的文件，输出目录中的其他用户内容保持不变。 */
  private publish_full_export_staging(args: {
    staging_directory: string;
    output_directory: string;
  }): ExportPublication {
    const backup_directory = path.join(
      path.dirname(args.output_directory),
      `.linguagacha-fe-export-old-${randomUUID()}`,
    );
    const staged_files = this.collect_staged_export_files(args.staging_directory);
    const actions: Array<{
      destination: string;
      backup: string;
      backup_moved: boolean;
      new_published: boolean;
    }> = [];
    const created_directories = new Set<string>();
    const ensure_output_parent = (directory: string): void => {
      const missing: string[] = [];
      let current = directory;
      while (!this.native_fs.exists(current)) {
        const relative = path.relative(args.output_directory, current);
        if (relative.startsWith("..") || path.isAbsolute(relative)) break;
        missing.push(current);
        if (relative === "") break;
        current = path.dirname(current);
      }
      this.native_fs.make_dir(directory);
      for (const value of missing) created_directories.add(value);
    };
    const rollback_actions = (): void => {
      let first_error: unknown;
      for (const action of [...actions].reverse()) {
        try {
          if (action.new_published && this.native_fs.exists(action.destination)) {
            this.native_fs.remove(action.destination, { force: true });
          }
          if (action.backup_moved && this.native_fs.exists(action.backup)) {
            this.native_fs.ensure_parent_dir(action.destination);
            this.native_fs.rename(action.backup, action.destination);
          }
        } catch (error) {
          first_error ??= error;
        }
      }
      for (const directory of [...created_directories].sort(
        (left, right) => right.length - left.length,
      )) {
        try {
          if (this.native_fs.exists(directory)) {
            this.native_fs.remove(directory, { force: true });
          }
        } catch {
          // 目录中若有用户并发新增内容则保留，不把清理升级为数据删除。
        }
      }
      if (this.native_fs.exists(backup_directory)) {
        try {
          this.native_fs.remove(backup_directory, { recursive: true, force: true });
        } catch (error) {
          first_error ??= error;
        }
      }
      if (first_error !== undefined) throw first_error;
    };
    try {
      for (const relative_path of staged_files) {
        const staged_path = resolve_fate_extra_export_path(args.staging_directory, relative_path);
        const destination = resolve_fate_extra_export_path(args.output_directory, relative_path);
        const backup = resolve_fate_extra_export_path(backup_directory, relative_path);
        ensure_output_parent(path.dirname(destination));
        const action = { destination, backup, backup_moved: false, new_published: false };
        actions.push(action);
        if (this.native_fs.exists(destination)) {
          if (this.native_fs.stat(destination).isDirectory()) {
            throw new Error(`FE 导出目标被目录占用：${destination}`);
          }
          this.native_fs.ensure_parent_dir(backup);
          this.native_fs.rename(destination, backup);
          action.backup_moved = true;
        }
        this.native_fs.rename(staged_path, destination);
        action.new_published = true;
      }
    } catch (error) {
      try {
        rollback_actions();
      } catch (rollback_error) {
        throw new AggregateError([error, rollback_error], "FE 普通工程发布与回滚均失败。");
      }
      throw error;
    }
    let active = true;
    return {
      finalize: () => {
        if (!active) return;
        active = false;
        if (this.native_fs.exists(backup_directory)) {
          try {
            this.native_fs.remove(backup_directory, { recursive: true, force: true });
          } catch {
            // 新文件与 adapter meta 已提交；old 目录仅作为可人工清理的恢复副本。
          }
        }
      },
      rollback: () => {
        if (!active) return;
        rollback_actions();
        active = false;
      },
    };
  }

  private collect_staged_export_files(directory: string, relative = ""): string[] {
    const current = relative === "" ? directory : path.join(directory, relative);
    const files: string[] = [];
    for (const entry of this.native_fs.read_dirents(current)) {
      const child_relative = relative === "" ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collect_staged_export_files(directory, child_relative));
      } else if (entry.isFile()) {
        files.push(child_relative);
      }
    }
    return files.sort((left, right) => left.localeCompare(right));
  }

  private ensure_project_epoch(project_path: string): number {
    const identity = this.native_fs.to_identity_path(project_path);
    if (identity !== this.project_identity) this.advance_project_epoch(project_path);
    return this.project_epoch;
  }

  private advance_project_epoch(project_path: string): void {
    this.jobs.cancel_all();
    this.cleanup_scan_draft_handle();
    this.display_file_summary_cache.clear();
    this.duplicate_index_ready.clear();
    this.project_epoch += 1;
    this.project_identity =
      project_path === "" ? "" : this.native_fs.to_identity_path(project_path);
  }

  private assert_worker_result_is_current(
    project_path: string,
    project_epoch: number,
    expected_revisions: Readonly<Record<string, number>>,
  ): void {
    const state = this.session_state.snapshot();
    const same_project =
      state.loaded &&
      this.native_fs.to_identity_path(state.projectPath) ===
        this.native_fs.to_identity_path(project_path);
    const current_revisions = same_project
      ? this.read_guarded_project_revisions(project_path)
      : null;
    const same_revisions =
      current_revisions !== null &&
      Object.entries(expected_revisions).every(
        ([section, revision]) => current_revisions[section as FateExtraGuardedSection] === revision,
      );
    if (this.project_epoch !== project_epoch || !same_project || !same_revisions) {
      this.throw_validation_error("项目或 revision 已变化，已丢弃迟到的 FE 后台任务结果。");
    }
  }

  private job_snapshot_json(snapshot: FateExtraJobSnapshot): JsonRecord {
    return {
      ...snapshot,
      ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
      ...(snapshot.error === undefined ? {} : { error: { ...snapshot.error } }),
    } as unknown as JsonRecord;
  }

  private prune_expired_scan_draft(): void {
    if (this.scan_draft_handle !== null && this.scan_draft_handle.expires_at <= Date.now()) {
      this.cleanup_scan_draft_handle();
    }
  }

  private cleanup_scan_draft_handle(): void {
    if (this.scan_draft_expiry_timer !== null) {
      clearTimeout(this.scan_draft_expiry_timer);
      this.scan_draft_expiry_timer = null;
    }
    const handle = this.scan_draft_handle;
    this.scan_draft_handle = null;
    if (handle !== null) this.remove_staging_file(handle.staging_path);
  }

  private schedule_scan_draft_expiry(scan_id: string): void {
    if (this.scan_draft_expiry_timer !== null) clearTimeout(this.scan_draft_expiry_timer);
    const remaining = Math.max(
      0,
      (this.scan_draft_handle?.scan_id === scan_id
        ? this.scan_draft_handle.expires_at
        : Date.now()) - Date.now(),
    );
    this.scan_draft_expiry_timer = setTimeout(() => {
      if (this.scan_draft_handle?.scan_id === scan_id) this.cleanup_scan_draft_handle();
    }, remaining);
    this.scan_draft_expiry_timer.unref();
  }

  private pause_scan_draft_expiry(scan_id: string): number {
    const handle = this.scan_draft_handle;
    if (handle === null || handle.scan_id !== scan_id) return 0;
    if (this.scan_draft_expiry_timer !== null) {
      clearTimeout(this.scan_draft_expiry_timer);
      this.scan_draft_expiry_timer = null;
    }
    return Math.max(0, handle.expires_at - Date.now());
  }

  private resume_scan_draft_expiry(scan_id: string, remaining_ttl: number): void {
    const handle = this.scan_draft_handle;
    if (handle === null || handle.scan_id !== scan_id) return;
    if (remaining_ttl <= 0) {
      this.cleanup_scan_draft_handle();
      return;
    }
    handle.expires_at = Date.now() + remaining_ttl;
    this.schedule_scan_draft_expiry(scan_id);
  }

  private read_scan_apply_commit_state(
    project_path: string,
    scan_id: string,
    apply_token: string,
  ): "committed" | "not-committed" | "unknown" {
    const receipt_result = this.read_scan_apply_receipt(project_path);
    if (receipt_result.status === "invalid") return "unknown";
    if (receipt_result.status === "absent") return "not-committed";
    return receipt_result.receipt.scan_id === scan_id &&
      this.scan_apply_receipt_matches_artifacts(receipt_result.receipt, project_path, apply_token)
      ? "committed"
      : "not-committed";
  }

  private cleanup_scan_apply_artifacts(
    project_path: string,
    apply_token: string,
    preserve_backup: boolean,
  ): void {
    const artifacts = build_fate_extra_scan_apply_artifact_paths(project_path, apply_token);
    if (!preserve_backup) this.remove_file_if_present(artifacts.backup_path);
    this.remove_file_if_present(artifacts.migration_report_json_temporary);
    this.remove_file_if_present(artifacts.migration_report_csv_temporary);
    // manifest 最后删除；中途清理失败时下次启动仍能重新判定 backup 是否已提交。
    this.remove_file_if_present(artifacts.pending_manifest_path);
  }

  private recover_scan_apply_artifacts(project_path: string): void {
    const receipt_result = this.read_scan_apply_receipt(project_path);
    // 读取失败或 receipt 损坏时无法区分已提交与未提交，必须保留所有回滚点。
    if (receipt_result.status === "invalid") return;
    let entries: ReturnType<NativeFs["read_dirents"]>;
    try {
      entries = this.native_fs.read_dirents(path.dirname(project_path));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const apply_token = parse_fate_extra_scan_apply_pending_manifest_name(
        project_path,
        entry.name,
      );
      if (apply_token === null) continue;
      const artifacts = build_fate_extra_scan_apply_artifact_paths(project_path, apply_token);
      const manifest = this.read_scan_apply_pending_manifest(artifacts.pending_manifest_path);
      if (
        manifest === null ||
        manifest.apply_token !== apply_token ||
        !this.paths_have_same_identity(manifest.project_path, project_path) ||
        !this.paths_have_same_identity(manifest.backup_path, artifacts.backup_path) ||
        !this.paths_have_same_identity(
          manifest.migration_report_json_temporary,
          artifacts.migration_report_json_temporary,
        ) ||
        !this.paths_have_same_identity(
          manifest.migration_report_csv_temporary,
          artifacts.migration_report_csv_temporary,
        )
      ) {
        continue;
      }

      const committed =
        receipt_result.status === "valid" &&
        this.scan_apply_receipt_matches_artifacts(
          receipt_result.receipt,
          project_path,
          apply_token,
        );
      const prior_receipt_unchanged =
        (receipt_result.status === "absent" ? null : receipt_result.receipt.apply_token) ===
        manifest.previous_receipt_apply_token;
      if (!committed && !prior_receipt_unchanged) {
        // 存在更新的 receipt 时状态有歧义；只清理报告临时文件，不触碰可能已提交的备份。
        this.remove_file_if_present(artifacts.migration_report_json_temporary);
        this.remove_file_if_present(artifacts.migration_report_csv_temporary);
        continue;
      }
      this.cleanup_scan_apply_artifacts(project_path, apply_token, committed);
    }
  }

  private read_scan_apply_receipt(project_path: string): ScanApplyReceiptReadResult {
    try {
      const value = this.database.execute({
        name: "getMeta",
        args: {
          projectPath: project_path,
          key: FATE_EXTRA_SCAN_APPLY_RECEIPT_META_KEY,
          default: null,
        },
      });
      if (value === null || value === undefined) return { status: "absent", receipt: null };
      const receipt = read_fate_extra_scan_apply_receipt(value);
      return receipt === null ? { status: "invalid", receipt: null } : { status: "valid", receipt };
    } catch {
      return { status: "invalid", receipt: null };
    }
  }

  private read_scan_apply_pending_manifest(
    manifest_path: string,
  ): ReturnType<typeof read_fate_extra_scan_apply_pending_manifest> {
    try {
      return read_fate_extra_scan_apply_pending_manifest(
        JsonTool.parseStrict(this.native_fs.read_text_file(manifest_path)),
      );
    } catch {
      return null;
    }
  }

  private scan_apply_receipt_matches_artifacts(
    receipt: FateExtraScanApplyReceipt,
    project_path: string,
    apply_token: string,
  ): boolean {
    if (receipt.apply_token !== apply_token) return false;
    const artifacts = build_fate_extra_scan_apply_artifact_paths(project_path, apply_token);
    return (
      this.paths_have_same_identity(receipt.backup_path, artifacts.backup_path) &&
      this.paths_have_same_identity(
        receipt.migration_report_json,
        artifacts.migration_report_json,
      ) &&
      this.paths_have_same_identity(receipt.migration_report_csv, artifacts.migration_report_csv)
    );
  }

  private paths_have_same_identity(left: string, right: string): boolean {
    try {
      return this.native_fs.to_identity_path(left) === this.native_fs.to_identity_path(right);
    } catch {
      return false;
    }
  }

  private remove_file_if_present(file_path: string): void {
    if (!this.native_fs.exists(file_path)) return;
    try {
      this.native_fs.remove(file_path, { force: true });
    } catch {
      // worker 已退出后仍清理失败时保留路径供启动残留审计，不遮蔽原始任务结果。
    }
  }

  private remove_staging_file(staging_path: string): void {
    if (staging_path === "") return;
    for (const file_path of [staging_path, `${staging_path}-wal`, `${staging_path}-shm`]) {
      this.remove_file_if_present(file_path);
    }
    const directory = path.dirname(staging_path);
    const base_name = path.basename(staging_path);
    try {
      for (const entry of this.native_fs.read_dirents(directory)) {
        if (!entry.isFile() || !entry.name.startsWith(`${base_name}.`)) continue;
        const suffix = entry.name.slice(base_name.length);
        if (
          !/^\.(?:classification|migration)\.sqlite(?:-(?:wal|shm))?$/u.test(suffix) &&
          !/^\.verify-input-\d+\.sqlite(?:-(?:wal|shm))?$/u.test(suffix) &&
          suffix !== ".supplement.tmp"
        ) {
          continue;
        }
        this.remove_file_if_present(path.join(directory, entry.name));
      }
    } catch {
      // 目录可能在 worker 退出前由另一路清理；显式路径的下一次重试仍可继续。
    }
  }

  private cancel_active_jobs_and_cleanup_draft(): void {
    this.jobs.cancel_all();
    this.cleanup_scan_draft_handle();
  }

  private cleanup_residual_scan_staging(project_path: string): void {
    const directory = path.dirname(project_path);
    for (const entry of this.native_fs.read_dirents(directory)) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(FATE_EXTRA_SCAN_STAGING_PREFIX) ||
        !entry.name.endsWith(".sqlite")
      ) {
        continue;
      }
      this.remove_staging_file(path.join(directory, entry.name));
    }
  }

  private scan_apply_error_invalidates_draft(error: unknown): boolean {
    const diagnostic = AppErrors.is_app_error(error)
      ? JSON.stringify(error.diagnostic_context)
      : "";
    const message = error instanceof Error ? error.message : String(error);
    return /(?:已失效|已变化|revision|fingerprint)/iu.test(`${message}\n${diagnostic}`);
  }

  private annotate_scan_apply_failure(
    error: unknown,
    draft_retryable: boolean,
  ): AppErrors.AppError {
    const normalized = AppErrors.is_app_error(error)
      ? error
      : AppErrors.InternalInvariantError.from_unknown(error);
    return new AppErrors.AppError({
      code: normalized.code,
      public_details: {
        ...normalized.public_details,
        scan_draft_retryable: draft_retryable,
      },
      diagnostic_context: {
        ...normalized.diagnostic_context,
        scan_draft_retryable: draft_retryable,
      },
      cause: normalized.cause,
    });
  }

  private read_guarded_project_revisions(
    project_path: string,
  ): Record<FateExtraGuardedSection, number> {
    const meta = this.read_record_operation("getAllMeta", project_path) as JsonRecord;
    return Object.fromEntries(
      FATE_EXTRA_GUARDED_SECTIONS.map((section) => [section, get_section_revision(meta, section)]),
    ) as Record<FateExtraGuardedSection, number>;
  }

  /** compact 工程只保存代表项与物理映射，不能作为 FE 扫描或 staging 应用目标。 */
  private assert_full_project_for_scan_or_apply(project_path: string): void {
    const compact = read_record(
      this.database.execute({
        name: "getFateExtraCompactState",
        args: { projectPath: project_path },
      }),
    );
    if (compact["enabled"] === true) {
      this.throw_validation_error("精简 FE 工程不支持扫描或应用 FE 适配，请切换到完整工程。");
    }
  }

  private require_loaded_project(body: JsonRecord): string {
    const state = this.session_state.snapshot();
    if (!state.loaded || state.projectPath === "") {
      this.throw_validation_error("请先打开一个 .lg 项目。");
    }
    const requested = this.optional_string(body, "project_path", "");
    if (
      requested !== "" &&
      this.native_fs.to_identity_path(requested) !==
        this.native_fs.to_identity_path(state.projectPath)
    ) {
      this.throw_validation_error("项目已切换，请重新执行 FE 操作。");
    }
    return state.projectPath;
  }

  private read_array_operation(name: string, project_path: string): MutableRecord[] {
    const value = this.database.execute({ name, args: { projectPath: project_path } });
    return Array.isArray(value) ? value.map(read_record) : [];
  }

  private read_record_operation(name: string, project_path: string): MutableRecord {
    return read_record(this.database.execute({ name, args: { projectPath: project_path } }));
  }

  private require_string(body: JsonRecord, key: string): string {
    const value = this.optional_string(body, key, "");
    if (value === "") this.throw_validation_error(`缺少参数：${key}`);
    return value;
  }

  private optional_string(body: JsonRecord, key: string, fallback: string): string {
    return typeof body[key] === "string" && body[key].trim() !== "" ? body[key].trim() : fallback;
  }

  private optional_raw_string(body: JsonRecord, key: string, fallback: string): string {
    return typeof body[key] === "string" ? body[key] : fallback;
  }

  private assert_file(file_path: string, label: string): void {
    if (!this.native_fs.exists(file_path) || !this.native_fs.stat(file_path).isFile()) {
      this.throw_validation_error(`${label}不存在：${file_path}`);
    }
  }

  private assert_directory(directory: string, label: string): void {
    if (!this.native_fs.exists(directory) || !this.native_fs.stat(directory).isDirectory()) {
      this.throw_validation_error(`${label}不存在：${directory}`);
    }
  }

  private throw_validation_error(reason: string): never {
    throw new AppErrors.RequestValidationError({
      public_details: { reason },
      diagnostic_context: { reason },
    });
  }
}
