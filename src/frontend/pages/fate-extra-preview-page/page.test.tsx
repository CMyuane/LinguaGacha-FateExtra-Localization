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

import { FateExtraPreviewPage } from "@frontend/pages/fate-extra-preview-page/page";

const ITEM = {
  item_id: 7,
  file_path: "route.txt",
  row_number: 3,
  src: "原文",
  dst: "旧译文",
  status: "NONE",
  warnings: ["FE_STORAGE_CAPACITY"],
  index: { path: "field/001.dat", char_offset: 1234 },
  capacity: {
    category: "ordinary_independent_slot",
    category_zh: "普通独立槽位",
    encoded_bytes: 84,
    slot_capacity: 82,
    remaining_bytes: -2,
    exceeded_bytes: 2,
    over_capacity: true,
    capacity_violation: true,
    allow_overlength: false,
    allow_relocation: false,
    translator_message: "需要缩短",
    address_limit: null,
  },
};

describe("FateExtraPreviewPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
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

  it("上下显示原文译文，编辑后通过校对写接口保存", async () => {
    await render_page();
    const translation = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="fate_extra_preview_page.translation"]',
    );
    expect(translation?.value).toBe("旧译文");

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

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/proofreading/item/save", {
      item_id: 7,
      dst: "新译文\n第二行",
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
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/proofreading/translations/clear", {
      item_ids: [7],
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
      offset: 500,
      limit: 500,
    });
  });
});
