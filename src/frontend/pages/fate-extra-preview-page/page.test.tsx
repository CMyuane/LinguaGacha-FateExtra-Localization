import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api_fetch_mock, desktop_state_fixture } = vi.hoisted(() => ({
  api_fetch_mock: vi.fn(),
  desktop_state_fixture: {
    current: {
      project_snapshot: { loaded: true, path: "D:\\project.lg" },
      project_change_signal: { seq: 0 },
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
  useI18n: () => ({ t: (key: string) => key }),
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
    desktop_state_fixture.current.project_change_signal = { seq: 0 };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api_fetch_mock.mockReset();
    desktop_state_fixture.current.commit_project_write.mockReset();
    desktop_state_fixture.current.refresh_task.mockReset();
    desktop_state_fixture.current.commit_project_write.mockImplementation(
      async (request: { run: () => Promise<unknown> }) => {
        const payload = await request.run();
        return { payload, write_result: { accepted: true, changes: [] } };
      },
    );
    api_fetch_mock.mockImplementation((path: string) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({ total: 501, items: [ITEM], files: ["route.txt"] });
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
      text_unit_id: 3,
      review_scope: "unit",
      proofread_translation: "新译文\n第二行",
      display_mode: "auto",
      expected_section_revisions: { items: 4, proofreading: 5 },
    });
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
      text_unit_id: 3,
      review_scope: "unit",
      proofread_translation: "",
      display_mode: "auto",
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

    expect(api_fetch_mock).toHaveBeenLastCalledWith("/api/toolbox/fate-extra/items", {
      project_path: "D:\\project.lg",
      search: "",
      file_path: "",
      warning: "",
      category: "",
      view_mode: "unique",
      offset: 120,
      limit: 120,
    });
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

    expect(api_fetch_mock).toHaveBeenLastCalledWith("/api/toolbox/fate-extra/items", {
      project_path: "D:\\project.lg",
      search: "",
      file_path: "",
      warning: "",
      category: "",
      view_mode: "unique",
      offset: 480,
      limit: 120,
    });
    // The test API returns one row for every page, so selection is clamped to
    // the first available row of the requested 480-offset page.
    expect(jump_input?.value).toBe("481");
  });

  it("refreshes the machine draft after a project translation commit", async () => {
    await render_page();

    api_fetch_mock.mockImplementation((path: string) => {
      if (path === "/api/toolbox/fate-extra/items") {
        return Promise.resolve({
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
      text_unit_id: 3,
      review_scope: "unit",
      proofread_translation: "",
      display_mode: "fullscreen",
      expected_section_revisions: { items: 4, proofreading: 5 },
    });
    const next_button = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("fate_extra_preview_page.next"),
    );
    expect(next_button?.disabled).toBe(false);
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
