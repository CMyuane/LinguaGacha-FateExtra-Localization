import path from "node:path";

import { NativeFs, default_native_fs } from "../../native/native-fs";

type GlyphCodecRecord = {
  char?: unknown;
  encoded_hex?: unknown;
};

type GlyphCodecDocument = {
  records?: unknown;
};

export type FateExtraCapacityMeasurement = {
  encoded_bytes: number;
  slot_capacity: number | null;
  remaining_bytes: number | null;
  exceeded_bytes: number;
  over_capacity: boolean;
};

const codec_cache = new Map<string, FateExtraGameTextCodec>();

/**
 * Measures game strings with the same one/two-byte widths used by the generated
 * Shift-JIS-compatible glyph codec. Future extension glyphs always consume two bytes.
 */
export class FateExtraGameTextCodec {
  private constructor(private readonly encoded_width_by_character: ReadonlyMap<string, number>) {}

  public static from_fontpack_directory(
    fontpack_directory: string,
    native_fs: NativeFs = default_native_fs,
  ): FateExtraGameTextCodec {
    const identity = native_fs.to_identity_path(fontpack_directory);
    const cached = codec_cache.get(identity);
    if (cached !== undefined) {
      return cached;
    }
    const encoded_width_by_character = new Map<string, number>();
    for (const file_name of ["jp-font-map.json", "chinese-glyph-codec.json"]) {
      const file_path = path.join(fontpack_directory, file_name);
      const document = JSON.parse(native_fs.read_text_file(file_path)) as GlyphCodecDocument;
      const records = Array.isArray(document.records) ? document.records : [];
      for (const value of records) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          continue;
        }
        const record = value as GlyphCodecRecord;
        const character = typeof record.char === "string" ? record.char : "";
        const encoded_hex = typeof record.encoded_hex === "string" ? record.encoded_hex.trim() : "";
        if (
          character === "" ||
          encoded_hex === "" ||
          encoded_hex.length % 2 !== 0 ||
          !/^[0-9A-F]+$/iu.test(encoded_hex)
        ) {
          continue;
        }
        encoded_width_by_character.set(character, encoded_hex.length / 2);
      }
    }
    const codec = new FateExtraGameTextCodec(encoded_width_by_character);
    codec_cache.set(identity, codec);
    return codec;
  }

  public static from_records(records: GlyphCodecRecord[]): FateExtraGameTextCodec {
    const encoded_width_by_character = new Map<string, number>();
    for (const record of records) {
      const character = typeof record.char === "string" ? record.char : "";
      const encoded_hex = typeof record.encoded_hex === "string" ? record.encoded_hex.trim() : "";
      if (
        character !== "" &&
        encoded_hex.length > 0 &&
        encoded_hex.length % 2 === 0 &&
        /^[0-9A-F]+$/iu.test(encoded_hex)
      ) {
        encoded_width_by_character.set(character, encoded_hex.length / 2);
      }
    }
    return new FateExtraGameTextCodec(encoded_width_by_character);
  }

  public encoded_length(text: string): number {
    let length = 0;
    for (const character of text) {
      length +=
        this.encoded_width_by_character.get(character) ??
        (this.is_cp932_single_byte(character) ? 1 : 2);
    }
    return length;
  }

  public measure(text: string, slot_capacity: number | null): FateExtraCapacityMeasurement {
    const encoded_bytes = this.encoded_length(text);
    if (slot_capacity === null) {
      return {
        encoded_bytes,
        slot_capacity: null,
        remaining_bytes: null,
        exceeded_bytes: 0,
        over_capacity: false,
      };
    }
    const remaining_bytes = slot_capacity - encoded_bytes;
    return {
      encoded_bytes,
      slot_capacity,
      remaining_bytes,
      exceeded_bytes: Math.max(0, -remaining_bytes),
      over_capacity: remaining_bytes < 0,
    };
  }

  private is_cp932_single_byte(character: string): boolean {
    const code_point = character.codePointAt(0);
    return (
      code_point !== undefined &&
      (code_point <= 0x7f || (code_point >= 0xff61 && code_point <= 0xff9f))
    );
  }
}

export function reset_fate_extra_game_text_codec_cache(): void {
  codec_cache.clear();
}
