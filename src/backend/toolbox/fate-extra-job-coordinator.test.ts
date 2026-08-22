import { describe, expect, it, vi } from "vitest";

import {
  FateExtraCommittedJobOutcome,
  FateExtraJobCoordinator,
} from "./fate-extra-job-coordinator";

describe("FateExtraJobCoordinator", () => {
  it("相同身份的活动任务只启动一次", async () => {
    const coordinator = new FateExtraJobCoordinator();
    let resolve_job!: (value: { ok: boolean }) => void;
    const run = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolve_job = resolve;
        }),
    );
    const first = coordinator.start({
      kind: "preview-index",
      identityKey: "demo:1",
      projectEpoch: 1,
      sourceRevision: 2,
      phase: "indexing",
      run,
    });
    const second = coordinator.start({
      kind: "preview-index",
      identityKey: "demo:1",
      projectEpoch: 1,
      sourceRevision: 2,
      phase: "indexing",
      run,
    });

    expect(second.job_id).toBe(first.job_id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    resolve_job({ ok: true });
    await vi.waitFor(() => expect(coordinator.status(first.job_id)?.status).toBe("succeeded"));
  });

  it("取消活动任务会触发 signal 并稳定进入 cancelled", async () => {
    const coordinator = new FateExtraJobCoordinator();
    const run = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const job = coordinator.start({
      kind: "scan",
      identityKey: "scan:demo",
      projectEpoch: 3,
      sourceRevision: 4,
      phase: "scanning",
      run,
    });
    await vi.waitFor(() => expect(coordinator.status(job.job_id)?.status).toBe("running"));

    expect(coordinator.cancel(job.job_id)?.status).toBe("cancelling");
    await vi.waitFor(() => expect(coordinator.status(job.job_id)?.status).toBe("cancelled"));
    await expect(coordinator.wait_until_finished(job.job_id)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("durable receipt 已确认的提交结果胜过同时到达的取消信号", async () => {
    const coordinator = new FateExtraJobCoordinator();
    let finish_commit!: () => void;
    const commit_finished = new Promise<void>((resolve) => {
      finish_commit = resolve;
    });
    const job = coordinator.start({
      kind: "scan-apply",
      identityKey: "scan-apply:committed",
      projectEpoch: 3,
      sourceRevision: 4,
      phase: "apply-staging",
      run: async () => {
        await commit_finished;
        return new FateExtraCommittedJobOutcome({
          accepted: true,
          apply_receipt_recovered: true,
        });
      },
    });
    await vi.waitFor(() => expect(coordinator.status(job.job_id)?.status).toBe("running"));

    expect(coordinator.cancel(job.job_id)?.status).toBe("cancelling");
    finish_commit();

    await vi.waitFor(() => expect(coordinator.status(job.job_id)?.status).toBe("succeeded"));
    expect(coordinator.status(job.job_id)?.result).toMatchObject({
      accepted: true,
      apply_receipt_recovered: true,
    });
  });

  it("按类型取消不会误伤其他 FE 通道", async () => {
    const coordinator = new FateExtraJobCoordinator();
    const run = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const scan = coordinator.start({
      kind: "scan",
      identityKey: "scan:old",
      projectEpoch: 1,
      sourceRevision: 1,
      phase: "scanning",
      run,
    });
    const index = coordinator.start({
      kind: "preview-index",
      identityKey: "index:current",
      projectEpoch: 1,
      sourceRevision: 1,
      phase: "indexing",
      run,
    });
    await vi.waitFor(() => expect(coordinator.status(scan.job_id)?.status).toBe("running"));

    coordinator.cancel_kind("scan");

    await vi.waitFor(() => expect(coordinator.status(scan.job_id)?.status).toBe("cancelled"));
    expect(coordinator.status(index.job_id)?.status).toBe("running");
    coordinator.dispose();
  });

  it("运行中的阶段和计数会进入轮询快照", async () => {
    const coordinator = new FateExtraJobCoordinator();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job = coordinator.start({
      kind: "preview-index",
      identityKey: "index:progress",
      projectEpoch: 4,
      sourceRevision: 5,
      phase: "queued",
      run: async (_signal, report_progress) => {
        report_progress({ phase: "index-documents", completed: 400, total: 1000 });
        await waiting;
        return { ready: true };
      },
    });

    await vi.waitFor(() =>
      expect(coordinator.status(job.job_id)).toMatchObject({
        status: "running",
        phase: "index-documents",
        completed: 400,
        total: 1000,
      }),
    );
    finish();
    await vi.waitFor(() => expect(coordinator.status(job.job_id)?.status).toBe("succeeded"));
  });

  it("失败快照使用标准 API 错误载荷", async () => {
    const coordinator = new FateExtraJobCoordinator();
    const job = coordinator.start({
      kind: "scan",
      identityKey: "scan:failure",
      projectEpoch: 1,
      sourceRevision: 2,
      phase: "scanning",
      run: async () => {
        throw new Error("底层敏感失败详情");
      },
    });

    await vi.waitFor(() => expect(coordinator.status(job.job_id)?.status).toBe("failed"));
    expect(coordinator.status(job.job_id)?.error).toMatchObject({
      code: "runtime.internal_invariant",
      message_key: "app.error.runtime.internal_invariant.message",
      request_id: job.job_id,
    });
    expect(coordinator.status(job.job_id)?.error?.message).not.toContain("底层敏感失败详情");
  });
});
