import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProofreadingStatusCell,
  ProofreadingTable,
} from "@frontend/pages/proofreading-page/components/proofreading-table";
import type {
  ProofreadingItem,
  ProofreadingManualStatusCode,
  ProofreadingVisibleItem,
} from "@shared/proofreading/proofreading-types";
import {
  PROOFREADING_MANUAL_STATUS_CODES,
  PROOFREADING_STATUS_LABEL_KEY_BY_CODE,
} from "@shared/proofreading/proofreading-types";
import { TooltipProvider } from "@frontend/shadcn/tooltip";
import type {
  AppTableCellPayload,
  AppTableDragCellPayload,
  AppTableProps,
  AppTableScrollAnchor,
} from "@frontend/widgets/app-table/app-table-types";

// 只声明本测试需要观察的 AppTable 公开载荷。
type CapturedAppTableProps = AppTableProps<ProofreadingVisibleItem>;

// app_table_fixture 保存最近一次 AppTable props，避免测试读取真实表格 DOM 细节。
const { app_table_fixture } = vi.hoisted(() => {
  return {
    app_table_fixture: {
      current_props: null as CapturedAppTableProps | null,
    },
  };
});

vi.mock("@frontend/app/locale/locale-provider", () => {
  return {
    useI18n: () => {
      return {
        t: (key: string) => key,
      };
    },
  };
});

vi.mock("@frontend/widgets/app-table/app-table", async () => {
  const context_menu = await vi.importActual<typeof import("@frontend/widgets/app-context-menu")>(
    "@frontend/widgets/app-context-menu",
  );
  return {
    AppTable: (props: CapturedAppTableProps) => {
      app_table_fixture.current_props = props;
      return (
        <div data-testid="app-table">
          {props.rows.map((row, row_index) => {
            const row_id = props.get_row_id(row, row_index);
            const row_body = (
              <div key={row_id} data-testid={`app-table-row-${row_id}`}>
                {props.columns.map((column) => {
                  const base_payload: AppTableCellPayload<ProofreadingVisibleItem> = {
                    row,
                    row_id,
                    row_index,
                    active: false,
                    selected: false,
                    dragging: false,
                    can_drag: false,
                    presentation: "body",
                  };
                  const cell_content =
                    column.kind === "drag"
                      ? column.render_cell({
                          ...base_payload,
                          drag_handle: null,
                        } satisfies AppTableDragCellPayload<ProofreadingVisibleItem>)
                      : column.render_cell(base_payload);
                  return (
                    <div key={column.id} data-testid={`app-table-cell-${column.id}`}>
                      {cell_content}
                    </div>
                  );
                })}
              </div>
            );
            if (props.render_row_context_menu === undefined) {
              return row_body;
            }

            return (
              <context_menu.AppContextMenu key={row_id}>
                <context_menu.AppContextMenuTrigger asChild>
                  {row_body}
                </context_menu.AppContextMenuTrigger>
                {props.render_row_context_menu({ row, row_id, row_index })}
              </context_menu.AppContextMenu>
            );
          })}
        </div>
      );
    },
  };
});

// 生成状态单元格和表格行共用的最小校对 item。
function create_item(overrides: Partial<ProofreadingItem> = {}): ProofreadingItem {
  return {
    item_id: 1,
    file_path: "chapter01.txt",
    row_number: 1,
    src: "foo",
    dst: "bar",
    name_src: null,
    name_dst: null,
    status: "PROCESSED",
    retry_count: 0,
    warnings: ["GLOSSARY"],
    warning_fragments_by_code: {},
    applied_glossary_terms: [],
    failed_glossary_terms: [],
    ...overrides,
  };
}

// 构造带 row_id 的校对表格行，便于断言 row_model 公开载荷。
function create_visible_item(
  item_id: number,
  overrides: Partial<ProofreadingItem> = {},
): ProofreadingVisibleItem {
  const item = {
    ...create_item(),
    ...overrides,
    item_id,
    row_id: String(item_id),
    compressed_src: `src-${item_id.toString()}`,
    compressed_dst: `dst-${item_id.toString()}`,
  };
  return {
    row_id: String(item_id),
    item,
    compressed_src: item.compressed_src,
    compressed_dst: item.compressed_dst,
  };
}

