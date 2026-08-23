import {
  apply_fate_extra_scan_staging,
  type ApplyFateExtraScanStagingInput,
  type ApplyFateExtraScanStagingResult,
  type FateExtraApplyProgressReporter,
} from "../../database/fate-extra-scan-staging";
import { default_native_fs } from "../../../native/native-fs";

export type FateExtraApplyWorkerTaskInput = ApplyFateExtraScanStagingInput;
export type FateExtraApplyWorkerTaskResult = ApplyFateExtraScanStagingResult;

/**
 * worker 只编排 staging 提交；SQLite 生命周期和真实文件 IO 分别留在既有边界。
 */
export async function run_fate_extra_apply_worker_task(
  input: FateExtraApplyWorkerTaskInput,
  report_progress: FateExtraApplyProgressReporter = () => undefined,
): Promise<FateExtraApplyWorkerTaskResult> {
  return await apply_fate_extra_scan_staging(input, default_native_fs, report_progress);
}
