import path from "node:path";

/** FE 路线输出只能位于本次 staging / publication 根目录内。 */
export function resolve_fate_extra_export_path(root: string, relative_path: string): string {
  if (
    relative_path.trim() === "" ||
    path.isAbsolute(relative_path) ||
    path.win32.isAbsolute(relative_path) ||
    path.posix.isAbsolute(relative_path)
  ) {
    throw new Error(`FE 导出文件路径必须是非空相对路径：${relative_path}`);
  }
  const resolved_root = path.resolve(root);
  const resolved_path = path.resolve(resolved_root, relative_path);
  const relative = path.relative(resolved_root, resolved_path);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`FE 导出文件路径越过输出目录：${relative_path}`);
  }
  return resolved_path;
}
