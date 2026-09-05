import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppPathService } from "../app/app-path-service";
import type { ProjectDatabase } from "../database/database-operations";
import { build_fate_extra_scan_apply_artifact_paths } from "../database/fate-extra-scan-apply-receipt";
import type { ProjectOperationGate } from "../project/project-gate";
import {
  create_project_opened_for_cache_event,
  create_project_unloaded_event,
  ProjectEventBus,
} from "../project/project-events";
import type { ProjectSessionState } from "../project/project-session";
import type { ProjectWriteStore } from "../project/project-write-store";
import type { BackendWorkerClient } from "../worker/worker-client";
import type { NativeFs } from "../../native/native-fs";
import type { FateExtraFontService } from "./fate-extra-font-service";
import { FateExtraService } from "./fate-extra-service";

const PROJECT_PATH = String.raw`D:\work\project.lg`;
const SOURCE_DIRECTORY = String.raw`D:\work\indexed`;
const COMPLETE_SOURCE = String.raw`D:\work\complete.txt`;
const CLASSIFICATION_DATABASE = String.raw`D:\work\classification.sqlite`;

type WorkerRun = ReturnType<typeof vi.fn>;

describe("FateExtraService 后台任务", () => {
  it("compact 工程拒绝启动扫描且不触碰 worker 或 staging", () => {
    const fixture = create_job_service({ compactEnabled: true });

    let thrown: unknown;
    try {
      fixture.service.scan(scan_body());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "request.validation_failed",
      public_details: {
        reason: "精简 FE 工程不支持扫描或应用 FE 适配，请切换到完整工程。",
      },
    });
    expect(fixture.scan_apply_run).not.toHaveBeenCalled();
    expect(fixture.apply_staging).not.toHaveBeenCalled();
    expect(fixture.removed_paths).toEqual([]);
  });

  it("compact 工程拒绝应用并保留已有 draft 供完整工程继续使用", async () => {
    const options: { compactEnabled?: boolean } = { compactEnabled: false };
    const fixture = create_job_service(options);
    fixture.scan_apply_run
      .mockImplementationOnce(
        async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
          fixture.existing_files.add(task.input.stagingPath);
          return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-compact-guard");
        },
      )
      .mockImplementationOnce(async () => ({ accepted: true }));
    const scan_job = fixture.service.scan(scan_body());
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(scan_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    const staging_path = String(
      (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );

    options.compactEnabled = true;
    await expect(
      fixture.service.apply({ project_path: PROJECT_PATH, scan_id: "scan-compact-guard" }),
    ).rejects.toMatchObject({
      code: "request.validation_failed",
      public_details: {
        reason: "精简 FE 工程不支持扫描或应用 FE 适配，请切换到完整工程。",
      },
    });
    expect(fixture.scan_apply_run).toHaveBeenCalledOnce();
    expect(fixture.apply_staging).not.toHaveBeenCalled();
    expect(fixture.removed_paths).not.toContain(staging_path);

    options.compactEnabled = false;
    const apply_job = await fixture.service.apply({
      project_path: PROJECT_PATH,
      scan_id: "scan-compact-guard",
    });
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(apply_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    expect(fixture.apply_staging).toHaveBeenCalledOnce();
    expect(fixture.scan_apply_run).toHaveBeenCalledTimes(2);
  });

  it("扫描快速返回 job，并只在 worker 完成后安装小型 staging handle", async () => {
    const fixture = create_job_service();
    let resolve_scan!: (result: Record<string, unknown>) => void;
    const scan_promise = new Promise<Record<string, unknown>>((resolve) => {
      resolve_scan = resolve;
    });
    fixture.scan_apply_run.mockImplementationOnce((task: { input: { stagingPath: string } }) => {
      fixture.existing_files.add(task.input.stagingPath);
      return scan_promise;
    });

    const started = fixture.service.scan(scan_body());

    expect(started).toMatchObject({ kind: "scan", status: "queued" });
    await vi.waitFor(() => expect(fixture.scan_apply_run).toHaveBeenCalledOnce());
    const task = fixture.scan_apply_run.mock.calls[0]![0] as {
      input: { stagingPath: string; projectEpoch: number };
    };
    resolve_scan(scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-1"));
    await vi.waitFor(() => {
      expect(fixture.service.jobs_status({ job_id: String(started["job_id"]) })).toMatchObject({
        status: "succeeded",
        result: { scan_id: "scan-1", applicable: true },
      });
    });

    expect(fixture.removed_paths).not.toContain(task.input.stagingPath);
  });

  it("新扫描清理旧 draft，取消活动扫描会终止并清理 candidate", async () => {
    const fixture = create_job_service();
    fixture.scan_apply_run.mockImplementationOnce(
      async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
        fixture.existing_files.add(task.input.stagingPath);
        return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-old");
      },
    );
    const old_job = fixture.service.scan(scan_body());
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(old_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    const old_staging = String(
      (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );

    fixture.scan_apply_run.mockImplementationOnce(
      (task: { input: { stagingPath: string } }, signal: AbortSignal) => {
        fixture.existing_files.add(task.input.stagingPath);
        fixture.existing_files.add(`${task.input.stagingPath}.classification.sqlite`);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    );
    const next_job = fixture.service.scan(scan_body());
    await vi.waitFor(() => expect(fixture.scan_apply_run).toHaveBeenCalledTimes(2));
    const next_staging = String(
      (fixture.scan_apply_run.mock.calls[1]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );
    expect(fixture.removed_paths).toContain(old_staging);

    fixture.service.jobs_cancel({ job_id: String(next_job["job_id"]) });
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(next_job["job_id"]) })["status"]).toBe(
        "cancelled",
      ),
    );
    expect(fixture.removed_paths).toContain(next_staging);
    expect(fixture.removed_paths).toContain(`${next_staging}.classification.sqlite`);
  });

  it("apply 经唯一写入口提交 staging，成功后删除 draft", async () => {
    const fixture = create_job_service();
    let apply_artifacts: ReturnType<typeof build_fate_extra_scan_apply_artifact_paths>;
    fixture.scan_apply_run
      .mockImplementationOnce(
        async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
          fixture.existing_files.add(task.input.stagingPath);
          return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-apply");
        },
      )
      .mockImplementationOnce(async (task: { input: { applyToken: string } }) => {
        apply_artifacts = build_fate_extra_scan_apply_artifact_paths(
          PROJECT_PATH,
          task.input.applyToken,
        );
        fixture.existing_files.add(apply_artifacts.backup_path);
        fixture.existing_files.add(apply_artifacts.migration_report_json_temporary);
        fixture.existing_files.add(apply_artifacts.migration_report_csv_temporary);
        return {
          accepted: true,
          backup_path: apply_artifacts.backup_path,
          migration_report_json: apply_artifacts.migration_report_json,
          migration_report_csv: apply_artifacts.migration_report_csv,
          logical_text_count: 12,
          section_revisions: { files: 2, items: 2, analysis: 2, proofreading: 2 },
        };
      });
    const scan_job = fixture.service.scan(scan_body());
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(scan_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    const staging_path = String(
      (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );

    const apply_job = await fixture.service.apply({
      project_path: PROJECT_PATH,
      scan_id: "scan-apply",
      expected_section_revisions: revision_record(1),
    });
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(apply_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );

    expect(fixture.apply_staging).toHaveBeenCalledOnce();
    expect(fixture.removed_paths).toContain(staging_path);
    expect(fixture.existing_files.has(apply_artifacts!.backup_path)).toBe(true);
    expect(fixture.removed_paths).toContain(apply_artifacts!.migration_report_json_temporary);
    expect(fixture.removed_paths).toContain(apply_artifacts!.migration_report_csv_temporary);
  });

  it("活动 apply 暂停 draft TTL，取消后以显式 staging path 重试清理", async () => {
    vi.useFakeTimers();
    try {
      const fixture = create_job_service();
      let apply_artifacts: ReturnType<typeof build_fate_extra_scan_apply_artifact_paths>;
      fixture.scan_apply_run
        .mockImplementationOnce(
          async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
            fixture.existing_files.add(task.input.stagingPath);
            return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-active-ttl");
          },
        )
        .mockImplementationOnce(
          (task: { input: { applyToken: string } }, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              apply_artifacts = build_fate_extra_scan_apply_artifact_paths(
                PROJECT_PATH,
                task.input.applyToken,
              );
              fixture.existing_files.add(apply_artifacts.backup_path);
              fixture.existing_files.add(apply_artifacts.migration_report_json_temporary);
              fixture.existing_files.add(apply_artifacts.migration_report_csv_temporary);
              signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
            }),
        );
      const scan_job = fixture.service.scan(scan_body());
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.service.jobs_status({ job_id: String(scan_job["job_id"]) })["status"]).toBe(
        "succeeded",
      );
      const staging_path = String(
        (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
          .stagingPath,
      );
      const apply_job = await fixture.service.apply({
        project_path: PROJECT_PATH,
        scan_id: "scan-active-ttl",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.scan_apply_run).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(fixture.existing_files.has(staging_path)).toBe(true);
      fixture.service.jobs_cancel({ job_id: String(apply_job["job_id"]) });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.service.jobs_status({ job_id: String(apply_job["job_id"]) })["status"]).toBe(
        "cancelled",
      );
      expect(fixture.removed_paths).toContain(staging_path);
      expect(fixture.existing_files.has(staging_path)).toBe(false);
      expect(fixture.removed_paths).toContain(apply_artifacts!.backup_path);
      expect(fixture.removed_paths).toContain(apply_artifacts!.migration_report_json_temporary);
      expect(fixture.removed_paths).toContain(apply_artifacts!.migration_report_csv_temporary);
    } finally {
      vi.useRealTimers();
    }
  });

  it("apply 输入 ENOENT 作为前置失效销毁 draft", async () => {
    const fixture = create_job_service();
    fixture.scan_apply_run
      .mockImplementationOnce(
        async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
          fixture.existing_files.add(task.input.stagingPath);
          return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-enoent");
        },
      )
      .mockImplementationOnce(async () => {
        throw new Error("FE 扫描输入已失效：deleted-input.txt");
      });
    const scan_job = fixture.service.scan(scan_body());
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(scan_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    const staging_path = String(
      (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );

    const apply_job = await fixture.service.apply({
      project_path: PROJECT_PATH,
      scan_id: "scan-enoent",
    });
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(apply_job["job_id"]) })).toMatchObject({
        status: "failed",
        error: { details: { scan_draft_retryable: false } },
      }),
    );

    expect(fixture.removed_paths).toContain(staging_path);
    await expect(
      fixture.service.apply({ project_path: PROJECT_PATH, scan_id: "scan-enoent" }),
    ).rejects.toMatchObject({ code: "request.validation_failed" });
  });

  it("apply 瞬时失败会在 job 错误中明确保留 draft 重试语义", async () => {
    const fixture = create_job_service();
    fixture.scan_apply_run
      .mockImplementationOnce(
        async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
          fixture.existing_files.add(task.input.stagingPath);
          return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-retryable");
        },
      )
      .mockImplementationOnce(async () => {
        throw new Error("temporary sqlite busy");
      })
      .mockImplementationOnce(async () => ({
        accepted: true,
        backup_path: `${PROJECT_PATH}.retryable.backup`,
        migration_report_json: `${PROJECT_PATH}.retryable.json`,
        migration_report_csv: `${PROJECT_PATH}.retryable.csv`,
        logical_text_count: 12,
        section_revisions: revision_record(2),
      }));
    const scan_job = fixture.service.scan(scan_body());
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(scan_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    const staging_path = String(
      (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );

    const failed_apply = await fixture.service.apply({
      project_path: PROJECT_PATH,
      scan_id: "scan-retryable",
      expected_section_revisions: revision_record(1),
    });
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(failed_apply["job_id"]) })).toMatchObject(
        {
          status: "failed",
          error: { details: { scan_draft_retryable: true } },
        },
      ),
    );
    expect(fixture.existing_files.has(staging_path)).toBe(true);

    const retried_apply = await fixture.service.apply({
      project_path: PROJECT_PATH,
      scan_id: "scan-retryable",
      expected_section_revisions: revision_record(1),
    });
    await vi.waitFor(() =>
      expect(
        fixture.service.jobs_status({ job_id: String(retried_apply["job_id"]) })["status"],
      ).toBe("succeeded"),
    );
    expect(fixture.scan_apply_run).toHaveBeenCalledTimes(3);
    expect(fixture.removed_paths).toContain(staging_path);
  });

  it("apply 取消撞上已提交 receipt 时最终成功并清理 draft", async () => {
    const fixture = create_job_service();
    fixture.apply_staging.mockImplementationOnce(
      async (request: {
        commit: (revisions: Record<string, number>) => Promise<Record<string, unknown>>;
      }) => {
        try {
          return await request.commit({ ...fixture.revisions });
        } catch {
          return {
            accepted: true,
            apply_receipt_recovered: true,
            migration_report_status: "failed",
            section_revisions: revision_record(2),
          };
        }
      },
    );
    fixture.scan_apply_run
      .mockImplementationOnce(
        async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
          fixture.existing_files.add(task.input.stagingPath);
          return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-commit-race");
        },
      )
      .mockImplementationOnce((_task: unknown, signal: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("worker terminated after commit")),
            { once: true },
          );
        });
      });
    const scan_job = fixture.service.scan(scan_body());
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(scan_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    const staging_path = String(
      (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );
    const apply_job = await fixture.service.apply({
      project_path: PROJECT_PATH,
      scan_id: "scan-commit-race",
      expected_section_revisions: revision_record(1),
    });
    await vi.waitFor(() => expect(fixture.scan_apply_run).toHaveBeenCalledTimes(2));

    expect(fixture.service.jobs_cancel({ job_id: String(apply_job["job_id"]) })).toMatchObject({
      status: "cancelling",
    });
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(apply_job["job_id"]) })).toMatchObject({
        status: "succeeded",
        result: { accepted: true, apply_receipt_recovered: true },
      }),
    );
    expect(fixture.removed_paths).toContain(staging_path);
  });

  it("revision 前置条件失效时销毁 ready draft 且不启动 apply worker", async () => {
    const fixture = create_job_service();
    fixture.scan_apply_run.mockImplementationOnce(
      async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
        fixture.existing_files.add(task.input.stagingPath);
        return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-stale");
      },
    );
    const scan_job = fixture.service.scan(scan_body());
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(scan_job["job_id"]) })["status"]).toBe(
        "succeeded",
      ),
    );
    const staging_path = String(
      (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
        .stagingPath,
    );
    fixture.revisions.items = 2;

    await expect(
      fixture.service.apply({ project_path: PROJECT_PATH, scan_id: "scan-stale" }),
    ).rejects.toMatchObject({ code: "request.validation_failed" });

    expect(fixture.scan_apply_run).toHaveBeenCalledOnce();
    expect(fixture.removed_paths).toContain(staging_path);
  });

  it("连续十次扫描始终只保留最后一个 ready draft", async () => {
    const fixture = create_job_service();
    fixture.scan_apply_run.mockImplementation(
      async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
        fixture.existing_files.add(task.input.stagingPath);
        return scan_result(
          task.input.stagingPath,
          task.input.projectEpoch,
          `scan-${fixture.scan_apply_run.mock.calls.length.toString()}`,
        );
      },
    );

    const staging_paths: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const job = fixture.service.scan(scan_body());
      await vi.waitFor(() =>
        expect(fixture.service.jobs_status({ job_id: String(job["job_id"]) })["status"]).toBe(
          "succeeded",
        ),
      );
      staging_paths.push(
        String(
          (
            fixture.scan_apply_run.mock.calls[index]![0] as {
              input: { stagingPath: string };
            }
          ).input.stagingPath,
        ),
      );
    }

    expect(fixture.scan_apply_run).toHaveBeenCalledTimes(10);
    expect(
      staging_paths.slice(0, -1).every((file_path) => fixture.removed_paths.includes(file_path)),
    ).toBe(true);
    expect(fixture.existing_files.has(staging_paths.at(-1)!)).toBe(true);
    expect(staging_paths.filter((file_path) => fixture.existing_files.has(file_path))).toEqual([
      staging_paths.at(-1),
    ]);
  });

  it("ready draft 在三十分钟 TTL 到期后清理 staging", async () => {
    vi.useFakeTimers();
    try {
      const fixture = create_job_service();
      fixture.scan_apply_run.mockImplementationOnce(
        async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
          fixture.existing_files.add(task.input.stagingPath);
          return scan_result(task.input.stagingPath, task.input.projectEpoch, "scan-expiring");
        },
      );

      const job = fixture.service.scan(scan_body());
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.service.jobs_status({ job_id: String(job["job_id"]) })["status"]).toBe(
        "succeeded",
      );
      const staging_path = String(
        (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
          .stagingPath,
      );

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(fixture.removed_paths).toContain(staging_path);
      expect(fixture.existing_files.has(staging_path)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("项目卸载与 backend dispose 都取消任务并清理 ready draft", async () => {
    for (const lifecycle of ["unload", "dispose"] as const) {
      const fixture = create_job_service();
      const event_bus = new ProjectEventBus();
      fixture.service.subscribe(event_bus);
      fixture.scan_apply_run.mockImplementationOnce(
        async (task: { input: { stagingPath: string; projectEpoch: number } }) => {
          fixture.existing_files.add(task.input.stagingPath);
          return scan_result(task.input.stagingPath, task.input.projectEpoch, `scan-${lifecycle}`);
        },
      );
      const job = fixture.service.scan(scan_body());
      await vi.waitFor(() =>
        expect(fixture.service.jobs_status({ job_id: String(job["job_id"]) })["status"]).toBe(
          "succeeded",
        ),
      );
      const staging_path = String(
        (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
          .stagingPath,
      );

      if (lifecycle === "unload") {
        await event_bus.publish(create_project_unloaded_event(PROJECT_PATH));
      } else {
        fixture.service.dispose();
      }

      expect(fixture.removed_paths).toContain(staging_path);
      expect(fixture.existing_files.has(staging_path)).toBe(false);
    }
  });

  it("项目卸载与 backend dispose 都终止活动扫描并清理 candidate staging", async () => {
    for (const lifecycle of ["unload", "dispose"] as const) {
      const fixture = create_job_service();
      const event_bus = new ProjectEventBus();
      fixture.service.subscribe(event_bus);
      fixture.scan_apply_run.mockImplementationOnce(
        (task: { input: { stagingPath: string } }, signal: AbortSignal) => {
          fixture.existing_files.add(task.input.stagingPath);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      );
      fixture.service.scan(scan_body());
      await vi.waitFor(() => expect(fixture.scan_apply_run).toHaveBeenCalledOnce());
      const staging_path = String(
        (fixture.scan_apply_run.mock.calls[0]![0] as { input: { stagingPath: string } }).input
          .stagingPath,
      );

      if (lifecycle === "unload") {
        await event_bus.publish(create_project_unloaded_event(PROJECT_PATH));
      } else {
        fixture.service.dispose();
      }

      await vi.waitFor(() => expect(fixture.removed_paths).toContain(staging_path));
      expect(fixture.existing_files.has(staging_path)).toBe(false);
    }
  });

  it("项目打开时清理崩溃遗留 staging", async () => {
    const fixture = create_job_service();
    const event_bus = new ProjectEventBus();
    const residual_path = String.raw`D:\work\.linguagacha-fe-scan-crashed.sqlite`;
    fixture.existing_files.add(residual_path);
    fixture.service.subscribe(event_bus);

    await event_bus.publish(
      create_project_opened_for_cache_event({
        projectPath: PROJECT_PATH,
        sectionRevisions: revision_record(1),
      }),
    );

    expect(fixture.removed_paths).toContain(residual_path);
    expect(fixture.existing_files.has(residual_path)).toBe(false);
  });

  it("结构性 items 写入把旧索引标为 dirty 后会自动启动 generation 重建", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: false });
    const event_bus = new ProjectEventBus();
    fixture.service.subscribe(event_bus);
    fixture.index_run.mockResolvedValue({
      built_items_revision: 1,
      built_generation: 2,
      built_adapter_value: "adapter-v1",
    });

    await event_bus.publish({
      type: "project.items.changed",
      projectPath: PROJECT_PATH,
      source: "project_write",
      affectedSections: ["items"],
      sectionRevisions: { items: 1 },
      items: { payloadMode: "section-invalidated" },
      scope: "items-full",
    });

    await vi.waitFor(() => expect(fixture.index_run).toHaveBeenCalledTimes(2));
    expect(fixture.index_run.mock.calls[0]?.[0]).toMatchObject({
      type: "fate_extra_preview_index",
      input: { projectPath: PROJECT_PATH, expectedItemsRevision: 1 },
    });
    expect(fixture.index_run.mock.calls[1]?.[0]).toMatchObject({
      type: "fate_extra_preview_index_cleanup",
      input: { projectPath: PROJECT_PATH },
    });
  });

  it("原子发布后清理旧 generation，清理期间取消仍返回已提交结果", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: false });
    let finish_cleanup!: () => void;
    fixture.index_run.mockImplementation((task: { type: string }) => {
      if (task.type === "fate_extra_preview_index_cleanup") {
        return new Promise((resolve) => {
          finish_cleanup = () => resolve({ cleaned_generations: 1 });
        });
      }
      return Promise.resolve({
        built_items_revision: 1,
        built_generation: 2,
        built_adapter_value: "adapter-v1",
      });
    });
    const job = fixture.service.rebuild_duplicate_index({ project_path: PROJECT_PATH });
    await vi.waitFor(() => expect(fixture.index_run).toHaveBeenCalledTimes(2));
    expect(
      fixture.database_execute.mock.calls.some(
        ([operation]) => operation.name === "activateFateExtraPreviewSearchGeneration",
      ),
    ).toBe(true);
    fixture.service.jobs_cancel({ job_id: String(job["job_id"]) });
    const cleanup_signal = fixture.index_run.mock.calls[1]![1] as AbortSignal;
    expect(cleanup_signal.aborted).toBe(false);
    finish_cleanup();
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(job["job_id"]) })).toMatchObject({
        status: "succeeded",
        result: { built_generation: 2 },
      }),
    );
  });

  it("同路径 close/reopen 改变 epoch 后不激活迟到的 inactive generation", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: false });
    const event_bus = new ProjectEventBus();
    fixture.service.subscribe(event_bus);
    let finish_build!: () => void;
    fixture.index_run.mockImplementation(
      (task: { type: string }): Promise<Record<string, unknown>> => {
        if (task.type === "fate_extra_preview_index_cleanup") {
          return Promise.resolve({ cleaned_generations: 1 });
        }
        return new Promise((resolve) => {
          finish_build = () =>
            resolve({
              built_items_revision: 1,
              built_generation: 2,
              built_adapter_value: "adapter-v1",
            });
        });
      },
    );

    const job = fixture.service.rebuild_duplicate_index({ project_path: PROJECT_PATH });
    await vi.waitFor(() => expect(fixture.index_run).toHaveBeenCalledOnce());
    await event_bus.publish(create_project_unloaded_event(PROJECT_PATH));
    await event_bus.publish(
      create_project_opened_for_cache_event({
        projectPath: PROJECT_PATH,
        sectionRevisions: revision_record(1),
      }),
    );
    finish_build();

    await vi.waitFor(() =>
      expect(["cancelled", "failed"]).toContain(
        fixture.service.jobs_status({ job_id: String(job["job_id"]) })["status"],
      ),
    );
    expect(
      fixture.database_execute.mock.calls.some(
        ([operation]) => operation.name === "activateFateExtraPreviewSearchGeneration",
      ),
    ).toBe(false);
  });

  it("同路径 close/reopen 且 revision/generation 相同时丢弃迟到的预览 worker 结果", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: true });
    const event_bus = new ProjectEventBus();
    fixture.service.subscribe(event_bus);
    let finish_query!: () => void;
    fixture.preview_run.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          finish_query = () =>
            resolve({
              total: 0,
              items: [],
              files: [],
              file_counts: {},
              review_scope: "occurrence",
              index_generation: 1,
              applied_items_revision: 1,
              navigation_generation: 1,
              applied_navigation_revision: 1,
            });
        }),
    );

    const request = fixture.service.list_items({
      project_path: PROJECT_PATH,
      view_mode: "occurrence",
      position: 0,
      limit: 120,
    });
    await vi.waitFor(() => expect(fixture.preview_run).toHaveBeenCalledOnce());
    expect(fixture.preview_run.mock.calls[0]?.[0]).toMatchObject({
      input: {
        projectEpoch: 1,
        expectedGeneration: 1,
        expectedItemsRevision: 1,
        expectedNavigationGeneration: 1,
        expectedNavigationRevision: 1,
      },
    });

    await event_bus.publish(create_project_unloaded_event(PROJECT_PATH));
    await event_bus.publish(
      create_project_opened_for_cache_event({
        projectPath: PROJECT_PATH,
        sectionRevisions: revision_record(1),
      }),
    );
    finish_query();

    await expect(request).rejects.toMatchObject({
      code: "request.validation_failed",
      public_details: {
        reason: "项目已切换或重新打开，已丢弃旧的 FE 预览查询。",
      },
    });
  });

  it("同路径 close/reopen 使文件摘要缓存按新 epoch 重新读取", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: true });
    const event_bus = new ProjectEventBus();
    fixture.service.subscribe(event_bus);
    fixture.preview_run.mockResolvedValue({
      total: 1,
      items: [],
      files: ["route-a.txt"],
      file_counts: { "route-a.txt": 1 },
      review_scope: "occurrence",
      index_generation: 1,
      applied_items_revision: 1,
      navigation_generation: 1,
      applied_navigation_revision: 1,
    });
    const body = {
      project_path: PROJECT_PATH,
      view_mode: "occurrence",
      position: 0,
      limit: 120,
    };

    await fixture.service.list_items(body);
    await fixture.service.list_items(body);
    expect(
      fixture.preview_run.mock.calls.slice(0, 2).map(([task]) => task.input.includeFiles),
    ).toEqual([true, false]);

    await event_bus.publish(create_project_unloaded_event(PROJECT_PATH));
    await event_bus.publish(
      create_project_opened_for_cache_event({
        projectPath: PROJECT_PATH,
        sectionRevisions: revision_record(1),
      }),
    );
    await fixture.service.list_items(body);

    expect(fixture.preview_run.mock.calls[2]?.[0]).toMatchObject({
      input: { includeFiles: true, projectEpoch: 3 },
    });
  });

  it("同路径 close/reopen 清除 duplicate index readiness 并重新检查数据库", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: true });
    const event_bus = new ProjectEventBus();
    fixture.service.subscribe(event_bus);
    const assert_ready = () =>
      (
        fixture.service as unknown as {
          assert_duplicate_index_ready: (project_path: string) => void;
        }
      ).assert_duplicate_index_ready(PROJECT_PATH);

    assert_ready();
    fixture.database_execute.mockClear();
    assert_ready();
    expect(fixture.database_execute).not.toHaveBeenCalled();

    await event_bus.publish(create_project_unloaded_event(PROJECT_PATH));
    await event_bus.publish(
      create_project_opened_for_cache_event({
        projectPath: PROJECT_PATH,
        sectionRevisions: revision_record(1),
      }),
    );
    fixture.set_index_ready(false);
    fixture.database_execute.mockClear();

    expect(assert_ready).toThrow(
      expect.objectContaining({
        code: "request.validation_failed",
        diagnostic_context: expect.objectContaining({
          reason: "fate_extra_preview_index_updating",
        }),
      }),
    );
    expect(fixture.database_execute).toHaveBeenCalledWith({
      name: "getFateExtraTextUnitIndexState",
      args: { projectPath: PROJECT_PATH },
    });
  });

  it("warning 查询把 AbortSignal 传到专用 preview worker", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: true });
    const controller = new AbortController();
    fixture.preview_run.mockImplementation(
      (_task: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("preview-aborted")), {
            once: true,
          });
        }),
    );

    const request = fixture.service.list_items(
      {
        project_path: PROJECT_PATH,
        view_mode: "occurrence",
        warning: "FE_MIGRATION_REVIEW",
        position: 0,
        limit: 120,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(fixture.preview_run).toHaveBeenCalledOnce());
    controller.abort();

    await expect(request).rejects.toThrow("preview-aborted");
    expect((fixture.preview_run.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  });

  it("取消索引 worker 后用新任务清理已提交的非活动 generation", async () => {
    const fixture = create_job_service({ adapterEnabled: true, indexReady: false });
    let abort_observed = false;
    let finish_worker_exit!: () => void;
    fixture.index_run.mockImplementation(
      (task: { type: string }, signal: AbortSignal): Promise<Record<string, unknown>> => {
        if (task.type === "fate_extra_preview_index_cleanup") {
          return Promise.resolve({ cleaned_generations: 1 });
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abort_observed = true;
              finish_worker_exit = () => reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      },
    );

    const job = fixture.service.rebuild_duplicate_index({ project_path: PROJECT_PATH });
    await vi.waitFor(() => expect(fixture.index_run).toHaveBeenCalledOnce());
    expect(fixture.service.jobs_cancel({ job_id: String(job["job_id"]) })).toMatchObject({
      status: "cancelling",
    });
    expect(abort_observed).toBe(true);
    expect(fixture.index_run).toHaveBeenCalledOnce();

    finish_worker_exit();
    await vi.waitFor(() => expect(fixture.index_run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(fixture.service.jobs_status({ job_id: String(job["job_id"]) })["status"]).toBe(
        "cancelled",
      ),
    );
    expect(fixture.index_run.mock.calls[1]?.[0]).toEqual({
      type: "fate_extra_preview_index_cleanup",
      input: { projectPath: PROJECT_PATH },
    });
    const cleanup_signal = fixture.index_run.mock.calls[1]![1] as AbortSignal;
    expect(cleanup_signal.aborted).toBe(false);
  });
});

function create_job_service(
  options: { adapterEnabled?: boolean; indexReady?: boolean; compactEnabled?: boolean } = {},
): {
  service: FateExtraService;
  scan_apply_run: WorkerRun;
  index_run: WorkerRun;
  preview_run: WorkerRun;
  apply_staging: ReturnType<typeof vi.fn>;
  existing_files: Set<string>;
  removed_paths: string[];
  revisions: Record<"files" | "items" | "analysis" | "proofreading", number>;
  database_execute: ReturnType<typeof vi.fn>;
  set_index_ready: (ready: boolean) => void;
} {
  const revisions = revision_record(1);
  let index_ready = options.indexReady === true;
  const existing_files = new Set<string>([
    PROJECT_PATH,
    SOURCE_DIRECTORY,
    COMPLETE_SOURCE,
    CLASSIFICATION_DATABASE,
  ]);
  const removed_paths: string[] = [];
  const database_execute = vi.fn((operation: { name: string; args?: Record<string, unknown> }) => {
    if (operation.name === "getAllMeta") {
      return {
        "project_runtime_revision.files": revisions.files,
        "project_runtime_revision.items": revisions.items,
        "project_runtime_revision.analysis": revisions.analysis,
        "proofreading_revision.proofreading": revisions.proofreading,
        ...(options.adapterEnabled === true
          ? {
              "fate_extra.adapter.v1": {
                enabled: true,
                schema_version: 1,
                logical_text_count: 1,
              },
            }
          : {}),
      };
    }
    if (operation.name === "getFateExtraTextUnitIndexState") {
      return {
        ready: index_ready,
        search_ready: index_ready,
        navigation_ready: index_ready,
        items_revision: revisions.items,
        search_items_revision: index_ready ? revisions.items : 0,
        search_generation: index_ready ? 1 : 0,
        navigation_items_revision: index_ready ? revisions.items : 0,
        navigation_generation: index_ready ? 1 : 0,
      };
    }
    if (operation.name === "getFateExtraCompactState") {
      return { enabled: options.compactEnabled === true };
    }
    if (operation.name === "getMeta") {
      return null;
    }
    if (operation.name === "activateFateExtraPreviewSearchGeneration") {
      return {
        ready: true,
        search_ready: true,
        navigation_ready: true,
        search_generation: Number(operation.args?.["generation"] ?? 0),
        search_items_revision: Number(operation.args?.["expectedItemsRevision"] ?? 0),
        navigation_generation: Number(operation.args?.["generation"] ?? 0),
        navigation_items_revision: Number(operation.args?.["expectedItemsRevision"] ?? 0),
      };
    }
    return {};
  });
  const database = {
    execute: database_execute,
  };
  const native_fs = {
    exists: (file_path: string) => existing_files.has(file_path),
    stat: (file_path: string) => ({
      isDirectory: () => file_path === SOURCE_DIRECTORY,
      isFile: () => file_path !== SOURCE_DIRECTORY,
      mtimeMs: 1,
    }),
    to_identity_path: (file_path: string) => file_path.toLocaleLowerCase(),
    remove: (file_path: string) => {
      removed_paths.push(file_path);
      existing_files.delete(file_path);
    },
    read_dirents: (directory: string) =>
      [...existing_files]
        .filter((file_path) => path.dirname(file_path) === directory)
        .map((file_path) => ({
          name: path.basename(file_path),
          isFile: () => true,
          isDirectory: () => false,
        })),
  };
  const scan_apply_run = vi.fn();
  const index_run = vi.fn();
  const preview_run = vi.fn();
  const apply_staging = vi.fn(
    async (request: {
      commit: (revisions: Record<string, number>) => Promise<Record<string, unknown>>;
    }) => await request.commit({ ...revisions }),
  );
  const service = new FateExtraService(
    {} as AppPathService,
    database as unknown as ProjectDatabase,
    {
      snapshot: () => ({ loaded: true, projectPath: PROJECT_PATH }),
    } as ProjectSessionState,
    {
      run_exclusive_project_write: async (work: () => Promise<unknown>) => await work(),
    } as ProjectOperationGate,
    { apply_fate_extra_scan_staging: apply_staging } as unknown as ProjectWriteStore,
    {} as FateExtraFontService,
    native_fs as unknown as NativeFs,
    {
      scanApply: { run: scan_apply_run } as unknown as BackendWorkerClient,
      export: { run: vi.fn() } as unknown as BackendWorkerClient,
      index: { run: index_run } as unknown as BackendWorkerClient,
      preview: { run: preview_run } as unknown as BackendWorkerClient,
    },
  );
  return {
    service,
    scan_apply_run,
    index_run,
    preview_run,
    apply_staging,
    existing_files,
    removed_paths,
    revisions,
    database_execute,
    set_index_ready: (ready) => {
      index_ready = ready;
    },
  };
}

function scan_body(): Record<string, string> {
  return {
    project_path: PROJECT_PATH,
    source_directory: SOURCE_DIRECTORY,
    complete_jp_source_file: COMPLETE_SOURCE,
    classification_database: CLASSIFICATION_DATABASE,
  };
}

function scan_result(
  staging_path: string,
  project_epoch: number,
  scan_id: string,
): Record<string, unknown> {
  return {
    scan_id,
    report: { scan_id, applicable: true, logical_text_count: 12 },
    staging_path,
    project_path: PROJECT_PATH,
    project_epoch,
    project_section_revisions: revision_record(1),
    fingerprints: [],
    logical_text_count: 12,
  };
}

function revision_record(
  value: number,
): Record<"files" | "items" | "analysis" | "proofreading", number> {
  return { files: value, items: value, analysis: value, proofreading: value };
}
