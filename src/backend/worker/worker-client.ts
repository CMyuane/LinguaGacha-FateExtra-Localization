import crypto from "node:crypto";
import { Worker } from "node:worker_threads";

import {
  normalize_log_error,
  RuntimeCancelledError,
  RuntimeDisposedError,
  WorkerExecutionFailedError,
} from "../../shared/error";
import type { BackendWorkerExecution } from "./worker-execution";
import {
  run_worker_task,
  type BackendWorkerTask,
  type BackendWorkerTaskProgressReporter,
  type BackendWorkerTaskResult,
} from "./worker-task";
import type { BackendWorkerIncomingMessage, BackendWorkerOutgoingMessage } from "./worker-entry";

type BackendWorkerClientOptions = {
  execution: BackendWorkerExecution;
  terminateOnAbort?: boolean;
  latestWins?: boolean;
  createWorker?: (entry_url: URL) => BackendWorkerHandle;
};

type BackendWorkerHandle = {
  postMessage: (message: BackendWorkerIncomingMessage) => void;
  terminate: () => Promise<number>;
  on: {
    (event: "message", listener: (message: BackendWorkerOutgoingMessage) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
    (event: "exit", listener: (code: number) => void): unknown;
  };
};

type PendingTask = {
  id: string;
  task: BackendWorkerTask;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  report_progress: BackendWorkerTaskProgressReporter;
  abort_listener: () => void;
};

export class BackendWorkerClient {
  private readonly execution: BackendWorkerExecution;
  private readonly terminate_on_abort: boolean;
  private readonly latest_wins: boolean;
  private readonly worker_factory: (entry_url: URL) => BackendWorkerHandle;
  private readonly queue: PendingTask[] = [];
  private worker: BackendWorkerHandle | null = null;
  private terminating_worker: Promise<void> | null = null;
  private active_task: PendingTask | null = null;
  private disposed = false;

  public constructor(options: BackendWorkerClientOptions) {
    this.execution = options.execution;
    this.terminate_on_abort = options.terminateOnAbort === true;
    this.latest_wins = options.latestWins === true;
    this.worker_factory = options.createWorker ?? ((entry_url) => new Worker(entry_url));
    if (this.execution.kind === "worker_threads") {
      this.worker = this.create_worker();
    }
  }

  public run<TTask extends BackendWorkerTask>(
    task: TTask,
    signal: AbortSignal,
    report_progress: BackendWorkerTaskProgressReporter = () => undefined,
  ): Promise<BackendWorkerTaskResult<TTask>> {
    if (this.disposed) {
      return Promise.reject(this.create_disposed_error());
    }
    if (signal.aborted) {
      return Promise.reject(this.create_cancelled_error());
    }
    return new Promise((resolve, reject) => {
      const pending: PendingTask = {
        id: crypto.randomUUID(),
        task,
        signal,
        resolve: (value) => resolve(value as BackendWorkerTaskResult<TTask>),
        reject,
        report_progress,
        abort_listener: () => this.cancel_task(pending),
      };
      signal.addEventListener("abort", pending.abort_listener, { once: true });
      if (this.latest_wins) {
        for (const queued of this.queue.splice(0, this.queue.length)) {
          this.reject_task(queued, this.create_cancelled_error());
        }
      }
      this.queue.push(pending);
      this.drain_queue();
    });
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    for (const task of this.queue.splice(0, this.queue.length)) {
      this.reject_task(task, this.create_disposed_error());
    }
    if (this.active_task !== null) {
      this.reject_task(this.active_task, this.create_disposed_error());
      this.active_task = null;
    }
    const worker = this.worker;
    this.worker = null;
    await Promise.all([worker?.terminate(), this.terminating_worker]);
  }

  private drain_queue(): void {
    if (
      this.active_task !== null ||
      (this.execution.kind === "worker_threads" && this.worker === null)
    ) {
      return;
    }
    const task = this.queue.shift();
    if (task === undefined) {
      return;
    }
    this.active_task = task;
    if (this.execution.kind === "in_process") {
      void this.execute_in_process(task);
      return;
    }
    this.worker?.postMessage({
      id: task.id,
      type: "run",
      task: task.task,
    } satisfies BackendWorkerIncomingMessage);
  }

  private async execute_in_process(task: PendingTask): Promise<void> {
    try {
      if (task.signal.aborted) {
        throw this.create_cancelled_error();
      }
      const data = await run_worker_task(task.task, task.report_progress);
      this.finish_task(task.id, data, null);
    } catch (error) {
      this.finish_task(task.id, null, error);
    }
  }

  private cancel_task(task: PendingTask): void {
    const queued_index = this.queue.findIndex((item) => item.id === task.id);
    if (queued_index >= 0) {
      this.queue.splice(queued_index, 1);
      this.reject_task(task, this.create_cancelled_error());
      return;
    }
    if (this.active_task?.id !== task.id) {
      return;
    }
    if (this.execution.kind === "worker_threads") {
      if (this.terminate_on_abort) {
        const worker = this.worker;
        this.worker = null;
        this.active_task = null;
        // Windows 上 SQLite worker 退出前文件句柄仍可能占用 staging；只有 terminate
        // 真正完成后才拒绝 run()，调用方 finally 此时才可可靠删除 staging。
        const termination = this.finish_terminated_cancellation(worker, task);
        this.terminating_worker = termination;
        void termination.then(() => {
          if (this.terminating_worker === termination) {
            this.terminating_worker = null;
          }
        });
        return;
      }
      this.worker?.postMessage({
        id: task.id,
        type: "cancel",
      } satisfies BackendWorkerIncomingMessage);
    }
    this.active_task = null;
    this.reject_task(task, this.create_cancelled_error());
    this.drain_queue();
  }

  private async finish_terminated_cancellation(
    worker: BackendWorkerHandle | null,
    task: PendingTask,
  ): Promise<void> {
    let result_error: unknown = this.create_cancelled_error();
    try {
      await worker?.terminate();
    } catch (error) {
      result_error = new WorkerExecutionFailedError({
        diagnostic_context: {
          failure: normalize_log_error(error, "Backend worker 终止失败。"),
        },
      });
    }
    this.reject_task(task, result_error);
    if (this.disposed || this.execution.kind !== "worker_threads") {
      return;
    }
    this.worker = this.create_worker();
    this.drain_queue();
  }

  private create_worker(): BackendWorkerHandle {
    if (this.execution.kind !== "worker_threads") {
      throw new Error("BackendWorkerClient 创建 worker 时必须使用 worker_threads。");
    }
    const worker = this.worker_factory(this.execution.backendWorkerEntryUrl);
    worker.on("message", (message: BackendWorkerOutgoingMessage) => {
      this.finish_worker_message(message);
    });
    worker.on("error", (error) => this.fail_worker(worker, error));
    worker.on("exit", (code) => {
      if (!this.disposed && code !== 0) {
        this.fail_worker(worker, new Error(`Backend worker exited: ${code.toString()}`));
      }
    });
    return worker;
  }

  private finish_worker_message(message: BackendWorkerOutgoingMessage): void {
    const task = this.active_task;
    if (task === null || task.id !== message.id) {
      return;
    }
    if (message.type === "progress") {
      task.report_progress(message.progress);
      return;
    }
    if (message.ok) {
      this.finish_task(task.id, message.data, null);
    } else {
      this.finish_task(
        task.id,
        null,
        new WorkerExecutionFailedError({
          diagnostic_context: {
            failure: normalize_log_error(message.error, "Backend worker 执行失败。"),
          },
        }),
      );
    }
  }

  private finish_task(id: string, data: unknown, error: unknown): void {
    const task = this.active_task;
    if (task === null || task.id !== id) {
      return;
    }
    this.active_task = null;
    task.signal.removeEventListener("abort", task.abort_listener);
    if (error === null) {
      task.resolve(data);
    } else {
      task.reject(error);
    }
    this.drain_queue();
  }

  private fail_worker(worker: BackendWorkerHandle, error: unknown): void {
    if (this.worker !== worker) {
      return;
    }
    const task = this.active_task;
    this.active_task = null;
    if (task !== null) {
      this.reject_task(task, error);
    }
    if (!this.disposed && this.execution.kind === "worker_threads") {
      this.worker = this.create_worker();
      this.drain_queue();
    }
  }

  private reject_task(task: PendingTask, error: unknown): void {
    task.signal.removeEventListener("abort", task.abort_listener);
    task.reject(error);
  }

  private create_disposed_error(): RuntimeDisposedError {
    return new RuntimeDisposedError({
      public_details: { resource: "BackendWorkerClient" },
      diagnostic_context: { queue_length: this.queue.length },
    });
  }

  private create_cancelled_error(): RuntimeCancelledError {
    return new RuntimeCancelledError({
      public_details: { resource: "backend_worker" },
    });
  }
}
