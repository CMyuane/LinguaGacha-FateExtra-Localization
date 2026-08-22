import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeFs, normalize_native_file_bytes } from "./native-fs";
import { NativePathPolicy } from "./native-path";

let temp_dir = "";

beforeEach(() => {
  temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-native-fs-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  new NativeFs(new NativePathPolicy(process.platform)).remove(temp_dir, {
    recursive: true,
    force: true,
  });
});

describe("原生文件系统门面", () => {
  it("Windows 根目录创建视为已存在", () => {
    const native_fs = new NativeFs(new NativePathPolicy("win32"));
    const mkdir_sync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("不应创建文件系统根目录");
    });

    expect(() => native_fs.make_dir("E:\\")).not.toThrow();
    expect(mkdir_sync).not.toHaveBeenCalled();
  });

  it("写文件前会自动创建父目录", async () => {
    const native_fs = new NativeFs(new NativePathPolicy(process.platform));
    const target_path = path.join(temp_dir, "nested", "deep", "payload.txt");

    await native_fs.write_file(target_path, "译文");

    expect(fs.readFileSync(target_path, "utf-8")).toBe("译文");
  });

  it("异步写入根目录文件时不创建盘符根目录", async () => {
    const native_fs = new NativeFs(new NativePathPolicy("win32"));
    const mkdir = vi
      .spyOn(fs.promises, "mkdir")
      .mockRejectedValue(new Error("不应创建文件系统根目录"));
    const write_file = vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);

    await native_fs.write_file("E:\\root-project.lg", "内容");

    expect(mkdir).not.toHaveBeenCalled();
    expect(write_file).toHaveBeenCalledWith("\\\\?\\E:\\root-project.lg", "内容");
  });

  it("显式创建嵌套目录时仍会递归创建", () => {
    const native_fs = new NativeFs(new NativePathPolicy(process.platform));
    const target_dir = path.join(temp_dir, "explicit", "nested");

    native_fs.make_dir(target_dir);

    expect(fs.statSync(target_dir).isDirectory()).toBe(true);
  });

  it("同步写入和追加都复用同一父目录策略", () => {
    const native_fs = new NativeFs(new NativePathPolicy(process.platform));
    const target_path = path.join(temp_dir, "log", "app.log");

    native_fs.write_file_sync(target_path, "第一行\n");
    native_fs.append_text_file(target_path, "第二行\n");

    expect(fs.readFileSync(target_path, "utf-8")).toBe("第一行\n第二行\n");
  });

  it("批量文本输出在多次写入间复用同一文件句柄", () => {
    const native_fs = new NativeFs(new NativePathPolicy(process.platform));
    const target_path = path.join(temp_dir, "export", "report.json");
    const open_sync = vi.spyOn(fs, "openSync");
    const close_sync = vi.spyOn(fs, "closeSync");
    const append_sync = vi.spyOn(fs, "appendFileSync");

    const writer = native_fs.open_text_writer(target_path, "[");
    writer.write('{"id":1}');
    writer.write(",");
    writer.write('{"id":2}]');
    writer.close();
    writer.close();

    expect(fs.readFileSync(target_path, "utf-8")).toBe('[{"id":1},{"id":2}]');
    expect(open_sync).toHaveBeenCalledTimes(1);
    expect(close_sync).toHaveBeenCalledTimes(1);
    expect(append_sync).not.toHaveBeenCalled();
    expect(() => writer.write("late")).toThrow("不能写入已经关闭的文本输出。");
  });

  it("逐行 UTF-8 读取跨 chunk 保留 BOM、CRLF 和尾换行语义", async () => {
    const native_fs = new NativeFs(new NativePathPolicy(process.platform));
    const target_path = path.join(temp_dir, "stream.txt");
    fs.writeFileSync(target_path, Buffer.from("\uFEFF第一行\r\n第二行\r\n", "utf-8"));
    const lines: Array<{ text: string; line: number }> = [];

    const result = await native_fs.read_utf8_lines(target_path, (text, line) => {
      lines.push({ text, line });
    });

    expect(lines).toEqual([
      { text: "第一行", line: 1 },
      { text: "第二行", line: 2 },
    ]);
    expect(result).toEqual({
      has_bom: true,
      eol: "\r\n",
      trailing_eol: true,
      physical_line_count: 2,
    });
  });

  it("可以写入和读取超过 Windows 传统长度限制的路径", async () => {
    const native_fs = new NativeFs(new NativePathPolicy(process.platform));
    const long_segments = Array.from(
      { length: 12 },
      (_, index) => `segment-${index.toString().padStart(2, "0")}-abcdefghijklmnopqrst`,
    );
    const target_path = path.join(temp_dir, ...long_segments, "payload.txt");

    expect(target_path.length).toBeGreaterThan(260);
    await native_fs.write_file(target_path, "长路径译文");

    expect(native_fs.read_text_file(target_path)).toBe("长路径译文");
  });

  it("删除目录时保留调用方指定的递归语义", () => {
    const native_fs = new NativeFs(new NativePathPolicy(process.platform));
    const target_dir = path.join(temp_dir, "removable", "child");
    fs.mkdirSync(target_dir, { recursive: true });
    fs.writeFileSync(path.join(target_dir, "file.txt"), "内容", "utf-8");

    native_fs.remove(path.join(temp_dir, "removable"), { recursive: true, force: true });

    expect(fs.existsSync(path.join(temp_dir, "removable"))).toBe(false);
  });

  it("第三方二进制输出会收窄成 Uint8Array", () => {
    const bytes = normalize_native_file_bytes(Buffer.from("xlsx", "utf-8"));

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString("utf-8")).toBe("xlsx");
  });
});
