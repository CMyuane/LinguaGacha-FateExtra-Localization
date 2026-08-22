import type { ApiJsonValue } from "../../api/api-types";
import {
  build_fate_extra_scan_staging,
  type FateExtraScanProgressReporter,
  type FateExtraScanStagingBuildInput,
  type FateExtraScanStagingBuildResult,
} from "../../database/fate-extra-scan-staging-builder";
import { default_native_fs } from "../../../native/native-fs";

type JsonRecord = Record<string, ApiJsonValue>;

export type FateExtraScanWorkerTaskInput = FateExtraScanStagingBuildInput & {
  projectMeta: JsonRecord;
  body: JsonRecord;
};

export type { FateExtraInputFingerprint } from "../../database/fate-extra-scan-staging";

export type FateExtraScanWorkerTaskResult = FateExtraScanStagingBuildResult;

/**
 * 专用 worker 逐行解析输入并直接构造版本化 staging；不会创建百万对象草稿。
 */
export async function run_fate_extra_scan_worker_task(
  input: FateExtraScanWorkerTaskInput,
  report_progress: FateExtraScanProgressReporter = () => {},
): Promise<FateExtraScanWorkerTaskResult> {
  return await build_fate_extra_scan_staging(input, default_native_fs, report_progress);
}
