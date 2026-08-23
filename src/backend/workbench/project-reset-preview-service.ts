import type { ApiJsonValue } from "../api/api-types";
import { ProjectDatabase } from "../database/database-operations";
import type { DatabaseJsonValue, DatabaseOperation } from "../database/database-types";
import { Item } from "../../domain/item";
import { is_task_skipped_item_status } from "../../domain/task";
import { TaskRunState } from "../engine/run/task-run-state";
import { ProjectSessionState } from "../project/project-session";
import * as AppErrors from "../../shared/error";

type JsonRecord = Record<string, ApiJsonValue>;
type MutableJsonRecord = Record<string, ApiJsonValue>;

/**
 * 承载公开 reset preview；当前服务负责预演响应和 asset 重解析
 */
export class ProjectResetPreviewService {
  /**
   * reset preview 只读数据库，不负责提交真实 reset 写入
   */
  public constructor(
    private readonly database: ProjectDatabase,
    private readonly task_run_state: TaskRunState,
    private readonly session_state: ProjectSessionState,
  ) {}

  /**
   * 分析 failed reset 的预演只移除 ERROR checkpoint，不触碰候选池或 item 事实
   */
  public async preview_analysis_reset(request: JsonRecord): Promise<JsonRecord> {
    const mode = String(request["mode"] ?? "").toLowerCase();
    if (mode !== "failed") {
      throw new AppErrors.RequestValidationError();
    }
    const project_path = await this.require_idle_project_path();
    const checkpoints = this.get_analysis_checkpoints(project_path);
    let total_line = 0;
    let processed_line = 0;
    for (const item of this.get_all_items(project_path)) {
      const status = this.normalize_item_status(item["status"]);
      if (is_task_skipped_item_status(status)) {
        continue;
      }
      const item_id = this.read_number(item["id"], 0);
      if (item_id <= 0 || String(item["src"] ?? "").trim() === "") {
        continue;
      }
      total_line += 1;
      if (checkpoints.get(item_id) === "PROCESSED") {
        processed_line += 1;
      }
    }
    return {
      status_summary: {
        total_line,
        processed_line,
        error_line: 0,
        line: processed_line,
      },
    };
  }

  /**
   * reset 预演和真实 reset 一样要求工程已加载且后台任务空闲
   */
  private async require_idle_project_path(): Promise<string> {
    const state = this.session_state.snapshot();
    if (!state.loaded || state.projectPath === "") {
      throw new AppErrors.ProjectNotLoadedError();
    }
    if (this.task_run_state.snapshot().busy) {
      throw new AppErrors.TaskBusyError();
    }
    return state.projectPath;
  }

  /**
   * 分析预演只需要 item 当前事实，读取后复制一份避免误改数据库返回对象
   */
  private get_all_items(project_path: string): MutableJsonRecord[] {
    const value = this.database.execute(this.op("getAllItems", { projectPath: project_path }));
    return Array.isArray(value)
      ? value
          .filter((item): item is JsonRecord => this.is_record(item))
          .map((item) => ({ ...item }))
      : [];
  }

  /**
   * ERROR checkpoint 会在真实 failed reset 中被删除，预演据此计算剩余进度
   */
  private get_analysis_checkpoints(project_path: string): Map<number, string> {
    const value = this.database.execute(
      this.op("getAnalysisItemCheckpoints", { projectPath: project_path }),
    );
    const checkpoints = new Map<number, string>();
    if (!Array.isArray(value)) {
      return checkpoints;
    }
    for (const row of value) {
      if (!this.is_record(row)) {
        continue;
      }
      const item_id = this.read_number(row["item_id"], 0);
      const status = String(row["status"] ?? "");
      if (item_id > 0 && (status === "PROCESSED" || status === "ERROR")) {
        checkpoints.set(item_id, status);
      }
    }
    return checkpoints;
  }

  /**
   * 重置预演只接受当前状态枚举，非法值按未处理状态兜底
   */
  private normalize_item_status(value: ApiJsonValue | undefined): string {
    return Item.normalize_status(value);
  }

  /**
   * SQLite/JSON 数字统一截断为整数，避免 id 和 row 出现小数
   */
  private read_number(value: ApiJsonValue | undefined, fallback: number): number {
    const number_value = Number(value ?? fallback);
    return Number.isFinite(number_value) ? Math.trunc(number_value) : fallback;
  }

  /**
   * 数据库 JSON 返回只允许对象继续进入业务归一化
   */
  private is_record(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /**
   * 数据库操作名和参数集中封装，减少调用点重复对象形状
   */
  private op(name: string, args: Record<string, DatabaseJsonValue>): DatabaseOperation {
    return { name, args };
  }
}
