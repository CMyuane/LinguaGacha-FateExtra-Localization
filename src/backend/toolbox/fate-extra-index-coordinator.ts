import type { ApiJsonValue } from "../api/api-types";
import {
  FateExtraJobCoordinator,
  type FateExtraJobProgress,
  type FateExtraJobSnapshot,
} from "./fate-extra-job-coordinator";

type StartFateExtraIndexOptions = {
  projectIdentity: string;
  projectEpoch: number;
  itemsRevision: number;
  databaseIdentity: string;
  reuseSucceeded: boolean;
  run: (
    signal: AbortSignal,
    reportProgress: (progress: FateExtraJobProgress) => void,
  ) => Promise<ApiJsonValue>;
};

/**
 * FE 预览索引任务的唯一调度入口。数据库层负责 inactive generation 的原子发布，
 * 本类只让同一工程/revision 共享一个任务快照，避免与扫描任务身份规则混在调用点。
 */
export class FateExtraIndexCoordinator {
  private readonly active_job_by_project = new Map<
    string,
    { identity_key: string; job_id: string }
  >();
  private readonly settled_barrier_by_project = new Map<string, Promise<void>>();

  public constructor(private readonly jobs: FateExtraJobCoordinator) {}

  public start(options: StartFateExtraIndexOptions): FateExtraJobSnapshot {
    const identity_key = JSON.stringify([
      "preview-index",
      options.projectIdentity,
      options.projectEpoch,
      options.itemsRevision,
      options.databaseIdentity,
    ]);
    const previous = this.active_job_by_project.get(options.projectIdentity);
    if (previous?.identity_key === identity_key) {
      const previous_snapshot = this.jobs.status(previous.job_id);
      if (
        previous_snapshot !== null &&
        (this.is_active(previous_snapshot.status) ||
          (previous_snapshot.status === "succeeded" && options.reuseSucceeded))
      ) {
        return previous_snapshot;
      }
    }
    if (previous !== undefined && previous.identity_key !== identity_key) {
      this.jobs.cancel(previous.job_id);
    }
    const previous_barrier = this.settled_barrier_by_project.get(options.projectIdentity);
    const snapshot = this.jobs.start({
      kind: "preview-index",
      identityKey: identity_key,
      projectEpoch: options.projectEpoch,
      sourceRevision: options.itemsRevision,
      phase: "building-preview-index",
      run: async (signal, report_progress) => {
        // 被取代任务必须先完成 worker 终止与 inactive generation 清理；否则旧任务的
        // 全局 cleanup 可能在新 generation 构建后、激活前把它删除。
        if (previous_barrier !== undefined) await previous_barrier;
        if (signal.aborted) throw new Error("FE 预览索引任务已取消。");
        return await options.run(signal, report_progress);
      },
    });
    const current_barrier = (previous_barrier ?? Promise.resolve())
      .then(async () => {
        await this.jobs.wait_until_finished(snapshot.job_id);
      })
      .catch(() => undefined);
    this.settled_barrier_by_project.set(options.projectIdentity, current_barrier);
    void current_barrier.then(() => {
      if (this.settled_barrier_by_project.get(options.projectIdentity) === current_barrier) {
        this.settled_barrier_by_project.delete(options.projectIdentity);
      }
    });
    this.active_job_by_project.set(options.projectIdentity, {
      identity_key,
      job_id: snapshot.job_id,
    });
    return snapshot;
  }

  private is_active(status: FateExtraJobSnapshot["status"]): boolean {
    return status === "queued" || status === "running" || status === "cancelling";
  }
}
