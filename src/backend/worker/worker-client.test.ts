import { describe, expect, it, vi } from "vitest";

import { prepare_quality_statistics_task_input } from "../../shared/quality/quality-statistics-input";
import { BackendWorkerClient } from "./worker-client";
import type { BackendWorkerTask } from "./worker-task";

/**
 * 构造可真实执行的质量统计任务，队列测试只隔离 worker client 调度行为。
 */
function create_quality_task(pattern: string): BackendWorkerTask {
  return {
    type: "quality_statistics",
    input: prepare_quality_statistics_task_input({
      rule_key: "glossary",
      entries: [{ entry_id: pattern, src: pattern }],
      items: [{ src: `${pattern} appeared`, dst: "" }],
    }),
  };
}

describe("BackendWorkerClient", () => {
  it("在 in_process 模式下按提交顺序执行后台 task", async () => {
    const client = new BackendWorkerClient({ execution: { kind: "in_process" } });

    const first = client.run(create_quality_task("HP"), new AbortController().signal);
    const second = client.run(create_quality_task("MP"), new AbortController().signal);

    await expect(first).resolves.toMatchObject({
      completed_entry_ids: ["HP"],
      matched_count_by_entry_id: { HP: 1 },
    });
    await expect(second).resolves.toMatchObject({
      completed_entry_ids: ["MP"],
      matched_count_by_entry_id: { MP: 1 },
    });

    await client.dispose();
  });

  it("取消排队 task 时拒绝该任务且继续完成已有任务", async () => {
    const client = new BackendWorkerClient({ execution: { kind: "in_process" } });
    const first = client.run(create_quality_task("HP"), new AbortController().signal);
    const controller = new AbortController();
    const queued = client.run(create_quality_task("MP"), controller.signal);

    controller.abort();

    await expect(first).resolves.toMatchObject({
      matched_count_by_entry_id: { HP: 1 },
    });
    await expect(queued).rejects.toMatchObject({ code: "runtime.cancelled" });

    await client.dispose();
  });

  it("取消 active task 时拒绝该任务并继续执行后续任务", async () => {
    const client = new BackendWorkerClient({ execution: { kind: "in_process" } });
    const controller = new AbortController();
    const active = client.run(create_quality_task("HP"), controller.signal);
    const next = client.run(create_quality_task("MP"), new AbortController().signal);

    controller.abort();

    await expect(active).rejects.toMatchObject({ code: "runtime.cancelled" });
    await expect(next).resolves.toMatchObject({
      matched_count_by_entry_id: { MP: 1 },
    });

    await client.dispose();
  });

  it("latest-wins 通道最多保留一个 pending task", async () => {
    const client = new BackendWorkerClient({
      execution: { kind: "in_process" },
      latestWins: true,
    });
    const active = client.run(create_quality_task("HP"), new AbortController().signal);
    const replaced = client.run(create_quality_task("MP"), new AbortController().signal);
    const latest = client.run(create_quality_task("TP"), new AbortController().signal);

    await expect(replaced).rejects.toMatchObject({ code: "runtime.cancelled" });
    await expect(active).resolves.toMatchObject({ matched_count_by_entry_id: { HP: 1 } });
    await expect(latest).resolves.toMatchObject({ matched_count_by_entry_id: { TP: 1 } });

    await client.dispose();
  });

  it("terminateOnAbort 等 worker 完全退出后才拒绝 active task", async () => {
    let finish_termination: ((exit_code: number) => void) | undefined;
    const termination = new Promise<number>((resolve) => {
      finish_termination = resolve;
    });
    const first_worker = {
      postMessage: vi.fn(),
      terminate: vi.fn(() => termination),
      on: vi.fn(),
    };
    const workers = [first_worker];
    const client = new BackendWorkerClient({
      execution: {
        kind: "worker_threads",
        workUnitWorkerEntryUrl: new URL("file:///work-unit-worker.js"),
        planningWorkerEntryUrl: new URL("file:///planning-worker.js"),
        backendWorkerEntryUrl: new URL("file:///backend-worker.js"),
      },
      terminateOnAbort: true,
      createWorker: () => workers.shift() as never,
    });
    const controller = new AbortController();
    const outcome = client.run(create_quality_task("HP"), controller.signal).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    controller.abort();
    await vi.waitFor(() => expect(first_worker.terminate).toHaveBeenCalledOnce());
    const disposing = client.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(disposed).toBe(false);

    finish_termination?.(0);
    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "runtime.cancelled" },
    });
    await disposing;
    expect(workers).toHaveLength(0);
  });

  it("把 worker 批次进度转交给当前任务且不结束 promise", async () => {
    let receive_message:
      | ((message: {
          id: string;
          type: "progress";
          progress: { phase: string; completed: number; total: number | null };
        }) => void)
      | undefined;
    const worker = {
      postMessage: vi.fn((message: { id: string }) => {
        queueMicrotask(() => {
          receive_message?.({
            id: message.id,
            type: "progress",
            progress: { phase: "batch", completed: 25, total: 100 },
          });
          receive_message?.({ id: message.id, ok: true, data: {} } as never);
        });
      }),
      terminate: vi.fn(async () => 0),
      on: vi.fn((event: string, listener: (message: never) => void) => {
        if (event === "message") receive_message = listener as typeof receive_message;
      }),
    };
    const report_progress = vi.fn();
    const client = new BackendWorkerClient({
      execution: {
        kind: "worker_threads",
        workUnitWorkerEntryUrl: new URL("file:///work-unit-worker.js"),
        planningWorkerEntryUrl: new URL("file:///planning-worker.js"),
        backendWorkerEntryUrl: new URL("file:///backend-worker.js"),
      },
      createWorker: () => worker,
    });

    await client.run(create_quality_task("HP"), new AbortController().signal, report_progress);

    expect(report_progress).toHaveBeenCalledWith({
      phase: "batch",
      completed: 25,
      total: 100,
    });
    await client.dispose();
  });

  it("dispose 后拒绝排队和后续提交的 task", async () => {
    const client = new BackendWorkerClient({ execution: { kind: "in_process" } });
    const running = client.run(create_quality_task("HP"), new AbortController().signal);
    const queued = client.run(create_quality_task("MP"), new AbortController().signal);

    await client.dispose();

    await expect(running).rejects.toMatchObject({ code: "runtime.disposed" });
    await expect(queued).rejects.toMatchObject({ code: "runtime.disposed" });
    await expect(
      client.run(create_quality_task("TP"), new AbortController().signal),
    ).rejects.toMatchObject({ code: "runtime.disposed" });
  });
});
