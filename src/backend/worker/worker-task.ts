import {
  run_proofreading_sync_worker_task,
  type ProofreadingSyncWorkerTaskInput,
} from "./tasks/proofreading-sync-worker-task";
import {
  run_quality_statistics_worker_task,
  type QualityStatisticsWorkerTaskInput,
} from "./tasks/quality-statistics-worker-task";
import {
  run_ts_conversion_worker_task,
  type TsConversionWorkerTaskInput,
} from "./tasks/ts-conversion-worker-task";
import {
  run_fate_extra_scan_worker_task,
  type FateExtraScanWorkerTaskInput,
  type FateExtraScanWorkerTaskResult,
} from "./tasks/fate-extra-scan-worker-task";
import {
  run_fate_extra_apply_worker_task,
  type FateExtraApplyWorkerTaskInput,
  type FateExtraApplyWorkerTaskResult,
} from "./tasks/fate-extra-apply-worker-task";
import {
  run_fate_extra_export_worker_task,
  type FateExtraExportWorkerTaskInput,
  type FateExtraExportWorkerTaskResult,
} from "./tasks/fate-extra-compact-export-worker-task";
import {
  run_fate_extra_preview_index_cleanup_worker_task,
  run_fate_extra_preview_index_worker_task,
  run_fate_extra_preview_search_worker_task,
  type FateExtraPreviewIndexCleanupWorkerTaskInput,
  type FateExtraPreviewIndexWorkerTaskInput,
  type FateExtraPreviewSearchWorkerTaskInput,
} from "./tasks/fate-extra-preview-worker-task";
import type { DatabaseJsonValue } from "../database/database-types";
import type { ProofreadingEvaluatedSlice } from "../../shared/proofreading/proofreading-list-reader";
import type { TsConversionConvertedItem } from "../../shared/toolbox/ts-conversion";

export type BackendWorkerTaskInputByType = {
  quality_statistics: QualityStatisticsWorkerTaskInput;
  ts_conversion: TsConversionWorkerTaskInput;
  proofreading_sync: ProofreadingSyncWorkerTaskInput;
  fate_extra_scan_stage: FateExtraScanWorkerTaskInput;
  fate_extra_apply_stage: FateExtraApplyWorkerTaskInput;
  fate_extra_export_stage: FateExtraExportWorkerTaskInput;
  fate_extra_preview_index: FateExtraPreviewIndexWorkerTaskInput;
  fate_extra_preview_index_cleanup: FateExtraPreviewIndexCleanupWorkerTaskInput;
  fate_extra_preview_search: FateExtraPreviewSearchWorkerTaskInput;
};

export type BackendWorkerTaskResultByType = {
  quality_statistics: Record<string, unknown>;
  ts_conversion: TsConversionConvertedItem[];
  proofreading_sync: ProofreadingEvaluatedSlice;
  fate_extra_scan_stage: FateExtraScanWorkerTaskResult;
  fate_extra_apply_stage: FateExtraApplyWorkerTaskResult;
  fate_extra_export_stage: FateExtraExportWorkerTaskResult;
  fate_extra_preview_index: DatabaseJsonValue;
  fate_extra_preview_index_cleanup: DatabaseJsonValue;
  fate_extra_preview_search: DatabaseJsonValue;
};

export type BackendWorkerTaskType = keyof BackendWorkerTaskInputByType;

export type BackendWorkerTask = {
  [TType in BackendWorkerTaskType]: {
    type: TType;
    input: BackendWorkerTaskInputByType[TType];
  };
}[BackendWorkerTaskType];

export type BackendWorkerTaskResult<TTask extends BackendWorkerTask> =
  BackendWorkerTaskResultByType[TTask["type"]];

export type BackendWorkerTaskProgress = {
  phase: string;
  completed: number;
  total: number | null;
};

export type BackendWorkerTaskProgressReporter = (progress: BackendWorkerTaskProgress) => void;

export async function run_worker_task<TTask extends BackendWorkerTask>(
  task: TTask,
  report_progress: BackendWorkerTaskProgressReporter = () => undefined,
): Promise<BackendWorkerTaskResult<TTask>> {
  switch (task.type) {
    case "quality_statistics":
      return run_quality_statistics_worker_task(task.input) as BackendWorkerTaskResult<TTask>;
    case "ts_conversion":
      return run_ts_conversion_worker_task(task.input) as BackendWorkerTaskResult<TTask>;
    case "proofreading_sync":
      return run_proofreading_sync_worker_task(task.input) as BackendWorkerTaskResult<TTask>;
    case "fate_extra_scan_stage":
      return (await run_fate_extra_scan_worker_task(
        task.input,
        report_progress,
      )) as BackendWorkerTaskResult<TTask>;
    case "fate_extra_apply_stage":
      return (await run_fate_extra_apply_worker_task(
        task.input,
        report_progress,
      )) as BackendWorkerTaskResult<TTask>;
    case "fate_extra_export_stage":
      return (await run_fate_extra_export_worker_task(
        task.input,
        report_progress,
      )) as BackendWorkerTaskResult<TTask>;
    case "fate_extra_preview_index":
      return run_fate_extra_preview_index_worker_task(task.input, (completed, total) =>
        report_progress({ phase: "build-preview-index", completed, total }),
      ) as BackendWorkerTaskResult<TTask>;
    case "fate_extra_preview_index_cleanup":
      return run_fate_extra_preview_index_cleanup_worker_task(
        task.input,
      ) as BackendWorkerTaskResult<TTask>;
    case "fate_extra_preview_search":
      return run_fate_extra_preview_search_worker_task(
        task.input,
      ) as BackendWorkerTaskResult<TTask>;
  }
}