describe("ProofreadingStatusCell", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }

    container?.remove();
    container = null;
    root = null;
  });

  async function render_cell(
    retranslating: boolean,
    item: ProofreadingItem = create_item(),
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TooltipProvider>
          <ProofreadingStatusCell item={item} retranslating={retranslating} />
        </TooltipProvider>,
      );
    });

    return container;
  }

  it("重翻中的状态单元格只渲染 Spinner", async () => {
    const rendered = await render_cell(true);

    expect(rendered.querySelector('[role="status"]')).not.toBeNull();
    expect(rendered.querySelectorAll("svg")).toHaveLength(1);
  });

  it("非重翻状态仍按原状态与 warning 图标渲染", async () => {
    const rendered = await render_cell(false);

    expect(rendered.querySelector('[role="status"]')).toBeNull();
    expect(rendered.querySelectorAll("svg")).toHaveLength(2);
  });

  it.each(["RULE_SKIPPED", "DUPLICATED"])("%s 状态渲染中性状态图标", async (status) => {
    const rendered = await render_cell(false, create_item({ status, warnings: [] }));

    expect(rendered.querySelector('[role="status"]')).toBeNull();
    expect(rendered.querySelectorAll("svg")).toHaveLength(1);
    expect(rendered.querySelector(".proofreading-page__status-icon--neutral")).not.toBeNull();
  });
});

