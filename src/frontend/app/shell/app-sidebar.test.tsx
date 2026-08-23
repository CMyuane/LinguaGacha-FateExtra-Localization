import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppLanguage } from "@domain/app-language";
import { LocaleProvider } from "@frontend/app/locale/locale-provider";
import { BOTTOM_ACTIONS, NAVIGATION_GROUPS } from "@frontend/app/navigation/schema";
import type { NavigationGroup, RouteId } from "@frontend/app/navigation/types";
import { SidebarProvider } from "@frontend/shadcn/sidebar";
import { TooltipProvider } from "@frontend/shadcn/tooltip";
import { AppSidebar } from "./app-sidebar";

type RenderSidebarOptions = {
  app_language?: AppLanguage;
  is_language_updating?: boolean;
  on_select_app_language?: (language: AppLanguage) => void;
  groups?: NavigationGroup[];
  expanded_items?: ReadonlySet<RouteId>;
  on_select_route?: (route_id: RouteId) => void;
  on_toggle_group?: (route_id: RouteId) => void;
};

describe("AppSidebar", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }

    container?.remove();
    root = null;
    container = null;
  });

  async function render_sidebar(options: RenderSidebarOptions = {}): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <LocaleProvider locale="zh-CN">
          <TooltipProvider>
            <SidebarProvider open>
              <AppSidebar
                groups={options.groups ?? []}
                bottom_actions={BOTTOM_ACTIONS}
                selected_route="project-home"
                expanded_items={options.expanded_items ?? new Set()}
                disabled_route_ids={new Set()}
                disabled_bottom_action_ids={
                  options.is_language_updating ? new Set(["language"]) : new Set()
                }
                badged_bottom_action_ids={new Set()}
                app_language={options.app_language ?? "ZH"}
                profile_label_key="app.profile.status"
                profile_tooltip_key="app.profile.status_tooltip"
                is_profile_update_available={false}
                on_select_route={options.on_select_route ?? vi.fn()}
                on_toggle_group={options.on_toggle_group ?? vi.fn()}
                on_bottom_action={vi.fn()}
                on_appearance_menu_action={vi.fn()}
                on_select_app_language={options.on_select_app_language ?? vi.fn()}
                on_profile_action={vi.fn()}
              />
            </SidebarProvider>
          </TooltipProvider>
        </LocaleProvider>,
      );
    });
  }

  async function open_language_menu(): Promise<void> {
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="字字珠玑"]');
    if (trigger === null) {
      throw new Error("缺少界面语言菜单按钮。");
    }

    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
  }

  it("打开语言菜单时列出本地语言名称并标记当前语言", async () => {
    await render_sidebar({ app_language: "EN" });
    await open_language_menu();

    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));

    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "中文",
      "English",
      "Deutsch",
    ]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("选择语言后提交明确的应用语言", async () => {
    const selected_languages: AppLanguage[] = [];
    await render_sidebar({
      on_select_app_language: (language) => {
        selected_languages.push(language);
      },
    });
    await open_language_menu();

    const german_option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((option) => option.textContent?.trim() === "Deutsch");
    if (german_option === undefined) {
      throw new Error("缺少德文界面语言选项。");
    }

    await act(async () => {
      german_option.click();
    });

    expect(selected_languages).toEqual(["DE"]);
  });

  it("语言设置更新期间禁用菜单按钮", async () => {
    await render_sidebar({ is_language_updating: true });

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="字字珠玑"]');
    expect(trigger?.disabled).toBe(true);
  });

  it("五个导航区域只渲染四条分隔线", async () => {
    await render_sidebar({ groups: NAVIGATION_GROUPS });

    expect(document.querySelectorAll(".sidebar-group-wrapper")).toHaveLength(5);
    expect(document.querySelectorAll(".sidebar-group-separator")).toHaveLength(4);
  });

  it("二级入口按 expanded_items 展开并把父项点击回流给导航状态", async () => {
    const selected: RouteId[] = [];
    const toggled: RouteId[] = [];
    await render_sidebar({
      groups: NAVIGATION_GROUPS,
      expanded_items: new Set<RouteId>(["text-replacement"]),
      on_select_route: (route_id) => selected.push(route_id),
      on_toggle_group: (route_id) => toggled.push(route_id),
    });

    const parent = document.querySelector<HTMLButtonElement>('button[aria-label="文本替换"]');
    if (parent === null) throw new Error("缺少文本替换父菜单。");
    const shell = parent.closest(".sidebar-entry")?.querySelector(".sidebar-subitems-shell");
    const child = document.querySelector<HTMLButtonElement>('button[aria-label="译前替换"]');
    expect(shell?.getAttribute("aria-hidden")).toBe("false");
    expect(child?.tabIndex).toBe(0);

    await act(async () => parent.click());
    expect(toggled).toEqual(["text-replacement"]);
    expect(selected).toEqual(["text-replacement"]);
  });

  it("未展开的二级入口不可进入键盘焦点", async () => {
    await render_sidebar({ groups: NAVIGATION_GROUPS });

    const parent = document.querySelector<HTMLButtonElement>('button[aria-label="文本替换"]');
    const shell = parent?.closest(".sidebar-entry")?.querySelector(".sidebar-subitems-shell");
    const child = document.querySelector<HTMLButtonElement>('button[aria-label="译前替换"]');
    expect(shell?.getAttribute("aria-hidden")).toBe("true");
    expect(child?.tabIndex).toBe(-1);
  });
});
