import { describe, expect, it, vi } from "vitest";

import { FateExtraIndexCoordinator } from "./fate-extra-index-coordinator";
import { FateExtraJobCoordinator } from "./fate-extra-job-coordinator";

describe("FateExtraIndexCoordinator", () => {
  it("同一工程、epoch 与 revision 复用任务", async () => {
    const jobs = new FateExtraJobCoordinator();
    const coordinator = new FateExtraIndexCoordinator(jobs);
    let resolve_first: (() => void) | undefined;
    const first = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: async () => {
        await new Promise<void>((resolve) => {
          resolve_first = resolve;
        });
        return { built_generation: 1 };
      },
    });
    const duplicate = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: async () => ({ built_generation: 99 }),
    });

    expect(duplicate.job_id).toBe(first.job_id);
    await Promise.resolve();
    resolve_first?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jobs.status(first.job_id)?.status).toBe("succeeded");
    jobs.dispose();
  });

  it("成功后数据库身份仍一致时复用完成快照且不重复重建", async () => {
    const jobs = new FateExtraJobCoordinator();
    const coordinator = new FateExtraIndexCoordinator(jobs);
    const first_run = vi.fn(async () => ({ built_generation: 1 }));
    const duplicate_run = vi.fn(async () => ({ built_generation: 2 }));
    const first = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: first_run,
    });
    await vi.waitFor(() => expect(jobs.status(first.job_id)?.status).toBe("succeeded"));

    const duplicate = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: duplicate_run,
    });

    expect(duplicate).toEqual(jobs.status(first.job_id));
    expect(duplicate.job_id).toBe(first.job_id);
    expect(first_run).toHaveBeenCalledOnce();
    expect(duplicate_run).not.toHaveBeenCalled();
    jobs.dispose();
  });

  it("成功快照在数据库身份失效后不复用，失败与取消也允许重试", async () => {
    const jobs = new FateExtraJobCoordinator();
    const coordinator = new FateExtraIndexCoordinator(jobs);
    const base_options = {
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
    } as const;
    const first = coordinator.start({
      ...base_options,
      reuseSucceeded: true,
      run: async () => ({ built_generation: 1 }),
    });
    await vi.waitFor(() => expect(jobs.status(first.job_id)?.status).toBe("succeeded"));

    const rebuilt = coordinator.start({
      ...base_options,
      reuseSucceeded: false,
      run: async () => ({ built_generation: 2 }),
    });
    expect(rebuilt.job_id).not.toBe(first.job_id);
    await vi.waitFor(() => expect(jobs.status(rebuilt.job_id)?.status).toBe("succeeded"));

    const failed = coordinator.start({
      ...base_options,
      databaseIdentity: "adapter-v2",
      reuseSucceeded: false,
      run: async () => {
        throw new Error("index failed");
      },
    });
    await vi.waitFor(() => expect(jobs.status(failed.job_id)?.status).toBe("failed"));
    const retried = coordinator.start({
      ...base_options,
      databaseIdentity: "adapter-v2",
      reuseSucceeded: false,
      run: async () => ({ built_generation: 3 }),
    });
    expect(retried.job_id).not.toBe(failed.job_id);
    await vi.waitFor(() => expect(jobs.status(retried.job_id)?.status).toBe("succeeded"));

    const cancelled = coordinator.start({
      ...base_options,
      databaseIdentity: "adapter-v3",
      reuseSucceeded: false,
      run: (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    });
    await vi.waitFor(() => expect(jobs.status(cancelled.job_id)?.status).toBe("running"));
    jobs.cancel(cancelled.job_id);
    await vi.waitFor(() => expect(jobs.status(cancelled.job_id)?.status).toBe("cancelled"));
    const retried_after_cancel = coordinator.start({
      ...base_options,
      databaseIdentity: "adapter-v3",
      reuseSucceeded: false,
      run: async () => ({ built_generation: 4 }),
    });
    expect(retried_after_cancel.job_id).not.toBe(cancelled.job_id);
    await vi.waitFor(() =>
      expect(jobs.status(retried_after_cancel.job_id)?.status).toBe("succeeded"),
    );
    jobs.dispose();
  });

  it("同路径重开时不复用旧 epoch 正在取消的任务", async () => {
    const jobs = new FateExtraJobCoordinator();
    const coordinator = new FateExtraIndexCoordinator(jobs);
    let resolve_first: (() => void) | undefined;
    const first = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: async () => {
        await new Promise<void>((resolve) => {
          resolve_first = resolve;
        });
        return { built_generation: 1 };
      },
    });
    await Promise.resolve();

    const reopened = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 4,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: async () => ({ built_generation: 2 }),
    });

    expect(reopened.job_id).not.toBe(first.job_id);
    expect(jobs.status(first.job_id)?.status).toBe("cancelling");
    resolve_first?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jobs.status(first.job_id)?.status).toBe("cancelled");
    expect(jobs.status(reopened.job_id)?.status).toBe("succeeded");
    jobs.dispose();
  });

  it("旧任务完成终止清理前不会启动新 generation 构建", async () => {
    const jobs = new FateExtraJobCoordinator();
    const coordinator = new FateExtraIndexCoordinator(jobs);
    const events: string[] = [];
    let finish_cleanup!: () => void;
    const cleanup_finished = new Promise<void>((resolve) => {
      finish_cleanup = resolve;
    });
    const first = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: false,
      run: async (signal) => {
        events.push("old-build");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        events.push("old-cleanup");
        await cleanup_finished;
        events.push("old-settled");
        throw new Error("cancelled");
      },
    });
    await vi.waitFor(() => expect(events).toEqual(["old-build"]));

    const replacement = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 8,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: false,
      run: async () => {
        events.push("new-build");
        return { built_generation: 2 };
      },
    });

    await vi.waitFor(() => expect(events).toEqual(["old-build", "old-cleanup"]));
    expect(jobs.status(first.job_id)?.status).toBe("cancelling");
    expect(jobs.status(replacement.job_id)?.status).toBe("running");
    finish_cleanup();
    await vi.waitFor(() => expect(jobs.status(replacement.job_id)?.status).toBe("succeeded"));
    expect(events).toEqual(["old-build", "old-cleanup", "old-settled", "new-build"]);
    jobs.dispose();
  });

  it("快速 revision 变化取消中间任务且只执行最新身份", async () => {
    const jobs = new FateExtraJobCoordinator();
    const coordinator = new FateExtraIndexCoordinator(jobs);
    const started_revisions: number[] = [];
    let resolve_first: (() => void) | undefined;
    const first = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 7,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: async () => {
        started_revisions.push(7);
        await new Promise<void>((resolve) => {
          resolve_first = resolve;
        });
        return { built_generation: 1 };
      },
    });
    await Promise.resolve();
    const intermediate = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 8,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: async () => {
        started_revisions.push(8);
        return { built_generation: 2 };
      },
    });
    const latest = coordinator.start({
      projectIdentity: "project-a",
      projectEpoch: 3,
      itemsRevision: 9,
      databaseIdentity: "adapter-v1",
      reuseSucceeded: true,
      run: async () => {
        started_revisions.push(9);
        return { built_generation: 3 };
      },
    });

    expect(jobs.status(first.job_id)?.status).toBe("cancelling");
    expect(jobs.status(intermediate.job_id)?.status).toBe("cancelling");
    resolve_first?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started_revisions).toEqual([7, 9]);
    expect(jobs.status(first.job_id)?.status).toBe("cancelled");
    expect(jobs.status(intermediate.job_id)?.status).toBe("cancelled");
    expect(jobs.status(latest.job_id)?.status).toBe("succeeded");
    jobs.dispose();
  });
});
