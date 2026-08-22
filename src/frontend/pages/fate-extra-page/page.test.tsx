import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api_fetch_mock, desktop_state_fixture, translate } = vi.hoisted(() => ({
  api_fetch_mock: vi.fn(),
  translate: (key: string) => key,
  desktop_state_fixture: {
    current: {
      project_snapshot: { loaded: true, path: "D:\\project.lg" },
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

import { FateExtraPage } from "@frontend/pages/fate-extra-page/page";

type JobStatus = "queued" | "running" | "cancelling" | "succeeded" | "cancelled" | "failed";

function job_snapshot(args: {
  job_id: string;
  kind: "scan" | "scan-apply";
  status: JobStatus;
  result?: Record<string, unknown>;
  retryable?: boolean;
}) {
  return {
    job_id: args.job_id,
    kind: args.kind,
    status: args.status,
    phase: args.status,
    completed: args.status === "succeeded" ? 1 : 0,
    total: 1,
    project_epoch: 1,
    source_revision: 1,
    cancellable: ["queued", "running", "cancelling"].includes(args.status),
    ...(args.result === undefined ? {} : { result: args.result }),
    ...(args.status !== "failed"
      ? {}
      : {
          error: {
            message: "apply failed",
            details: { scan_draft_retryable: args.retryable === true },
          },
        }),
  };
}

describe("FateExtraPage 后台任务", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    desktop_state_fixture.current.project_snapshot = {
      loaded: true,
      path: "D:\\project.lg",
    };
    api_fetch_mock.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render_page(): Promise<void> {
    await act(async () => {
      root.render(<FateExtraPage is_sidebar_collapsed={false} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function advance_job_poll(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function find_button(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (button === undefined) throw new Error(`button not found: ${label}`);
    return button;
  }

  function install_job_api(
    apply_terminal: "cancelled" | "failed",
    retryable = false,
  ): {
    read_scan_calls: () => number;
    read_apply_calls: () => number;
  } {
    let scan_calls = 0;
    let apply_calls = 0;
    api_fetch_mock.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === "/api/toolbox/fate-extra/status") {
        return Promise.resolve({ enabled: false, compact_enabled: false });
      }
      if (path === "/api/toolbox/fate-extra/scan") {
        scan_calls += 1;
        return Promise.resolve(
          job_snapshot({ job_id: `scan-${scan_calls.toString()}`, kind: "scan", status: "queued" }),
        );
      }
      if (path === "/api/session/project/manifest") {
        return Promise.resolve({
          sectionRevisions: { files: 1, items: 1, analysis: 1, proofreading: 1 },
        });
      }
      if (path === "/api/toolbox/fate-extra/apply") {
        apply_calls += 1;
        return Promise.resolve(
          job_snapshot({
            job_id: `apply-${apply_calls.toString()}`,
            kind: "scan-apply",
            status: "queued",
          }),
        );
      }
      if (path === "/api/toolbox/fate-extra/jobs/cancel") {
        return Promise.resolve(
          job_snapshot({
            job_id: String(body?.["job_id"] ?? ""),
            kind: "scan-apply",
            status: "cancelling",
          }),
        );
      }
      if (path === "/api/toolbox/fate-extra/jobs/status") {
        const job_id = String(body?.["job_id"] ?? "");
        if (job_id.startsWith("scan-")) {
          return Promise.resolve(
            job_snapshot({
              job_id,
              kind: "scan",
              status: "succeeded",
              result: { scan_id: "ready-scan", applicable: true, source_file_count: 6 },
            }),
          );
        }
        return Promise.resolve(
          job_snapshot({
            job_id,
            kind: "scan-apply",
            status: apply_terminal,
            retryable,
          }),
        );
      }
      return Promise.resolve({});
    });
    return {
      read_scan_calls: () => scan_calls,
      read_apply_calls: () => apply_calls,
    };
  }

  async function finish_initial_scan(): Promise<void> {
    await act(async () => {
      find_button("fate_extra_page.scan").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await advance_job_poll();
    expect(container.textContent).toContain("fate_extra_page.report");
  }

  it("启动新扫描时立即清除已失效的旧报告", async () => {
    install_job_api("cancelled");
    await render_page();
    await finish_initial_scan();

    await act(async () => {
      find_button("fate_extra_page.scan").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("fate_extra_page.report");
  });

  it("取消 apply 后清除 scan_id，下一次应用先重新扫描", async () => {
    const calls = install_job_api("cancelled");
    await render_page();
    await finish_initial_scan();
    await act(async () => {
      find_button("fate_extra_page.apply").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      find_button("fate_extra_page.job_cancel").click();
      await Promise.resolve();
    });
    await advance_job_poll();

    expect(container.textContent).not.toContain("fate_extra_page.report");
    await act(async () => {
      find_button("fate_extra_page.apply").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls.read_apply_calls()).toBe(1);
    expect(calls.read_scan_calls()).toBe(2);
  });

  it.each([
    [true, 2, 1],
    [false, 1, 2],
  ] as const)(
    "apply 失败仅在后端明确 retryable=%s 时复用 scan_id",
    async (retryable, expected_apply_calls, expected_scan_calls) => {
      const calls = install_job_api("failed", retryable);
      await render_page();
      await finish_initial_scan();
      await act(async () => {
        find_button("fate_extra_page.apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      await advance_job_poll();

      await act(async () => {
        find_button("fate_extra_page.apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls.read_apply_calls()).toBe(expected_apply_calls);
      expect(calls.read_scan_calls()).toBe(expected_scan_calls);
    },
  );
});
