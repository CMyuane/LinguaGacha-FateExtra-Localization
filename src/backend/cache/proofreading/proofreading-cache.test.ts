import { describe, expect, it, vi } from "vitest";

import type { AppSettingService } from "../../app/app-setting-service";
import type { BackendWorkerClient } from "../../worker/worker-client";
import {
  createProofreadingListReader,
  evaluateProofreadingSlice,
  type ProofreadingSyncInput,
} from "../../../shared/proofreading/proofreading-list-reader";
import type { CacheReadPort } from "../cache-types";
import type { CacheChange } from "../cache-change";
import { ProofreadingCache } from "./proofreading-cache";

// 提供 ProofreadingCache 所需的最小缓存读口，并允许覆盖 revisions 与 items。
function create_cache_read_port(options: {
  epoch?: number;
  revisions?: Record<string, number>;
  items?: Array<Record<string, unknown>>;
}): CacheReadPort {
  return {
    snapshot: () => ({
      projectPath: "E:/Project/demo.lg",
      epoch: options.epoch ?? 1,
      freshness: "fresh",
      sectionRevisions: options.revisions ?? { files: 1, items: 1, quality: 1, proofreading: 0 },
      itemCount: options.items?.length ?? 1,
    }),
    readSectionRevisions: () =>
      options.revisions ?? { files: 1, items: 1, quality: 1, proofreading: 0 },
    items: {
      readItems: () =>
        options.items ?? [
          {
            id: 1,
            file_path: "script.txt",
            row: 1,
            src: "HP",
            dst: "HP",
            status: "PROCESSED",
            text_type: "NONE",
            retry_count: 0,
          },
        ],
      readItem: (itemId: number) => {
        const items = options.items ?? [
          {
            id: 1,
            file_path: "script.txt",
            row: 1,
            src: "HP",
            dst: "HP",
            status: "PROCESSED",
            text_type: "NONE",
            retry_count: 0,
          },
        ];
        const item = items.find((entry) => Number(entry["item_id"] ?? entry["id"] ?? 0) === itemId);
        return item === undefined ? null : { ...item };
      },
    },
    files: {
      readFileEntries: () => [{ rel_path: "script.txt", file_type: "TXT", sort_index: 0 }],
    },
    quality: {
      readBlock: () => ({
        glossary: {
          enabled: true,
          mode: "custom",
          revision: 1,
          entries: [{ src: "HP", dst: "生命值" }],
        },
      }),
    },
    prompts: {
      readBlock: () => ({}),
    },
    analysis: {
      readBlock: () => ({}),
    },
  } as CacheReadPort;
}

// 固定测试语言设置，避免缓存测试依赖真实 app setting。
function create_settings(): AppSettingService {
  return {
    read_setting: () => ({ source_language: "JA", target_language: "ZH" }),
  } as unknown as AppSettingService;
}

// 记录 proofreading_sync 输入，并用真实 list reader 评估 worker 返回值。
function create_worker(): BackendWorkerClient & {
  sync_inputs: ProofreadingSyncInput[];
} {
  const sync_inputs: ProofreadingSyncInput[] = [];
  return {
    sync_inputs,
    run: vi.fn(async (task: { type: string; input: ProofreadingSyncInput }) => {
      if (task.type !== "proofreading_sync") {
        throw new Error(`测试未实现 task：${task.type}`);
      }
      sync_inputs.push(task.input);
      return evaluateProofreadingSlice(task.input);
    }),
    dispose: vi.fn(async () => undefined),
  } as unknown as BackendWorkerClient & {
    sync_inputs: ProofreadingSyncInput[];
  };
}

type DeferredSyncJob = {
  input: ProofreadingSyncInput;
  signal: AbortSignal;
  resolve: () => void;
};

// 模拟不响应 AbortSignal 的旧 worker，以验证 generation 会拒绝迟到结果。
function create_deferred_worker(): BackendWorkerClient & { jobs: DeferredSyncJob[] } {
  const jobs: DeferredSyncJob[] = [];
  return {
    jobs,
    run: vi.fn(
      (task: { type: string; input: ProofreadingSyncInput }, signal: AbortSignal) =>
        new Promise((resolve) => {
          if (task.type !== "proofreading_sync") {
            throw new Error(`测试未实现 task：${task.type}`);
          }
          jobs.push({
            input: task.input,
            signal,
            resolve: () => resolve(evaluateProofreadingSlice(task.input)),
          });
        }),
    ),
    dispose: vi.fn(async () => undefined),
  } as unknown as BackendWorkerClient & { jobs: DeferredSyncJob[] };
}