describe("ProofreadingTable", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }

    container?.remove();
    container = null;
    root = null;
    app_table_fixture.current_props = null;
  });

  /**
   * 挂载校对表格并记录传给 AppTable 的公开 props。
   */
  async function render_table(anchor: AppTableScrollAnchor): Promise<() => void> {
    const on_visible_range_change = vi.fn<(range: { start: number; count: number }) => void>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TooltipProvider>
          <ProofreadingTable
            items={[create_visible_item(1)]}
            visible_row_count={10}
            sort_state={null}
            selected_row_ids={[]}
            active_row_id={null}
            anchor_row_id={null}
            retranslating_row_ids={[]}
            readonly={false}
            get_row_at_index={() => undefined}
            get_row_id_at_index={() => undefined}
            resolve_row_index={() => undefined}
            resolve_row_index_async={async () => undefined}
            resolve_row_ids_range={async () => []}
            on_visible_range_change={on_visible_range_change}
            restore_scroll_row_id="1"
            preserve_scroll_anchor={anchor}
            on_sort_change={() => {}}
            on_selection_change={() => {}}
            on_selection_error={() => {}}
            on_open_edit={() => {}}
            on_request_retranslate_row_ids={() => {}}
            on_request_clear_translation_row_ids={() => {}}
            on_request_set_translation_status_row_ids={() => {}}
          />
        </TooltipProvider>,
      );
    });

    return () => {
      app_table_fixture.current_props?.row_model?.on_visible_range_change?.({
        start: 2,
        count: 5,
      });
      expect(on_visible_range_change).toHaveBeenCalledWith({
        start: 2,
        count: 5,
      });
    };
  }

  async function render_status_context_menu(args: {
    selected_row_ids: string[];
    readonly?: boolean;
  }) {
    const items = [create_visible_item(1), create_visible_item(2)];
    const on_request_status =
      vi.fn<
        (
          row_ids: string[],
          status: ProofreadingManualStatusCode,
          preferred_row_id?: string | null,
        ) => void
      >();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TooltipProvider>
          <ProofreadingTable
            items={items}
            visible_row_count={items.length}
            sort_state={null}
            selected_row_ids={args.selected_row_ids}
            active_row_id={args.selected_row_ids[0] ?? null}
            anchor_row_id={args.selected_row_ids[0] ?? null}
            retranslating_row_ids={[]}
            readonly={args.readonly ?? false}
            get_row_at_index={(index) => items[index]}
            get_row_id_at_index={(index) => items[index]?.row_id}
            resolve_row_index={(row_id) => items.findIndex((item) => item.row_id === row_id)}
            resolve_row_index_async={async (row_id) =>
              items.findIndex((item) => item.row_id === row_id)
            }
            resolve_row_ids_range={async ({ start, count }) =>
              items.slice(start, start + count).map((item) => item.row_id)
            }
            on_visible_range_change={() => {}}
            restore_scroll_row_id={null}
            preserve_scroll_anchor={{ row_id: null, revision: 0 }}
            on_sort_change={() => {}}
            on_selection_change={() => {}}
            on_selection_error={() => {}}
            on_open_edit={() => {}}
            on_request_retranslate_row_ids={() => {}}
            on_request_clear_translation_row_ids={() => {}}
            on_request_set_translation_status_row_ids={on_request_status}
          />
        </TooltipProvider>,
      );
      await Promise.resolve();
    });

    return { rendered: container, on_request_status };
  }

  function find_context_menu_element(slot: string, text: string): HTMLElement {
    const element = [...document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)].find(
      (candidate) => candidate.textContent === text,
    );
    if (element === undefined) {
      throw new Error(`缺少右键菜单元素：${slot} / ${text}`);
    }
    return element;
  }

  async function open_row_context_menu(rendered: HTMLDivElement, row_id: string): Promise<void> {
    const row = rendered.querySelector<HTMLElement>(`[data-testid="app-table-row-${row_id}"]`);
    if (row === null) {
      throw new Error(`缺少校对表格行：${row_id}`);
    }
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 10,
          clientY: 10,
        }),
      );
      await Promise.resolve();
    });
  }

  async function mouse_click(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
      element.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
      element.click();
      await Promise.resolve();
    });
  }

  async function open_status_submenu_with_mouse(): Promise<void> {
    await mouse_click(
      find_context_menu_element(
        "context-menu-sub-trigger",
        "proofreading_page.action.set_translation_status",
      ),
    );
  }

  async function open_status_submenu_with_keyboard(): Promise<void> {
    const trigger = find_context_menu_element(
      "context-menu-sub-trigger",
      "proofreading_page.action.set_translation_status",
    );
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      await Promise.resolve();
    });
  }

  function find_status_menu_item(status: ProofreadingManualStatusCode): HTMLElement {
    return find_context_menu_element(
      "context-menu-item",
      PROOFREADING_STATUS_LABEL_KEY_BY_CODE[status],
    );
  }

  async function select_status_with_keyboard(status: ProofreadingManualStatusCode): Promise<void> {
    const item = find_status_menu_item(status);
    await act(async () => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });
  }

  async function flush_context_menu_action(): Promise<void> {
    if (vi.isFakeTimers()) {
      await act(async () => {
        vi.runOnlyPendingTimers();
        await Promise.resolve();
      });
      return;
    }
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
    });
  }

  it("向 AppTable 透传滚动恢复锚点和远端窗口模型", async () => {
    const anchor = {
      row_id: "1",
      revision: 3,
    };
    const assert_visible_range_change = await render_table(anchor);

    expect(app_table_fixture.current_props?.preserve_scroll_anchor).toEqual(anchor);
    expect(app_table_fixture.current_props?.restore_scroll_row_id).toBe("1");
    expect(app_table_fixture.current_props?.row_model?.row_count).toBe(10);
    expect(app_table_fixture.current_props?.row_model?.loaded_row_ids).toEqual(["1"]);
    assert_visible_range_change();
  });

  it("有姓名字段时在原文和译文前展示中性姓名胶囊", async () => {
    const anchor = {
      row_id: "1",
      revision: 3,
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TooltipProvider>
          <ProofreadingTable
            items={[
              create_visible_item(1, {
                name_src: ["虎铁", "保留原名"],
                name_dst: "虎铁译",
                src: "原文第一行\n原文第二行",
                dst: "译文第一行\n译文第二行",
              }),
            ]}
            visible_row_count={1}
            sort_state={null}
            selected_row_ids={[]}
            active_row_id={null}
            anchor_row_id={null}
            retranslating_row_ids={[]}
            readonly={false}
            get_row_at_index={() => undefined}
            get_row_id_at_index={() => undefined}
            resolve_row_index={() => undefined}
            resolve_row_index_async={async () => undefined}
            resolve_row_ids_range={async () => []}
            on_visible_range_change={() => {}}
            restore_scroll_row_id="1"
            preserve_scroll_anchor={anchor}
            on_sort_change={() => {}}
            on_selection_change={() => {}}
            on_selection_error={() => {}}
            on_open_edit={() => {}}
            on_request_retranslate_row_ids={() => {}}
            on_request_clear_translation_row_ids={() => {}}
            on_request_set_translation_status_row_ids={() => {}}
          />
        </TooltipProvider>,
      );
    });

    const source_cell = container.querySelector('[data-testid="app-table-cell-src"]');
    const translation_cell = container.querySelector('[data-testid="app-table-cell-dst"]');
    const source_badge = source_cell?.querySelector(".proofreading-page__table-name-badge");
    const translation_badge = translation_cell?.querySelector(
      ".proofreading-page__table-name-badge",
    );

    expect(source_badge?.getAttribute("data-variant")).toBe("secondary");
    expect(
      source_badge?.querySelector(".proofreading-page__table-name-badge-label"),
    ).not.toBeNull();
    expect(source_badge?.textContent).toBe("虎铁");
    expect(source_cell?.querySelector(".proofreading-page__table-text")?.textContent).toBe(
      "原文第一行\n原文第二行",
    );
    expect(translation_badge?.getAttribute("data-variant")).toBe("secondary");
    expect(translation_badge?.textContent).toBe("虎铁译");
    expect(translation_cell?.querySelector(".proofreading-page__table-text")?.textContent).toBe(
      "译文第一行\n译文第二行",
    );
    expect(app_table_fixture.current_props?.dynamic_row_height).toBe(true);
  });

  it("姓名数组首项为空时不展示后续槽位姓名", async () => {
    const anchor = {
      row_id: "1",
      revision: 3,
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TooltipProvider>
          <ProofreadingTable
            items={[
              create_visible_item(1, {
                name_src: ["", "Bob"],
                name_dst: ["", "鲍勃"],
              }),
            ]}
            visible_row_count={1}
            sort_state={null}
            selected_row_ids={[]}
            active_row_id={null}
            anchor_row_id={null}
            retranslating_row_ids={[]}
            readonly={false}
            get_row_at_index={() => undefined}
            get_row_id_at_index={() => undefined}
            resolve_row_index={() => undefined}
            resolve_row_index_async={async () => undefined}
            resolve_row_ids_range={async () => []}
            on_visible_range_change={() => {}}
            restore_scroll_row_id="1"
            preserve_scroll_anchor={anchor}
            on_sort_change={() => {}}
            on_selection_change={() => {}}
            on_selection_error={() => {}}
            on_open_edit={() => {}}
            on_request_retranslate_row_ids={() => {}}
            on_request_clear_translation_row_ids={() => {}}
            on_request_set_translation_status_row_ids={() => {}}
          />
        </TooltipProvider>,
      );
    });

    const source_cell = container.querySelector('[data-testid="app-table-cell-src"]');
    const translation_cell = container.querySelector('[data-testid="app-table-cell-dst"]');

    expect(source_cell?.querySelector(".proofreading-page__table-name-badge")).toBeNull();
    expect(translation_cell?.querySelector(".proofreading-page__table-name-badge")).toBeNull();
  });

  it.each(PROOFREADING_MANUAL_STATUS_CODES)(
    "鼠标从单选行右键菜单设置 %s 时会在菜单关闭后提交冻结参数",
    async (status) => {
      const { rendered, on_request_status } = await render_status_context_menu({
        selected_row_ids: [],
      });
      await open_row_context_menu(rendered, "1");
      await open_status_submenu_with_mouse();

      vi.useFakeTimers();
      await mouse_click(find_status_menu_item(status));

      expect(on_request_status).not.toHaveBeenCalled();
      await flush_context_menu_action();
      expect(on_request_status).toHaveBeenCalledTimes(1);
      expect(on_request_status).toHaveBeenCalledWith(["1"], status, "1");
    },
  );

  it.each(PROOFREADING_MANUAL_STATUS_CODES)(
    "键盘从多选行右键菜单设置 %s 时会保留选择时的目标集合",
    async (status) => {
      const selected_row_ids = ["1", "2"];
      const { rendered, on_request_status } = await render_status_context_menu({
        selected_row_ids,
      });
      await open_row_context_menu(rendered, "1");
      await open_status_submenu_with_keyboard();

      vi.useFakeTimers();
      await select_status_with_keyboard(status);
      selected_row_ids.splice(0, selected_row_ids.length, "2");

      expect(on_request_status).not.toHaveBeenCalled();
      await flush_context_menu_action();
      expect(on_request_status).toHaveBeenCalledTimes(1);
      expect(on_request_status).toHaveBeenCalledWith(["1", "2"], status, "1");
    },
  );

  it("只读表格会同时阻止鼠标和键盘打开翻译状态子菜单", async () => {
    const { rendered, on_request_status } = await render_status_context_menu({
      selected_row_ids: ["1"],
      readonly: true,
    });
    await open_row_context_menu(rendered, "1");
    const trigger = find_context_menu_element(
      "context-menu-sub-trigger",
      "proofreading_page.action.set_translation_status",
    );

    expect(trigger.hasAttribute("data-disabled")).toBe(true);
    await mouse_click(trigger);
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      await Promise.resolve();
    });
    await flush_context_menu_action();

    PROOFREADING_MANUAL_STATUS_CODES.forEach((status) => {
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].some(
          (candidate) => candidate.textContent === PROOFREADING_STATUS_LABEL_KEY_BY_CODE[status],
        ),
      ).toBe(false);
    });
    expect(on_request_status).not.toHaveBeenCalled();
  });
});
