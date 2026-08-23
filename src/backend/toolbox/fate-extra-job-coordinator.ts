import crypto from "node:crypto";

import type { ApiJsonValue } from "../api/api-types";
import { normalize_api_error } from "../api/api-error";
import { type ApiErrorPayload, to_api_error_payload } from "../../shared/error";
import { create_text_resolver } from "../../shared/i18n";

export type FateExtraJobKind = "scan" | "scan-apply" | "preview-index";
export type FateExtraJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "cancelled"
  | "failed";

export type FateExtraJobSnapshot = {
  job_id: string;
  kind: FateExtraJobKind;
  status: FateExtraJobStatus;
  phase: string;
  completed: number;
  total: number | null;
  project_epoch: number;
  source_revision: number;
  cancellable: boolean;
  result?: ApiJsonValue;
  error?: ApiErrorPayload;
};

export type FateExtraJobProgress = Pick<FateExtraJobSnapshot, "phase" | "completed" | "total">;

/**
 * 项目事务已由 durable receipt 确认时，提交事实必须胜过同时到达的取消信号。
 */
export class FateExtraCommittedJobOutcome {
  public constructor(public readonly result: ApiJsonValue) {}
}

type FateExtraJobRecord = {
  snapshot: FateExtraJobSnapshot;
  identity_key: string;
  abort_controller: AbortController;
  finished_at: number | null;
  finished: Promise<void>;
  resolve_finished: () => void;
};

type StartFateExtraJobOptions = {
  kind: FateExtraJobKind;
  identityKey: string;
  projectEpoch: number;
  sourceRevision: number;
  phase: string;
  cancellable?: boolean;
  run: (
    signal: AbortSignal,
    reportProgress: (progress: FateExtraJobProgress) => void,
  ) => Promise<ApiJsonValue | FateExtraCommittedJobOutcome>;
};

const FINISHED_JOB_RETENTION_MS = 30 * 60 * 1000;
const JOB_ERROR_TEXT = create_text_resolver("zh-CN");

/**
 * FE 慢操作的进程内事实源。任务只保存小型快照，重型输入和结果留在 worker/staging。
 */
export class FateExtraJobCoordinator {
  private readonly jobs = new Map<string, FateExtraJobRecord>();
  private readonly active_job_by_identity = new Map<string, string>();
  private disposed = false;

