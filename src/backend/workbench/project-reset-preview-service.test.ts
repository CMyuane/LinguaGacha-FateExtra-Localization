import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "../database/database-operations";
import { TaskRunState } from "../engine/run/task-run-state";
import { ProjectResetPreviewService } from "./project-reset-preview-service";
import { ProjectSessionState } from "../project/project-session";

let temp_dir = "";
const cleanup_databases: ProjectDatabase[] = [];

/**
 * 每个用例创建独立 .lg 数据库和服务，避免状态串扰
 */
function create_service(): {
  database: ProjectDatabase;
  lg_path: string;
  service: ProjectResetPreviewService;
  task_run_state: TaskRunState;
} {
  const database = new ProjectDatabase();
  cleanup_databases.push(database);
  const task_run_state = new TaskRunState();
  const session_state = new ProjectSessionState();
  const lg_path = path.join(temp_dir, "reset-preview.lg");
  database.execute({ name: "createProject", args: { projectPath: lg_path, name: "demo" } });
  session_state.mark_loaded(lg_path);
  const service = new ProjectResetPreviewService(database, task_run_state, session_state);
  return { database, lg_path, service, task_run_state };
}

beforeEach(() => {
  temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-reset-preview-"));
});

afterEach(() => {
  while (cleanup_databases.length > 0) {
    cleanup_databases.pop()?.close();
  }
  fs.rmSync(temp_dir, { recursive: true, force: true });
});

describe("ProjectResetPreviewService", () => {
  it("分析 failed 预演按删除 ERROR checkpoint 后的摘要返回", async () => {
    const { database, lg_path, service } = create_service();
    database.execute({
      name: "setItems",
      args: {
        projectPath: lg_path,
        items: [
          { id: 1, src: "A", status: "NONE" },
          { id: 2, src: "B", status: "NONE" },
          { id: 3, src: "C", status: "EXCLUDED" },
        ],
      },
    });
    database.execute({
      name: "upsertAnalysisItemCheckpoints",
      args: {
        projectPath: lg_path,
        checkpoints: [
          { item_id: 1, status: "PROCESSED" },
          { item_id: 2, status: "ERROR" },
        ],
      },
    });

    await expect(service.preview_analysis_reset({ mode: "failed" })).resolves.toEqual({
      status_summary: { total_line: 2, processed_line: 1, error_line: 0, line: 1 },
    });
  });
});
