import crypto from "node:crypto";

import type { Hono } from "hono";

import { InvalidJsonError } from "../../shared/error";
import { ok, type ApiJsonValue } from "./api-types";

export type ApiJsonRequestContext = {
  requestId: string;
  signal: AbortSignal;
};

export type ApiJsonHandler = (
  body: Record<string, ApiJsonValue>,
  request: ApiJsonRequestContext,
) => ApiJsonValue | Promise<ApiJsonValue>;

export type ApiJsonErrorResponder = (
  error: unknown,
  pathName: string,
  requestId: string,
) => Response | Promise<Response>;

export type ApiPostJsonRoute = (pathName: string, handler: ApiJsonHandler) => void;

/**
 * 公开 POST JSON 路由统一在这里解析请求、包响应壳和生成 request_id。
 */
export function register_post_json_route(
  app: Hono,
  path_name: string,
  handler: ApiJsonHandler,
  on_error: ApiJsonErrorResponder,
): void {
  app.post(path_name, async (context) => {
    const request_id = crypto.randomUUID();
    try {
      const body = (await context.req.json().catch((error: unknown) => {
        throw new InvalidJsonError(error);
      })) as Record<string, ApiJsonValue>;
      const data = await handler(body, {
        requestId: request_id,
        signal: context.req.raw.signal,
      });
      return context.json(ok(data));
    } catch (error) {
      if (context.req.raw.signal.aborted) {
        // 客户端取消是 latest-wins 的预期控制流，不进入服务端故障记录。
        return new Response(null, { status: 499 });
      }
      return await on_error(error, path_name, request_id);
    }
  });
}