  public start(options: StartFateExtraJobOptions): FateExtraJobSnapshot {
    if (this.disposed) {
      throw new Error("FateExtraJobCoordinator 已释放。");
    }
    this.cleanup_finished_jobs();
    const existing_id = this.active_job_by_identity.get(options.identityKey);
    const existing = existing_id === undefined ? undefined : this.jobs.get(existing_id);
    if (existing !== undefined && this.is_active(existing.snapshot.status)) {
      return this.clone_snapshot(existing.snapshot);
    }

    const job_id = crypto.randomUUID();
    const abort_controller = new AbortController();
    let resolve_finished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolve_finished = resolve;
    });
    const snapshot: FateExtraJobSnapshot = {
      job_id,
      kind: options.kind,
      status: "queued",
      phase: options.phase,
      completed: 0,
      total: null,
      project_epoch: options.projectEpoch,
      source_revision: options.sourceRevision,
      cancellable: options.cancellable !== false,
    };
    const record: FateExtraJobRecord = {
      snapshot,
      identity_key: options.identityKey,
      abort_controller,
      finished_at: null,
      finished,
      resolve_finished,
    };
    this.jobs.set(job_id, record);
    this.active_job_by_identity.set(options.identityKey, job_id);
    queueMicrotask(() => void this.run_job(record, options.run));
    return this.clone_snapshot(snapshot);
  }

  public status(job_id: string): FateExtraJobSnapshot | null {
    this.cleanup_finished_jobs();
    const record = this.jobs.get(job_id);
    return record === undefined ? null : this.clone_snapshot(record.snapshot);
  }

  /** 等待 runner 的清理路径完全退出；索引身份切换用它串行化旧 generation 清理与新构建。 */
  public async wait_until_finished(job_id: string): Promise<FateExtraJobSnapshot | null> {
    const record = this.jobs.get(job_id);
    if (record === undefined) return null;
    await record.finished;
    return this.clone_snapshot(record.snapshot);
  }

  public cancel(job_id: string): FateExtraJobSnapshot | null {
    const record = this.jobs.get(job_id);
    if (record === undefined) return null;
    if (!record.snapshot.cancellable || !this.is_active(record.snapshot.status)) {
      return this.clone_snapshot(record.snapshot);
    }
    record.snapshot.status = "cancelling";
    record.snapshot.phase = "cancelling";
    record.abort_controller.abort();
    return this.clone_snapshot(record.snapshot);
  }

  public cancel_all(): void {
    for (const record of this.jobs.values()) {
      if (!record.snapshot.cancellable || !this.is_active(record.snapshot.status)) continue;
      record.snapshot.status = "cancelling";
      record.snapshot.phase = "cancelling";
      record.abort_controller.abort();
    }
  }

  public cancel_kind(kind: FateExtraJobKind): void {
    for (const record of this.jobs.values()) {
      if (
        record.snapshot.kind !== kind ||
        !record.snapshot.cancellable ||
        !this.is_active(record.snapshot.status)
      ) {
        continue;
      }
      record.snapshot.status = "cancelling";
      record.snapshot.phase = "cancelling";
      record.abort_controller.abort();
    }
  }

  public dispose(): void {
    this.disposed = true;
    for (const record of this.jobs.values()) {
      if (this.is_active(record.snapshot.status)) {
        record.abort_controller.abort();
      }
    }
    this.active_job_by_identity.clear();
    this.jobs.clear();
  }

  private async run_job(
    record: FateExtraJobRecord,
    runner: (
      signal: AbortSignal,
      reportProgress: (progress: FateExtraJobProgress) => void,
    ) => Promise<ApiJsonValue | FateExtraCommittedJobOutcome>,
  ): Promise<void> {
    if (record.abort_controller.signal.aborted) {
      this.finish_cancelled(record);
      return;
    }
    record.snapshot.status = "running";
    try {
      const outcome = await runner(record.abort_controller.signal, (progress) => {
        if (record.abort_controller.signal.aborted || record.snapshot.status !== "running") {
          return;
        }
        const completed = Math.max(0, Math.trunc(progress.completed));
        const total =
          progress.total === null ? null : Math.max(completed, Math.trunc(progress.total));
        record.snapshot.phase = progress.phase;
        record.snapshot.completed = completed;
        record.snapshot.total = total;
      });
      const committed = outcome instanceof FateExtraCommittedJobOutcome;
      if (record.abort_controller.signal.aborted && !committed) {
        this.finish_cancelled(record);
        return;
      }
      const result = committed ? outcome.result : outcome;
      record.snapshot.status = "succeeded";
      record.snapshot.phase = "completed";
      if (record.snapshot.total === null) {
        record.snapshot.completed = 1;
        record.snapshot.total = 1;
      } else {
        record.snapshot.completed = record.snapshot.total;
      }
      record.snapshot.cancellable = false;
      record.snapshot.result = result;
      record.finished_at = Date.now();
      record.resolve_finished();
    } catch (error) {
      if (record.abort_controller.signal.aborted) {
        this.finish_cancelled(record);
        return;
      }
      record.snapshot.status = "failed";
      record.snapshot.phase = "failed";
      record.snapshot.cancellable = false;
      record.snapshot.error = to_api_error_payload(
        normalize_api_error(error),
        record.snapshot.job_id,
        JOB_ERROR_TEXT,
      );
      record.finished_at = Date.now();
      record.resolve_finished();
    } finally {
      if (this.active_job_by_identity.get(record.identity_key) === record.snapshot.job_id) {
        this.active_job_by_identity.delete(record.identity_key);
      }
    }
  }

  private finish_cancelled(record: FateExtraJobRecord): void {
    record.snapshot.status = "cancelled";
    record.snapshot.phase = "cancelled";
    record.snapshot.cancellable = false;
    record.finished_at = Date.now();
    record.resolve_finished();
  }

  private cleanup_finished_jobs(): void {
    const threshold = Date.now() - FINISHED_JOB_RETENTION_MS;
    for (const [job_id, record] of this.jobs) {
      if (record.finished_at !== null && record.finished_at < threshold) {
        this.jobs.delete(job_id);
      }
    }
  }

  private is_active(status: FateExtraJobStatus): boolean {
    return status === "queued" || status === "running" || status === "cancelling";
  }

  private clone_snapshot(snapshot: FateExtraJobSnapshot): FateExtraJobSnapshot {
    return {
      ...snapshot,
      ...(snapshot.error === undefined ? {} : { error: { ...snapshot.error } }),
    };
  }
}
