import { DatabaseSync } from "node:sqlite";

import { default_native_fs, type NativeFs } from "../../native/native-fs";

export type FateExtraSqliteInputFingerprint = {
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string;
};

export type FateExtraClassificationSnapshot = {
  fingerprints: FateExtraSqliteInputFingerprint[];
  snapshot_sha256: string;
};

const SQLITE_FINGERPRINT_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * 建立分类库一致性快照。连接生命周期留在 database 边界，worker 只编排任务。
 */
export async function create_stable_fate_extra_classification_snapshot(
  source_path: string,
  snapshot_path: string,
  native_fs: NativeFs = default_native_fs,
): Promise<FateExtraClassificationSnapshot> {
  remove_fate_extra_sqlite_file_set(snapshot_path, native_fs);
  const source = new DatabaseSync(native_fs.to_native_path(source_path), { readOnly: true });
  try {
    // VACUUM INTO 自身持有一致读快照；任务开始和发布前各调用一次并比较
    // 快照哈希，避免把读连接自己修改的 SHM 锁区误判为业务写入。
    source.prepare("VACUUM INTO ?").run(native_fs.to_native_path(snapshot_path));
    return {
      fingerprints: await capture_stable_sqlite_fingerprints(source_path, native_fs),
      snapshot_sha256: await native_fs.sha256_file(snapshot_path),
    };
  } catch (error) {
    remove_fate_extra_sqlite_file_set(snapshot_path, native_fs);
    throw error;
  } finally {
    source.close();
  }
}

/** 主库、WAL 与 SHM 必须作为一个稳定文件集合共同参与输入身份。 */
export async function capture_stable_sqlite_fingerprints(
  database_path: string,
  native_fs: NativeFs = default_native_fs,
): Promise<FateExtraSqliteInputFingerprint[]> {
  if (!native_fs.exists(database_path)) {
    throw new Error(`安全分类数据库不存在：${database_path}`);
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const paths = sqlite_file_set(database_path, native_fs);
      if (paths[0] !== database_path) throw new Error("安全分类数据库主库不存在。");
      const fingerprints: FateExtraSqliteInputFingerprint[] = [];
      let stable = true;
      for (const file_path of paths) {
        const before = native_fs.stat(file_path);
        const sha256 = await native_fs.sha256_file(file_path);
        const after = native_fs.stat(file_path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          stable = false;
          break;
        }
        fingerprints.push({
          path: file_path,
          size: after.size,
          mtime_ms: after.mtimeMs,
          sha256,
        });
      }
      const final_paths = sqlite_file_set(database_path, native_fs);
      if (
        stable &&
        paths.length === final_paths.length &&
        paths.every((value, index) => value === final_paths[index])
      ) {
        return fingerprints;
      }
    } catch {
      // WAL/SHM 可能在哈希过程中被 checkpoint；下一轮重新捕获完整稳定集合。
    }
  }
  throw new Error("无法取得稳定的安全分类数据库主库、WAL 与 SHM 指纹。");
}

export function same_fate_extra_sqlite_fingerprints(
  left: FateExtraSqliteInputFingerprint[],
  right: FateExtraSqliteInputFingerprint[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.path === right[index]?.path &&
        value.size === right[index]?.size &&
        value.mtime_ms === right[index]?.mtime_ms &&
        value.sha256 === right[index]?.sha256,
    )
  );
}

export function remove_fate_extra_sqlite_file_set(
  database_path: string,
  native_fs: NativeFs = default_native_fs,
): void {
  for (const suffix of SQLITE_FINGERPRINT_SUFFIXES) {
    const file_path = `${database_path}${suffix}`;
    if (native_fs.exists(file_path)) native_fs.remove(file_path, { force: true });
  }
}

function sqlite_file_set(database_path: string, native_fs: NativeFs): string[] {
  return SQLITE_FINGERPRINT_SUFFIXES.map((suffix) => `${database_path}${suffix}`).filter(
    (file_path) => native_fs.exists(file_path),
  );
}
