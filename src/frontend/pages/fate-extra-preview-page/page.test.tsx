import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api_fetch_mock, desktop_state_fixture, translate } = vi.hoisted(() => ({
  api_fetch_mock: vi.fn(),
  translate: (key: string) => key,
  desktop_state_fixture: {
    current: {
      project_epoch: 1,
      project_snapshot: { loaded: true, path: "D:\\project.lg" },
      project_change_signal: { seq: 0 } as { seq: number; results?: Array<{ source: string }> },
      task_snapshot: { busy: false },
      commit_project_write: vi.fn(),
      refresh_task: vi.fn(),
    },
  },
}));

vi.mock("@frontend/app/desktop/desktop-api", () => ({
  api_fetch: api_fetch_mock,
}));

vi.mock("@frontend/app/locale/locale-provider", () => ({
  useI18n: () => ({ t: translate }),
}));

vi.mock("@frontend/app/state/use-desktop-state", () => ({
  useDesktopState: () => desktop_state_fixture.current,
}));

vi.mock("@frontend/widgets/app-editor/app-editor", () => ({
  AppEditor: (props: {
    value: string;
    aria_label: string;
    read_only: boolean;
    on_change?: (value: string) => void;
  }) => (
    <textarea
      aria-label={props.aria_label}
      value={props.value}
      readOnly={props.read_only}
      onChange={(event) => props.on_change?.(event.target.value)}
    />
  ),
}));

vi.mock("@frontend/widgets/app-dropdown-menu", () => ({
  AppDropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppDropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppDropdownMenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AppDropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  AppDropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@frontend/widgets/app-page-dialog", () => ({
  AppPageDialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div data-testid="page-dialog">{props.children}</div> : null,
}));

vi.mock("@frontend/pages/proofreading-page/components/proofreading-confirm-dialog", () => ({
  ProofreadingConfirmDialog: (props: {
    state: { kind: string } | null;
    on_confirm: () => Promise<void>;
  }) =>
    props.state === null ? null : (
      <button data-testid={`confirm-${props.state.kind}`} onClick={() => void props.on_confirm()}>
        confirm
      </button>
    ),
}));

import {
  calculate_preview_line_baselines,
  FateExtraPreviewPage,
} from "@frontend/pages/fate-extra-preview-page/page";

const ITEM = {
  item_id: 7,
  occurrence_id: 101,
  text_unit_id: 3,
  occurrence_count: 2,
  file_path: "route.txt",
  row_number: 3,
  src: "原文",
  dst: "旧译文",
  machine_translation: "旧译文",
  proofread_translation: "",
  effective_translation: "旧译文",
  status: "NONE",
  warnings: ["FE_PSP_OVERFLOW"],
  overflow: true,
  display_mode: "auto",
  resolved_display_mode: "dialogue",
  display_resolution: {
    source: "script",
    confidence: "high",
    reason: "0x3926 portrait 9217",
    opcode: 0x3926,
    portrait_id: 9217,
  },
  encoded_bytes: 6,
  machine_encoded_bytes: 6,
  proofread_encoded_bytes: 6,
  slot_capacity: 32,
  classification: {
    category: "ordinary_independent_slot",
    category_zh: "普通独立槽位",
    confidence: "high",
    reason: "独立槽位",
    translator_message: "不超过容量即可原位替换。",
    shared_storage_group: "",
    format_handler: "",
    allow_overlength: false,
  },
  index: { path: "field/001.dat", char_offset: 1234 },
};

