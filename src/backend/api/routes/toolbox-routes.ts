import type { ApiRouteContext } from "./route-types";

export function register_toolbox_routes(context: ApiRouteContext): void {
  context.postJson("/api/toolbox/ts-conversion/files/export", (body) =>
    context.services.toolbox.tsConversion.export_files(body),
  );
  context.postJson("/api/toolbox/fate-extra/scan", (body) =>
    context.services.toolbox.fateExtra.scan(body),
  );
  context.postJson("/api/toolbox/fate-extra/apply", (body) =>
    context.services.toolbox.fateExtra.apply(body),
  );
  context.postJson("/api/toolbox/fate-extra/font/scan", (body) =>
    context.services.toolbox.fateExtraFont.scan(body),
  );
  context.postJson("/api/toolbox/fate-extra/font/sync", (body) =>
    context.services.toolbox.fateExtraFont.sync(body),
  );
  context.postJson("/api/toolbox/fate-extra/export", (body) =>
    context.services.toolbox.fateExtra.export_project(body),
  );
  context.postJson("/api/toolbox/fate-extra/items", (body) =>
    context.services.toolbox.fateExtra.list_items(body),
  );
  context.postJson("/api/toolbox/fate-extra/preview", (body) =>
    context.services.toolbox.fateExtra.preview(body),
  );
}
