#!/usr/bin/env python3
"""Deterministic Fate/Extra PSP font synchronizer.

The packaged executable reads one JSON request path from argv and writes a
complete, self-verifying fontpack. Existing character codes are immutable;
new codes are allocated in Unicode order from Shift-JIS user extension space.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont


EXTENSION_LEADS = range(0xF0, 0xFA)
EXTENSION_TRAILS = (*range(0x40, 0x7F), *range(0x80, 0xFD))
EXTENSION_CAPACITY = len(EXTENSION_LEADS) * len(EXTENSION_TRAILS)


class FontBuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class GlyphSlot:
    slot: int
    code_raw: bytes
    char: str

    @property
    def encoded(self) -> bytes:
        return self.code_raw[1:2] if self.code_raw[0] == 0 else bytes(reversed(self.code_raw))


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def read_glyph_table(path: Path) -> list[GlyphSlot]:
    data = path.read_bytes()
    if len(data) < 4:
        raise FontBuildError(f"字库表无效：{path}")
    count = struct.unpack_from("<I", data, 0)[0]
    if 4 + count * 6 > len(data):
        raise FontBuildError(f"字库表被截断：{path}")
    slots: list[GlyphSlot] = []
    for slot in range(count):
        record = data[4 + slot * 6 : 4 + (slot + 1) * 6]
        raw_char = record[2:6].split(b"\0", 1)[0]
        slots.append(GlyphSlot(slot, record[:2], raw_char.decode("utf-8", errors="strict")))
    return slots


def write_glyph_table(path: Path, slots: list[GlyphSlot]) -> None:
    output = bytearray(struct.pack("<I", len(slots)))
    for expected, slot in enumerate(slots):
        if slot.slot != expected:
            raise FontBuildError(f"字库槽位不连续：期望 {expected}，实际 {slot.slot}")
        encoded_char = slot.char.encode("utf-8")
        if len(encoded_char) > 4:
            raise FontBuildError(f"字形标签无法写入 PSP 字库表：{slot.char!r}")
        output.extend(slot.code_raw)
        output.extend(encoded_char)
        output.extend(b"\0" * (4 - len(encoded_char)))
    output.extend(b"\0" * ((-len(output)) % 16))
    path.write_bytes(output)


def extension_codes(used: set[bytes]) -> Iterable[bytes]:
    for lead in EXTENSION_LEADS:
        for trail in EXTENSION_TRAILS:
            encoded = bytes((lead, trail))
            if encoded not in used:
                yield encoded


def allocate_extension_code(codes: Iterable[bytes]) -> bytes:
    try:
        return next(iter(codes))
    except StopIteration as exc:
        raise FontBuildError("编码槽已耗尽") from exc


def clone_baseline(baseline: Path, output: Path) -> None:
    if baseline.resolve() == output.resolve():
        raise FontBuildError("字库输出目录不能覆盖内置基线。")
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(baseline, output)
    required_glyphs = output / "required-glyphs.txt"
    if required_glyphs.is_file():
        required_glyphs.write_text(
            required_glyphs.read_text(encoding="utf-8-sig").rstrip() + "\n",
            encoding="utf-8",
            newline="\n",
        )


def update_textures_manifest(
    path: Path,
    main_page_count: int,
    ruby_page_count: int,
) -> None:
    """Preserve PPSSPP replacements and publish generated pages for reimport tools."""
    original = path.read_text(encoding="utf-8-sig") if path.is_file() else ""
    marker = "\n[fate-extra-generated]\n"
    original = original.split(marker, 1)[0].rstrip()
    entries = [
        "",
        "[fate-extra-generated]",
        f"main_page_count = {main_page_count}",
        f"ruby_page_count = {ruby_page_count}",
    ]
    entries.extend(
        f"main_page_{index:02d} = font/page-{index:02d}.png"
        for index in range(main_page_count)
    )
    entries.extend(
        f"ruby_page_{index:02d} = ruby/{index}.png"
        for index in range(ruby_page_count)
    )
    path.write_text(
        original + "\n" + "\n".join(entries) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def ensure_pages(
    directory: Path,
    page_count: int,
    size: tuple[int, int],
    prefix: str,
    allow_taller: bool = False,
) -> list[Image.Image]:
    directory.mkdir(parents=True, exist_ok=True)
    pages: list[Image.Image] = []
    for index in range(page_count):
        path = directory / f"{prefix}{index:02d}.png"
        fallback_path = directory / f"{index}.png"
        source = path if path.is_file() else fallback_path
        page = (
            Image.open(source).convert("RGBA")
            if source.is_file()
            else Image.new("RGBA", size, (0, 255, 0, 0))
        )
        valid_size = (
            page.width == size[0] and page.height >= size[1]
            if allow_taller
            else page.size == size
        )
        if not valid_size:
            raise FontBuildError(f"字库纹理尺寸不正确：{source} -> {page.size}")
        pages.append(page)
    return pages


def draw_glyph(
    page: Image.Image,
    char: str,
    cell: int,
    columns: int,
    cell_width: int,
    cell_height: int,
    font: ImageFont.FreeTypeFont,
) -> None:
    x = (cell % columns) * cell_width
    y = (cell // columns) * cell_height
    draw = ImageDraw.Draw(page)
    draw.rectangle((x, y, x + cell_width - 1, y + cell_height - 1), fill=(0, 255, 0, 0))
    left, top, right, bottom = draw.textbbox((0, 0), char, font=font)
    width = right - left
    height = bottom - top
    draw.text(
        (x + (cell_width - width) // 2 - left, y + (cell_height - height) // 2 - top),
        char,
        font=font,
        fill=(255, 255, 255, 255),
    )


def build_fontpack(request: dict) -> dict:
    baseline = Path(request["baseline_dir"]).resolve()
    output = Path(request["output_dir"]).resolve()
    font_path = Path(request["font_path"]).resolve()
    main_chars = {str(char) for char in request.get("main_characters", []) if str(char).strip()}
    ruby_chars = {str(char) for char in request.get("ruby_characters", []) if str(char).strip()}
    main_chars.update(ruby_chars)
    if not baseline.is_dir():
        raise FontBuildError(f"内置字库基线不存在：{baseline}")
    if not font_path.is_file():
        raise FontBuildError(f"Noto Sans CJK 字体不存在：{font_path}")

    clone_baseline(baseline, output)
    codec_path = output / "chinese-glyph-codec.json"
    native_map_path = output / "jp-font-map.json"
    ruby_map_path = output / "ruby-font-map.json"
    codec = read_json(codec_path)
    native_map = read_json(native_map_path)
    ruby_map = read_json(ruby_map_path)
    codec_records: list[dict] = list(codec.get("records", []))
    native_records: list[dict] = list(native_map.get("records", []))
    ruby_records: list[dict] = list(ruby_map.get("records", []))
    codec_by_char = {record["char"]: record for record in codec_records}
    native_by_char: dict[str, dict] = {}
    for record in native_records:
        native_by_char.setdefault(record["char"], record)

    kanzi_path = output / "kanzi.bin"
    ruby_path = output / "ruby.bin"
    main_slots = read_glyph_table(kanzi_path)
    ruby_slots = read_glyph_table(ruby_path)
    used_codes = {bytes.fromhex(record["encoded_hex"]) for record in codec_records}
    next_codes = iter(extension_codes(used_codes))
    added_main: list[GlyphSlot] = []
    reused_native = 0

    for char in sorted(main_chars - set(codec_by_char), key=ord):
        native = native_by_char.get(char)
        if native is not None:
            record = {
                "char": char,
                "unicode": f"U+{ord(char):04X}",
                "encoded_hex": native["encoded_hex"],
                "slot": native["slot"],
                "source": "native",
            }
            reused_native += 1
        else:
            encoded = allocate_extension_code(next_codes)
            slot = GlyphSlot(
                slot=len(main_slots),
                code_raw=bytes(reversed(encoded)),
                char=char,
            )
            main_slots.append(slot)
            added_main.append(slot)
            record = {
                "char": char,
                "unicode": f"U+{ord(char):04X}",
                "encoded_hex": encoded.hex().upper(),
                "slot": slot.slot,
                "source": "extended",
            }
            used_codes.add(encoded)
        codec_records.append(record)
        codec_by_char[char] = record

    used_extension_count = sum(
        1
        for record in codec_records
        if len(bytes.fromhex(record["encoded_hex"])) == 2
        and 0xF0 <= bytes.fromhex(record["encoded_hex"])[0] <= 0xF9
    )
    remaining_slots = EXTENSION_CAPACITY - used_extension_count
    if remaining_slots < 0:
        raise FontBuildError("编码槽已耗尽")

    main_page_count = max(1, (len(main_slots) + 255) // 256)
    main_pages_dir = output / "font"
    main_pages = ensure_pages(main_pages_dir, main_page_count, (256, 256), "page-")
    main_font = ImageFont.truetype(str(font_path), 15)
    for slot in added_main:
        draw_glyph(
            main_pages[slot.slot // 256],
            slot.char,
            slot.slot % 256,
            16,
            16,
            16,
            main_font,
        )
    for index, page in enumerate(main_pages):
        page.save(main_pages_dir / f"page-{index:02d}.png", format="PNG", optimize=True)

    ruby_by_char = {record["char"]: record for record in ruby_records}
    added_ruby: list[GlyphSlot] = []
    for char in sorted(ruby_chars - set(ruby_by_char), key=ord):
        main_mapping = codec_by_char.get(char)
        if main_mapping is None:
            raise FontBuildError(f"Ruby 字形缺少主字库编码：{char!r}")
        encoded = bytes.fromhex(main_mapping["encoded_hex"])
        code_raw = b"\0" + encoded if len(encoded) == 1 else bytes(reversed(encoded))
        slot = GlyphSlot(len(ruby_slots), code_raw, char)
        ruby_slots.append(slot)
        added_ruby.append(slot)
        ruby_records.append(
            {
                "slot": slot.slot,
                "char": char,
                "encoded_hex": encoded.hex().upper(),
                "source": "extended",
            }
        )

    ruby_page_count = max(2, (len(ruby_slots) + 127) // 128)
    ruby_pages_dir = output / "ruby"
    ruby_pages = ensure_pages(
        ruby_pages_dir,
        ruby_page_count,
        (128, 128),
        "",
        allow_taller=True,
    )
    ruby_font = ImageFont.truetype(str(font_path), 8)
    for slot in added_ruby:
        draw_glyph(
            ruby_pages[slot.slot // 128],
            slot.char,
            slot.slot % 128,
            16,
            8,
            16,
            ruby_font,
        )
    for index, page in enumerate(ruby_pages):
        page.save(ruby_pages_dir / f"{index}.png", format="PNG", optimize=True)

    write_glyph_table(kanzi_path, main_slots)
    write_glyph_table(ruby_path, ruby_slots)
    codec["records"] = sorted(codec_records, key=lambda record: ord(record["char"]))
    ruby_map["records"] = sorted(ruby_records, key=lambda record: int(record["slot"]))
    write_json(codec_path, codec)
    write_json(ruby_map_path, ruby_map)
    update_textures_manifest(
        output / "textures.ini",
        main_page_count,
        ruby_page_count,
    )
    (output / "required-visible-glyphs.txt").write_text(
        "".join(sorted(main_chars, key=ord)) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    (output / "required-ruby-glyphs.txt").write_text(
        "".join(sorted(ruby_chars, key=ord)) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    covered_main = {record["char"] for record in codec["records"]}
    covered_ruby = {record["char"] for record in ruby_map["records"]}
    missing_main = sorted(main_chars - covered_main, key=ord)
    missing_ruby = sorted(ruby_chars - covered_ruby, key=ord)
    if missing_main or missing_ruby:
        raise FontBuildError("字库覆盖验证失败")

    tracked_files = sorted(
        path
        for path in output.rglob("*")
        if path.is_file() and path.name != "font-manifest.json"
    )
    manifest = {
        "schema_version": 1,
        "game_id": codec.get("game_id", "NPJH50247"),
        "generator": "LinguaGacha FE font-builder fe.1",
        "corpus_sha256": hashlib.sha256(
            "".join(sorted(main_chars, key=ord)).encode("utf-8")
        ).hexdigest(),
        "font_sha256": sha256(font_path),
        "main_character_count": len(main_chars),
        "ruby_character_count": len(ruby_chars),
        "added_main_glyphs": len(added_main),
        "reused_native_glyphs": reused_native,
        "added_ruby_glyphs": len(added_ruby),
        "remaining_extension_slots": remaining_slots,
        "main_page_count": main_page_count,
        "ruby_page_count": ruby_page_count,
        "missing_main_glyphs": missing_main,
        "missing_ruby_glyphs": missing_ruby,
        "files": [
            {
                "path": path.relative_to(output).as_posix(),
                "size": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in tracked_files
        ],
    }
    write_json(output / "font-manifest.json", manifest)
    manifest["manifest_sha256"] = sha256(output / "font-manifest.json")
    return manifest


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fate-extra-font-builder REQUEST.json", file=sys.stderr)
        return 2
    request_path = Path(sys.argv[1])
    try:
        result = build_fontpack(read_json(request_path))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
