import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { register_post_json_route, type ApiJsonRequestContext } from "./api-json";

describe("register_post_json_route", () => {
  it("把 request id 与客户端 AbortSignal 传给 JSON handler", async () => {
    const app = new Hono();
    const controller = new AbortController();
    const request_contexts: ApiJsonRequestContext[] = [];
    register_post_json_route(
      app,
      "/preview",
      (body, request) => {
        request_contexts.push(request);
        return { query_id: body["query_id"] ?? null };
      },
      () => new Response(null, { status: 500 }),
    );

    const response = await app.fetch(
      new Request("http://localhost/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query_id: 7 }),
        signal: controller.signal,
      }),
    );

    expect(await response.json()).toEqual({ ok: true, data: { query_id: 7 } });
    const request_context = request_contexts[0];
    expect(request_context?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(request_context?.signal.aborted).toBe(false);
    controller.abort();
    expect(request_context?.signal.aborted).toBe(true);
  });

  it("客户端取消时返回 499 且不记录为服务端故障", async () => {
    const app = new Hono();
    const controller = new AbortController();
    const on_error = vi.fn(() => new Response(null, { status: 500 }));
    let mark_handler_started!: () => void;
    const handler_started = new Promise<void>((resolve) => {
      mark_handler_started = resolve;
    });
    register_post_json_route(
      app,
      "/preview",
      (_body, request) =>
        new Promise<never>((_resolve, reject) => {
          mark_handler_started();
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      on_error,
    );

    const response_promise = app.fetch(
      new Request("http://localhost/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      }),
    );
    await handler_started;
    controller.abort();

    const response = await response_promise;
    expect(response.status).toBe(499);
    expect(on_error).not.toHaveBeenCalled();
  });
});
