import type { DatabaseJsonValue } from "../../database/database-types";
import type { FateExtraIndexProgressReporter } from "../../../shared/fate-extra/fate-extra-index-progress";
import { query_fate_extra_preview_readonly } from "../../database/fate-extra-preview-readonly";
import {
  cleanup_fate_extra_inactive_preview_search_generations,
  run_fate_extra_index_maintenance,
} from "../../database/fate-extra-preview-search-index";

export type FateExtraPreviewIndexWorkerTaskInput = {
  projectPath: string;
  expectedItemsRevision: number;
};

export type FateExtraPreviewIndexCleanupWorkerTaskInput = {
  projectPath: string;
};

export type FateExtraPreviewSearchWorkerTaskInput = {
  projectPath: string;
  search: string;
  filePath: string;
  category: string;
  warning?: string;
  encodedWidths?: Array<[string, number]>;
  projectEpoch?: number;
  position: number;
  limit: number;
  includeFiles: boolean;
  includeTotal: boolean;
  viewMode: "unique" | "occurrence";
  expectedGeneration: number;
  expectedItemsRevision: number;
  expectedNavigationGeneration: number;
  expectedNavigationRevision: number;
};

/**
 * 派生索引在独立 SQLite 连接中分批构建；终止会回滚当前批，已提交批由 cleanup 任务回收。
 */
export function run_fate_extra_preview_index_worker_task(
  input: FateExtraPreviewIndexWorkerTaskInput,
  report_progress: FateExtraIndexProgressReporter = () => undefined,
): DatabaseJsonValue {
  const record = run_fate_extra_index_maintenance(
    input.projectPath,
    input.expectedItemsRevision,
    report_progress,
  );
  return {
    ready: false,
    search_ready: false,
    built_items_revision: record.items_revision,
    built_generation: record.generation,
    built_adapter_value: record.adapter_value,
    built_item_count: record.item_count,
    built_document_count: record.document_count,
    built_short_gram_count: record.short_gram_count,
    built_navigation_generation: record.generation,
  };
}

/** 终止维护 worker 后在新连接中回收已提交的非活动 generation。 */
export function run_fate_extra_preview_index_cleanup_worker_task(
  input: FateExtraPreviewIndexCleanupWorkerTaskInput,
): DatabaseJsonValue {
  return {
    cleaned_generations: cleanup_fate_extra_inactive_preview_search_generations(input.projectPath),
  };
}

/**
 * 预览分页与搜索隔离到专用 worker，AbortSignal 可通过终止 worker 硬取消同步 SQLite 查询。
 */
export function run_fate_extra_preview_search_worker_task(
  input: FateExtraPreviewSearchWorkerTaskInput,
): DatabaseJsonValue {
  return query_fate_extra_preview_readonly(input);
}