// 生成 items delta 事件，用例只覆盖需要验证的字段。
function create_delta_change(overrides: Partial<CacheChange> = {}): CacheChange {
  return {
    eventType: "project.items.changed",
    projectPath: "E:/Project/demo.lg",
    source: "translation_commit",
    affectedSections: ["items"],
    sectionRevisions: { files: 1, items: 2, quality: 1, proofreading: 0 },
    fullRebuild: false,
    items: {
      mode: "delta",
      changedIds: [1],
      deleteIds: [],
      fieldPatch: null,
      sourcePayloadMode: "canonical-delta",
    },
    files: { mode: "keep" },
    quality: { mode: "keep" },
    prompts: { mode: "keep" },
    settings: { mode: "keep" },
    analysis: { mode: "keep" },
    ...overrides,
  };
}

describe("ProofreadingCache", () => {
  it("FE 精简工程从数据库读取去重 item，而不是把空的轻量缓存当成空工程", async () => {
    const worker = create_worker();
    const cache_port = create_cache_read_port({ items: [] });
    const read_items = vi.spyOn(cache_port.items, "readItems");
    cache_port.snapshot = () => ({
      projectPath: "E:/Project/compact-fe.lg",
      epoch: 1,
      freshness: "fresh",
      sectionRevisions: { files: 1, items: 1, quality: 1, proofreading: 0 },
      itemCount: 2,
    });
    const execute = vi.fn((operation: { name: string }) => {
      if (operation.name === "getFateExtraCompactState") return { enabled: true };
      if (operation.name === "getAllItems") {
        return [
          { id: 11, file_path: "route.txt", row: 1, src: "原文一", dst: "初翻一" },
          { id: 12, file_path: "route.txt", row: 2, src: "原文二", dst: "初翻二" },
        ];
      }
      throw new Error(`unexpected operation: ${operation.name}`);
    });
    const cache = new ProofreadingCache({
      cache: cache_port,
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
      database: { execute } as never,
    });

    const sync = await cache.sync({});
    const view = await cache.list({
      filters: sync.data.defaultFilters,
      keyword: "",
      scope: "all",
      is_regex: false,
      sort_state: null,
    });

    expect(view.data.row_count).toBe(2);
    expect(worker.sync_inputs[0]?.upsertItems.map((item) => item.src)).toEqual([
      "原文一",
      "原文二",
    ]);
    expect(execute).toHaveBeenCalledWith({
      name: "getAllItems",
      args: { projectPath: "E:/Project/compact-fe.lg" },
    });
    expect(execute).toHaveBeenCalledTimes(2);

    execute.mockClear();
    read_items.mockClear();
    vi.mocked(worker.run).mockClear();
    for (let index = 0; index < 100; index += 1) {
      const hot_sync = await cache.sync({});
      const hot_view = await cache.list({
        filters: hot_sync.data.defaultFilters,
        keyword: "",
        scope: "all",
        is_regex: false,
        sort_state: null,
      });
      await cache.window({ view_id: hot_view.data.view_id, start: 0, count: 160 });
      await cache.filterPanel({ filters: hot_sync.data.defaultFilters });
    }

    expect(execute).not.toHaveBeenCalled();
    expect(read_items).not.toHaveBeenCalled();
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("同一工程身份下只执行一次 sync task 并用本地列表 service 查询", async () => {
    const worker = create_worker();
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({}),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });

    const sync = await cache.sync({});
    const view = await cache.list({
      filters: sync.data.defaultFilters,
      keyword: "",
      scope: "all",
      is_regex: false,
      sort_state: null,
    });

    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(worker.sync_inputs[0]).toMatchObject({
      projectId: "E:/Project/demo.lg",
      sourceLanguage: "JA",
      targetLanguage: "ZH",
      total_item_count: 1,
    });
    expect(view).toMatchObject({
      projectPath: "E:/Project/demo.lg",
      sectionRevisions: { files: 1, items: 1, quality: 1, proofreading: 0 },
      data: { row_count: 1 },
    });
  });

  it("缓存命中只读取轻量身份，不重复构造完整同步载荷", async () => {
    const worker = create_worker();
    const cache_port = create_cache_read_port({});
    const read_items = vi.spyOn(cache_port.items, "readItems");
    const read_files = vi.spyOn(cache_port.files, "readFileEntries");
    const read_quality = vi.spyOn(cache_port.quality, "readBlock");
    const cache = new ProofreadingCache({
      cache: cache_port,
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });

    const sync = await cache.sync({});
    await cache.list({
      filters: sync.data.defaultFilters,
      keyword: "",
      scope: "all",
      is_regex: false,
      sort_state: null,
    });
    await cache.filterPanel({
      filters: sync.data.defaultFilters,
    });

    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(read_items).toHaveBeenCalledTimes(1);
    expect(read_files).toHaveBeenCalledTimes(1);
    expect(read_quality).toHaveBeenCalledTimes(1);
  });

  it("相同未完成身份复用同步任务且只构造一次载荷", async () => {
    const worker = create_deferred_worker();
    const cache_port = create_cache_read_port({});
    const read_items = vi.spyOn(cache_port.items, "readItems");
    const cache = new ProofreadingCache({
      cache: cache_port,
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });

    const first = cache.sync({});
    const second = cache.sync({});

    expect(worker.jobs).toHaveLength(1);
    expect(read_items).toHaveBeenCalledTimes(1);
    worker.jobs[0]?.resolve();
    const [first_result, second_result] = await Promise.all([first, second]);

    expect(first_result.data.revisions).toEqual(second_result.data.revisions);
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("身份变化会取消旧同步并拒绝迟到结果覆盖新 generation", async () => {
    const revisions = { files: 1, items: 1, quality: 1, proofreading: 0 };
    const items = [
      {
        item_id: 1,
        file_path: "script.txt",
        row_number: 1,
        src: "原文",
        dst: "旧译文",
        status: "NONE",
        text_type: "NONE",
        retry_count: 0,
      },
    ];
    const worker = create_deferred_worker();
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({ revisions, items }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });

    const first = cache.sync({});
    const first_rejection = expect(first).rejects.toMatchObject({ code: "runtime.cancelled" });
    revisions.items = 2;
    items[0] = { ...items[0], dst: "新译文" };
    const second = cache.sync({});

    expect(worker.jobs).toHaveLength(2);
    expect(worker.jobs[0]?.signal.aborted).toBe(true);
    worker.jobs[1]?.resolve();
    await expect(second).resolves.toMatchObject({ data: { revisions: { items: 2 } } });
    worker.jobs[0]?.resolve();
    await first_rejection;

    const current = await cache.sync({});
    expect(current.data.revisions.items).toBe(2);
    expect(worker.run).toHaveBeenCalledTimes(2);
  });

  it("项目清理会取消未完成同步且迟到任务不能恢复已清理状态", async () => {
    const worker = create_deferred_worker();
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({}),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });

    const pending = cache.sync({});
    const pending_rejection = expect(pending).rejects.toMatchObject({ code: "runtime.cancelled" });
    await cache.clearProject("E:/Project/demo.lg");

    expect(worker.jobs[0]?.signal.aborted).toBe(true);
    worker.jobs[0]?.resolve();
    await pending_rejection;

    const next = cache.sync({});
    worker.jobs[1]?.resolve();
    await expect(next).resolves.toMatchObject({ projectPath: "E:/Project/demo.lg" });
    expect(worker.run).toHaveBeenCalledTimes(2);
  });

  it("revision 或语言变化会生成新的缓存身份并重新执行 sync task", async () => {
    const worker = create_worker();
    const first_cache = new ProofreadingCache({
      cache: create_cache_read_port({
        revisions: { files: 1, items: 1, quality: 1, proofreading: 0 },
      }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    await first_cache.sync({ sourceLanguage: "JA", targetLanguage: "ZH" });
    const second_cache = new ProofreadingCache({
      cache: create_cache_read_port({
        revisions: { files: 1, items: 2, quality: 1, proofreading: 0 },
      }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    await second_cache.sync({ sourceLanguage: "JA", targetLanguage: "EN" });

    expect(worker.run).toHaveBeenCalledTimes(2);
    expect(worker.sync_inputs.map((input) => input.targetLanguage)).toEqual(["ZH", "EN"]);
  });

  it("文件 section revision 变化会生成新的校对缓存身份", async () => {
    const worker = create_worker();
    const first_cache = new ProofreadingCache({
      cache: create_cache_read_port({
        revisions: { files: 1, items: 1, quality: 1, proofreading: 0 },
      }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    await first_cache.sync({});
    const second_cache = new ProofreadingCache({
      cache: create_cache_read_port({
        revisions: { files: 2, items: 1, quality: 1, proofreading: 0 },
      }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    await second_cache.sync({});

    expect(worker.run).toHaveBeenCalledTimes(2);
    expect(worker.sync_inputs.map((input) => input.revisions.files)).toEqual([1, 2]);
  });

  it("项目卸载时只清理本地校对缓存并重新执行 sync task", async () => {
    const worker = create_worker();
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({}),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    await cache.sync({});

    await cache.clearProject("E:/Project/demo.lg");
    await cache.sync({});

    expect(worker.run).toHaveBeenCalledTimes(2);
  });

  it("项目切换热机时允许无路径清理旧校对缓存", async () => {
    const worker = create_worker();
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({}),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    await cache.sync({});

    await cache.clearProject();
    await cache.sync({});

    expect(worker.run).toHaveBeenCalledTimes(2);
  });

  it("已同步后 item 增量会应用到本地校对列表运行态", async () => {
    const worker = create_worker();
    const revisions = { files: 1, items: 1, quality: 1, proofreading: 0 };
    const items = [
      {
        item_id: 1,
        file_path: "script.txt",
        row_number: 1,
        src: "HP",
        dst: "HP",
        status: "PROCESSED",
        text_type: "NONE",
        retry_count: 0,
      },
    ];
    const service = createProofreadingListReader();
    const apply_delta = vi.spyOn(service, "apply_item_delta");
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({ revisions, items }),
      appSettingService: create_settings(),
      workerClient: worker,
      service,
    });
    await cache.sync({});
    revisions.items = 2;
    items[0] = { ...items[0], dst: "生命值" };

    await cache.applyChange(create_delta_change(), revisions);
    const next_sync = await cache.sync({});

    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(apply_delta).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "E:/Project/demo.lg",
        revisions: { files: 1, items: 2, quality: 1, proofreading: 0 },
        upsertItems: [expect.objectContaining({ item_id: 1, dst: "生命值" })],
      }),
    );
    expect(next_sync.data.revisions.items).toBe(2);
  });

  it("field-patch 增量会更新旧列表窗口内容且不重建排序", async () => {
    const worker = create_worker();
    const revisions = { files: 1, items: 1, quality: 1, proofreading: 0 };
    const items = [
      {
        item_id: 1,
        file_path: "script.txt",
        row_number: 1,
        src: "A",
        dst: "M",
        status: "NONE",
        text_type: "NONE",
        retry_count: 0,
      },
      {
        item_id: 2,
        file_path: "script.txt",
        row_number: 2,
        src: "B",
        dst: "Z",
        status: "NONE",
        text_type: "NONE",
        retry_count: 0,
      },
    ];
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({ revisions, items }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    const sync = await cache.sync({});
    const view = await cache.list({
      filters: sync.data.defaultFilters,
      keyword: "",
      scope: "all",
      is_regex: false,
      sort_state: { column_id: "dst", direction: "ascending" },
      window_start: 0,
      window_count: 10,
    });
    revisions.items = 2;

    await cache.applyChange(
      create_delta_change({
        items: {
          mode: "delta",
          changedIds: [2],
          deleteIds: [],
          fieldPatch: { dst: "A", status: "PROCESSED" },
          sourcePayloadMode: "field-patch",
        },
      }),
      revisions,
    );
    const window = await cache.window({
      view_id: view.data.view_id,
      start: 0,
      count: 10,
    });

    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(window.data.rows.map((row) => row.row_id)).toEqual(["1", "2"]);
    expect(window.data.rows[1]?.item).toMatchObject({
      item_id: 2,
      dst: "A",
      status: "PROCESSED",
    });
  });

  it("删除增量会剪裁旧列表窗口", async () => {
    const worker = create_worker();
    const revisions = { files: 1, items: 1, quality: 1, proofreading: 0 };
    const items = [
      {
        item_id: 1,
        file_path: "script.txt",
        row_number: 1,
        src: "A",
        dst: "A",
        status: "NONE",
        text_type: "NONE",
        retry_count: 0,
      },
      {
        item_id: 2,
        file_path: "script.txt",
        row_number: 2,
        src: "B",
        dst: "B",
        status: "NONE",
        text_type: "NONE",
        retry_count: 0,
      },
    ];
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({ revisions, items }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    const sync = await cache.sync({});
    const view = await cache.list({
      filters: sync.data.defaultFilters,
      keyword: "",
      scope: "all",
      is_regex: false,
      sort_state: null,
      window_start: 0,
      window_count: 10,
    });
    revisions.items = 2;
    items.splice(0, 1);

    await cache.applyChange(
      create_delta_change({
        items: {
          mode: "delta",
          changedIds: [],
          deleteIds: [1],
          fieldPatch: null,
          sourcePayloadMode: "canonical-delta",
        },
      }),
      revisions,
    );
    const window = await cache.window({
      view_id: view.data.view_id,
      start: 0,
      count: 10,
    });

    expect(window.data.row_count).toBe(1);
    expect(window.data.rows.map((row) => row.row_id)).toEqual(["2"]);
  });

  it("quality 或 files 变化会失效已同步的校对缓存", async () => {
    const worker = create_worker();
    const revisions = { files: 1, items: 1, quality: 1, proofreading: 0 };
    const cache = new ProofreadingCache({
      cache: create_cache_read_port({ revisions }),
      appSettingService: create_settings(),
      workerClient: worker,
      service: createProofreadingListReader(),
    });
    await cache.sync({});
    revisions.quality = 2;

    await cache.applyChange(
      create_delta_change({
        eventType: "project.quality.changed",
        affectedSections: ["quality"],
        sectionRevisions: { quality: 2 },
        items: { mode: "keep" },
        quality: { mode: "full" },
      }),
      revisions,
    );
    await cache.sync({});

    expect(worker.run).toHaveBeenCalledTimes(2);
  });
});