describe("FateExtraPreviewPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stored_item = { ...ITEM };

  it("keeps ruby on a later line clear of the previous base line", () => {
    expect(
      calculate_preview_line_baselines({
        first_y: 111,
        line_gap: 36,
        base_font_size: 22,
        ruby_font_size: 12,
        line_has_ruby: [false, true],
        visible_line_count: 2,
      }),
    ).toEqual([111, 155]);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    stored_item = { ...ITEM };
    desktop_state_fixture.current.project_epoch = 1;
    desktop_state_fixture.current.project_snapshot = {
      loaded: true,
      path: "D:\\project.lg",
    };
    desktop_state_fixture.current.project_change_signal = { seq: 0 };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api_fetch_mock.mockReset();
    desktop_state_fixture.current.commit_project_write.mockReset();
    desktop_state_fixture.current.refresh_task.mockReset();
    desktop_state_fixture.current.commit_project_write.mockImplementation(
      async (request: {
        run: () => Promise<unknown>;
        prepare?: (args: { payload: unknown }) => void;
      }) => {
        const payload = await request.run();
        request.prepare?.({ payload });
        return { payload, write_result: { accepted: true, changes: [] } };
      },
    );
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
          query_id: body?.["query_id"],
          total: 501,
          items: [stored_item],
          files: ["route.txt"],
        });
      }
      if (path === "/api/session/project/manifest") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
        });
      }
      if (path === "/api/toolbox/fate-extra/context") {
        return Promise.resolve({
          found: true,
          resource_path: "field/001.dat",
          target_ordinal: 2,
          block_count: 5,
          radius: 2,
          items: [0, 1, 2, 3, 4].map((index) => ({
            item_id: index + 1,
            char_offset: 1200 + index,
            block_ordinal: index,
            is_current: index === 2,
            source: `source-${index}`,
            machine_translation: `machine-${index}`,
            proofread_translation: index === 2 ? "proof-current" : "",
            status: "NONE",
          })),
        });
      }
      if (path === "/api/toolbox/fate-extra/review/save") {
        stored_item = {
          ...stored_item,
          proofread_translation: String(body?.["proofread_translation"] ?? ""),
          display_mode: String(body?.["display_mode"] ?? "auto"),
        };
        return Promise.resolve({
          accepted: true,
          changes: [],
          item: stored_item,
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
        });
      }
      return Promise.resolve({ accepted: true, changes: [] });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render_page(): Promise<void> {
    await act(async () => {
      root.render(<FateExtraPreviewPage is_sidebar_collapsed={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("同时显示原文、初翻和校对稿，并通过 FE 专用接口保存校对稿", async () => {
    await render_page();
    expect(container.textContent).toContain("fate_extra_preview_page.machine_assessment");
    expect(container.textContent).toContain("fate_extra_preview_page.proofread_assessment");
    expect(container.textContent).toContain("fate_extra_preview_page.dialogue_line_limit");
    const translation = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="fate_extra_preview_page.proofread_translation"]',
    );
    expect(translation?.value).toBe("");
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="fate_extra_preview_page.machine_translation"]',
      )?.value,
    ).toBe("旧译文");

    await act(async () => {
      if (translation !== null) {
        const value_setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        value_setter?.call(translation, "新译文\n第二行");
        translation.dispatchEvent(new Event("input", { bubbles: true }));
        translation.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const save_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("proofreading_page.action.save"),
    );
    await act(async () => {
      save_button?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/toolbox/fate-extra/review/save", {
      item_id: 7,
      occurrence_id: 101,
      text_unit_id: 3,
      review_scope: "unit",
      proofread_translation: "新译文\n第二行",
      display_mode: "auto",
      project_path: "D:\\project.lg",
      expected_section_revisions: { items: 4, proofreading: 5 },
    });
  });

  it.each(["http-first", "sse-first"])(
    "保存期间保持编辑器、焦点与草稿，%s 回流不会闪白",
    async (order) => {
      let resolve_save!: (value: unknown) => void;
      const pending_queries: Array<(value: unknown) => void> = [];
      let requests = 0;
      const saved = {
        ...ITEM,
        proofread_translation: "已保存稿",
        effective_translation: "已保存稿",
        status: "PROCESSED",
      };
      api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
        if (path === "/api/toolbox/fate-extra/items") {
          requests += 1;
          if (requests === 1)
            return Promise.resolve({
              query_id: body?.["query_id"],
              sectionRevisions: { items: 4, proofreading: 5 },
              items: [ITEM],
              total: 1,
            });
          return new Promise((resolve) =>
            pending_queries.push((value) =>
              resolve({ query_id: body?.["query_id"], ...(value as object) }),
            ),
          );
        }
        if (path === "/api/toolbox/fate-extra/review/save")
          return new Promise((resolve) => {
            resolve_save = resolve;
          });
        return Promise.resolve({ accepted: true, changes: [] });
      });
      await render_page();
      const editor = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="fate_extra_preview_page.proofread_translation"]',
      )!;
      const input = (value: string) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          editor,
          value,
        );
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        input("已保存稿");
      });
      editor.focus();
      editor.setSelectionRange(2, 2);
      editor.scrollTop = 9;
      const save = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("proofreading_page.action.save"),
      )!;
      await act(async () => {
        save.click();
      });
      const emit_change = async () => {
        await act(async () => {
          desktop_state_fixture.current.project_change_signal = {
            seq: 1,
            results: [{ source: "fate_extra_text_unit_review_save" }],
          };
          root.render(<FateExtraPreviewPage is_sidebar_collapsed={false} />);
        });
      };
      const assert_continuous = () => {
        expect(
          container.querySelector(
            'textarea[aria-label="fate_extra_preview_page.proofread_translation"]',
          ),
        ).toBe(editor);
        expect(editor.value).toBe("已保存稿");
        expect(document.activeElement).toBe(editor);
        expect(editor.selectionStart).toBe(2);
        expect(editor.scrollTop).toBe(9);
      };
      if (order === "sse-first") await emit_change();
      assert_continuous();
      await act(async () => {
        resolve_save({
          accepted: true,
          changes: [],
          item: saved,
          sectionRevisions: { items: 5, proofreading: 6 },
        });
      });
      if (order === "http-first") await emit_change();
      assert_continuous();
      await act(async () => {
        input("继续编辑的草稿");
      });
      await act(async () => {
        pending_queries.at(-1)?.({
          sectionRevisions: { items: 5, proofreading: 6 },
          items: [saved],
          total: 1,
        });
      });
      expect(editor.value).toBe("继续编辑的草稿");
      expect(
        api_fetch_mock.mock.calls.some(([path]) => path === "/api/session/project/manifest"),
      ).toBe(false);
    },
  );

  it("保存失败后保留草稿和错误，后台重查不会误报成功", async () => {
    const original = api_fetch_mock.getMockImplementation()!;
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) =>
      path === "/api/toolbox/fate-extra/review/save"
        ? Promise.reject(new Error("版本冲突"))
        : original(path, body),
    );
    await render_page();
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="fate_extra_preview_page.proofread_translation"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "保留草稿",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("proofreading_page.action.save"))
        ?.click();
    });
    expect(editor.value).toBe("保留草稿");
    expect(container.textContent).toContain("版本冲突");
    expect(container.textContent).not.toContain("app.feedback.save_success");
  });

  it("首次查询返回前立即显示准备状态，旧索引就绪前禁止编辑", async () => {
    api_fetch_mock.mockImplementation(() => new Promise(() => undefined));
    await render_page();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "fate_extra_preview_page.index_phase.checking",
    );
    expect(container.querySelector("progress")?.hasAttribute("value")).toBe(false);
    expect(container.querySelector("main")?.getAttribute("data-index-loading")).toBe("true");
  });

  it("支持清空译文、重新翻译和设置翻译状态", async () => {
    await render_page();
    const buttons = () => [...container.querySelectorAll("button")];

    await act(async () => {
      buttons()
        .find((button) =>
          button.textContent?.includes("proofreading_page.action.clear_translation"),
        )
        ?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="confirm-clear-translations"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/toolbox/fate-extra/review/save", {
      item_id: 7,
      occurrence_id: 101,
      text_unit_id: 3,
      review_scope: "unit",
      proofread_translation: "",
      display_mode: "auto",
      project_path: "D:\\project.lg",
      expected_section_revisions: { items: 4, proofreading: 5 },
    });

    await act(async () => {
      buttons()
        .find((button) => button.textContent?.includes("proofreading_page.status.processed"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/proofreading/items/set-status", {
      item_ids: [7],
      status: "PROCESSED",
      project_path: "D:\\project.lg",
      expected_section_revisions: { items: 4, proofreading: 5 },
    });

    await act(async () => {
      buttons()
        .find((button) => button.textContent?.includes("proofreading_page.action.retranslate"))
        ?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-retranslate"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/tasks/start", {
      task_type: "translation",
      mode: "new",
      scope: { kind: "items", item_ids: [7] },
      expected_section_revisions: {
        items: 4,
        proofreading: 5,
        quality: 6,
        prompts: 7,
      },
    });
    expect(desktop_state_fixture.current.refresh_task).toHaveBeenCalledWith("translation");
  });

  it("到达当前批次末尾时继续读取下一批条目", async () => {
    await render_page();
    const next_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.next"),
    );

    await act(async () => {
      next_button?.click();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api_fetch_mock).toHaveBeenLastCalledWith(
      "/api/toolbox/fate-extra/items",
      {
        project_path: "D:\\project.lg",
        search: "",
        file_path: "",
        warning: "",
        category: "",
        view_mode: "unique",
        position: 120,
        limit: 120,
        query_id: expect.any(Number),
      },
      { signal: expect.anything() },
    );
  });

  it("搜索条件变化时取消已发出的预览请求并只保留最新请求", async () => {
    await render_page();
    const first_options = api_fetch_mock.mock.calls
      .filter(([path]) => path === "/api/toolbox/fate-extra/items")
      .at(-1)?.[2] as { signal?: AbortSignal } | undefined;
    const search_input = container.querySelector<HTMLInputElement>(
      'input[placeholder="fate_extra_preview_page.search"]',
    );

    await act(async () => {
      if (search_input !== null) {
        const value_setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        value_setter?.call(search_input, "新搜索");
        search_input.dispatchEvent(new Event("input", { bubbles: true }));
        search_input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });

    expect(first_options?.signal?.aborted).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    });
    const latest_call = api_fetch_mock.mock.calls
      .filter(([path]) => path === "/api/toolbox/fate-extra/items")
      .at(-1);
    expect(latest_call?.[1]).toMatchObject({ search: "新搜索" });
    const latest_signal = (latest_call?.[2] as { signal?: AbortSignal } | undefined)?.signal;
    expect(latest_signal).not.toBe(first_options?.signal);
    expect(latest_signal?.aborted).toBe(false);
  });

  it("工程切换后立即隐藏旧条目且快捷保存不能写入新工程", async () => {
    await render_page();
    const translation = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="fate_extra_preview_page.proofread_translation"]',
    );
    await act(async () => {
      if (translation !== null) {
        const value_setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        value_setter?.call(translation, "旧工程未保存译文");
        translation.dispatchEvent(new Event("input", { bubbles: true }));
        translation.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("proofreading_page.action.save"),
      )?.disabled,
    ).toBe(false);

    api_fetch_mock.mockClear();
    api_fetch_mock.mockImplementation((path: string) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return new Promise(() => undefined);
      }
      return Promise.resolve({ accepted: true });
    });
    desktop_state_fixture.current.project_snapshot = {
      loaded: true,
      path: "D:\\next-project.lg",
    };

    await act(async () => {
      root.render(<FateExtraPreviewPage is_sidebar_collapsed={false} />);
      await Promise.resolve();
    });

    expect(
      container.querySelector('textarea[aria-label="fate_extra_preview_page.source"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        'textarea[aria-label="fate_extra_preview_page.proofread_translation"]',
      ),
    ).toBeNull();
    expect(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("proofreading_page.action.save"),
      ),
    ).toBeUndefined();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });

    expect(
      api_fetch_mock.mock.calls.some(([path]) => path === "/api/toolbox/fate-extra/review/save"),
    ).toBe(false);
    expect(api_fetch_mock).toHaveBeenCalledWith(
      "/api/toolbox/fate-extra/items",
      expect.objectContaining({ project_path: "D:\\next-project.lg" }),
      { signal: expect.anything() },
    );
  });

  it("当前查询进入 updating 时清空上一查询的条目与总数", async () => {
    await render_page();
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
          query_id: body?.["query_id"],
          search_state: "updating",
          index_ready: false,
          total: 0,
          items: [],
        });
      }
      if (path === "/api/toolbox/fate-extra/index/rebuild") {
        return Promise.resolve({
          job_id: "failed-index-job",
          status: "failed",
          error: { message: "index unavailable" },
        });
      }
      return Promise.resolve({ accepted: true });
    });
    const search_input = container.querySelector<HTMLInputElement>(
      'input[placeholder="fate_extra_preview_page.search"]',
    );

    await act(async () => {
      if (search_input !== null) {
        const value_setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        value_setter?.call(search_input, "等待索引");
        search_input.dispatchEvent(new Event("input", { bubbles: true }));
        search_input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(
      container.querySelector('textarea[aria-label="fate_extra_preview_page.source"]'),
    ).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('textarea[aria-label="fate_extra_preview_page.source"]'),
    ).toBeNull();
    const jump_input = container.querySelector<HTMLInputElement>(
      'input[aria-label="fate_extra_preview_page.jump_to"]',
    );
    expect(jump_input?.max).toBe("0");
    expect(jump_input?.disabled).toBe(true);
  });

  it("忽略 query_id 不匹配的迟到预览响应", async () => {
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
          query_id: Number(body?.["query_id"] ?? 0) + 1,
          total: 1,
          items: [ITEM],
        });
      }
      return Promise.resolve({ accepted: true });
    });

    await render_page();

    expect(
      container.querySelector('textarea[aria-label="fate_extra_preview_page.source"]'),
    ).toBeNull();
  });

  it.each(["unique", "occurrence"])(
    "%s 视图索引未就绪时轮询后台任务并在成功后重载",
    async (view) => {
      let index_completed = false;
      api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
        if (path === "/api/toolbox/fate-extra/items") {
          return Promise.resolve(
            index_completed
              ? {
                  sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
                  query_id: body?.["query_id"],
                  search_state: "ready",
                  index_ready: true,
                  index_generation: 2,
                  applied_items_revision: 4,
                  total: 1,
                  items: [ITEM],
                }
              : {
                  sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
                  query_id: body?.["query_id"],
                  search_state: "unavailable",
                  index_ready: false,
                  index_generation: 1,
                  applied_items_revision: 3,
                },
          );
        }
        if (path === "/api/toolbox/fate-extra/index/rebuild") {
          return Promise.resolve({ job_id: "index-job", status: "queued" });
        }
        if (path === "/api/toolbox/fate-extra/jobs/status") {
          index_completed = true;
          return Promise.resolve({
            job_id: "index-job",
            status: "succeeded",
            result: { ready: true, search_ready: true, search_generation: 2 },
          });
        }
        return Promise.resolve({ accepted: true });
      });

      if (view === "occurrence") {
        api_fetch_mock.mockImplementationOnce((_path: string, body?: Record<string, unknown>) =>
          Promise.resolve({
            sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
            query_id: body?.["query_id"],
            index_ready: true,
            search_state: "ready",
            total: 1,
            items: [ITEM],
          }),
        );
        await render_page();
        await act(async () => {
          const selector = container.querySelector<HTMLSelectElement>(
            ".fate-extra-preview__filters select",
          )!;
          selector.value = "occurrence";
          selector.dispatchEvent(new Event("change", { bubbles: true }));
        });
      } else await render_page();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(api_fetch_mock).toHaveBeenCalledWith(
        "/api/toolbox/fate-extra/index/rebuild",
        { project_path: "D:\\project.lg" },
        { signal: expect.anything() },
      );

      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(api_fetch_mock).toHaveBeenCalledWith(
        "/api/toolbox/fate-extra/jobs/status",
        { job_id: "index-job" },
        { signal: expect.anything() },
      );

      await act(async () => {
        vi.advanceTimersByTime(150);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="fate_extra_preview_page.source"]',
        )?.value,
      ).toBe("原文");
    },
  );

  it("显示索引进度并支持取消后重试", async () => {
    let rebuild_count = 0;
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
          query_id: body?.["query_id"],
          search_state: "updating",
          index_ready: false,
          total: 0,
          items: [],
        });
      }
      if (path === "/api/toolbox/fate-extra/index/rebuild") {
        rebuild_count += 1;
        return Promise.resolve({
          job_id: `index-job-${rebuild_count.toString()}`,
          status: "running",
          phase: "search-documents",
          completed: 20,
          total: 100,
          cancellable: true,
        });
      }
      if (path === "/api/toolbox/fate-extra/jobs/cancel") {
        return Promise.resolve({
          job_id: body?.["job_id"],
          status: "cancelling",
          phase: "cancelling",
          completed: 20,
          total: 100,
          cancellable: true,
        });
      }
      if (path === "/api/toolbox/fate-extra/jobs/status") {
        return Promise.resolve({
          job_id: body?.["job_id"],
          status: "cancelled",
          phase: "cancelled",
          completed: 20,
          total: 100,
          cancellable: false,
        });
      }
      return Promise.resolve({ accepted: true });
    });

    await render_page();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("fate_extra_preview_page.index_phase.search-documents");
    expect(container.querySelector("progress")?.value).toBe(20);
    expect(container.querySelector("progress")?.max).toBe(100);
    const cancel_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.index_cancel"),
    );
    await act(async () => {
      cancel_button?.click();
      await Promise.resolve();
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/toolbox/fate-extra/jobs/cancel", {
      job_id: "index-job-1",
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const retry_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.index_retry"),
    );
    expect(retry_button).toBeDefined();
    expect(container.querySelector(".fate-extra-preview__error")).toBeNull();
    await act(async () => {
      retry_button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rebuild_count).toBe(2);
  });

  it.each([
    ["启动请求失败", "start"],
    ["轮询请求失败", "poll"],
    ["启动响应缺少 job_id", "missing-job-id"],
  ] as const)("%s 时进入可重试状态", async (_label, failure_mode) => {
    let rebuild_count = 0;
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
          query_id: body?.["query_id"],
          search_state: "updating",
          index_ready: false,
          total: 0,
          items: [],
        });
      }
      if (path === "/api/toolbox/fate-extra/index/rebuild") {
        rebuild_count += 1;
        if (rebuild_count === 1 && failure_mode === "start") {
          return Promise.reject(new Error("index start unavailable"));
        }
        if (rebuild_count === 1 && failure_mode === "missing-job-id") {
          return Promise.resolve({ status: "running" });
        }
        return Promise.resolve(
          rebuild_count === 1
            ? { job_id: "index-job", status: "running" }
            : {
                job_id: "index-retry-job",
                status: "failed",
                error: { message: "retry stopped for test" },
              },
        );
      }
      if (path === "/api/toolbox/fate-extra/jobs/status") {
        return failure_mode === "poll"
          ? Promise.reject(new Error("index status unavailable"))
          : Promise.resolve({ job_id: body?.["job_id"], status: "failed" });
      }
      return Promise.resolve({ accepted: true });
    });

    await render_page();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    if (failure_mode === "poll") {
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    const retry_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.index_retry"),
    );
    expect(retry_button).toBeDefined();
    expect(container.querySelector(".fate-extra-preview__error")?.textContent).not.toBe("");
    await act(async () => {
      retry_button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rebuild_count).toBe(2);
  });

  it("支持输入条目序号并按回车跳转到对应批次", async () => {
    await render_page();
    const jump_input = container.querySelector<HTMLInputElement>(
      'input[aria-label="fate_extra_preview_page.jump_to"]',
    );
    expect(jump_input?.value).toBe("1");

    await act(async () => {
      if (jump_input !== null) {
        const value_setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        value_setter?.call(jump_input, "501");
        jump_input.dispatchEvent(new Event("input", { bubbles: true }));
        jump_input.dispatchEvent(new Event("change", { bubbles: true }));
        jump_input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      }
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api_fetch_mock).toHaveBeenLastCalledWith(
      "/api/toolbox/fate-extra/items",
      {
        project_path: "D:\\project.lg",
        search: "",
        file_path: "",
        warning: "",
        category: "",
        view_mode: "unique",
        position: 480,
        limit: 120,
        query_id: expect.any(Number),
      },
      { signal: expect.anything() },
    );
    // The test API returns one row for every page, so selection is clamped to
    // the first available row of the requested 480-offset page.
    expect(jump_input?.value).toBe("481");
  });

  it("refreshes the machine draft after a project translation commit", async () => {
    await render_page();

    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
          query_id: body?.["query_id"],
          total: 501,
          items: [
            {
              ...ITEM,
              dst: "updated-machine-translation",
              machine_translation: "updated-machine-translation",
              effective_translation: "updated-machine-translation",
            },
          ],
          files: ["route.txt"],
        });
      }
      return Promise.resolve({ accepted: true, changes: [] });
    });
    desktop_state_fixture.current.project_change_signal = { seq: 1 };

    await act(async () => {
      root.render(<FateExtraPreviewPage is_sidebar_collapsed={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="fate_extra_preview_page.machine_translation"]',
      )?.value,
    ).toBe("updated-machine-translation");
  });

  it("auto-saves display mode without leaving navigation locked", async () => {
    await render_page();
    const display_mode_select = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "fullscreen"),
    );
    expect(display_mode_select).toBeDefined();

    await act(async () => {
      if (display_mode_select !== undefined) {
        const value_setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "value",
        )?.set;
        value_setter?.call(display_mode_select, "fullscreen");
        display_mode_select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/toolbox/fate-extra/review/save", {
      item_id: 7,
      occurrence_id: 101,
      text_unit_id: 3,
      review_scope: "unit",
      proofread_translation: "",
      display_mode: "fullscreen",
      project_path: "D:\\project.lg",
      expected_section_revisions: { items: 4, proofreading: 5 },
    });
    const next_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.next"),
    );
    expect(next_button?.disabled).toBe(false);
  });

  it("只乐观更新共享代表 item 的目标 occurrence 显示类型", async () => {
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
          query_id: body?.["query_id"],
          total: 2,
          items: [
            ITEM,
            {
              ...ITEM,
              occurrence_id: 202,
              file_path: "route-2.txt",
              row_number: 4,
              display_mode: "dialogue",
            },
          ],
          files: ["route.txt", "route-2.txt"],
        });
      }
      if (path === "/api/session/project/manifest") {
        return Promise.resolve({
          sectionRevisions: { items: 4, proofreading: 5, quality: 6, prompts: 7 },
        });
      }
      return Promise.resolve({ accepted: true, changes: [] });
    });
    await render_page();
    const display_mode_select = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "fullscreen"),
    );

    await act(async () => {
      const value_setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set;
      if (display_mode_select !== undefined) {
        value_setter?.call(display_mode_select, "fullscreen");
        display_mode_select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const next_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.next"),
    );
    await act(async () => {
      next_button?.click();
      await Promise.resolve();
    });
    expect(display_mode_select?.value).toBe("dialogue");
    expect(api_fetch_mock).toHaveBeenCalledWith(
      "/api/toolbox/fate-extra/review/save",
      expect.objectContaining({ item_id: 7, occurrence_id: 101, display_mode: "fullscreen" }),
    );
  });

  it("shows two master-order neighbours on each side of the current entry", async () => {
    await render_page();
    const context_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.view_context"),
    );
    await act(async () => {
      context_button?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/toolbox/fate-extra/context", {
      project_path: "D:\\project.lg",
      resource_path: "field/001.dat",
      char_offset: 1234,
      radius: 2,
    });
    expect(container.textContent).toContain("source-0");
    expect(container.textContent).toContain("source-4");
    expect(container.textContent).toContain("proof-current");
  });
});
