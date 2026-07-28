from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import font_builder


class FontBuilderTest(unittest.TestCase):
    def test_extension_codes_are_stable_and_skip_used_codes(self) -> None:
        codes = font_builder.extension_codes({bytes.fromhex("F040")})

        self.assertEqual(bytes.fromhex("F041"), font_builder.allocate_extension_code(codes))

    def test_exhausted_extension_codes_raise_a_system_error(self) -> None:
        with self.assertRaisesRegex(font_builder.FontBuildError, "编码槽已耗尽"):
            font_builder.allocate_extension_code(iter(()))

    def test_generated_texture_manifest_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "textures.ini"
            target.write_text("[hashes]\n123 = old.png\n", encoding="utf-8")

            font_builder.update_textures_manifest(target, 2, 1)
            first = target.read_text(encoding="utf-8")
            font_builder.update_textures_manifest(target, 2, 1)

            self.assertEqual(first, target.read_text(encoding="utf-8"))
            self.assertIn("main_page_01 = font/page-01.png", first)
            self.assertIn("ruby_page_00 = ruby/0.png", first)


if __name__ == "__main__":
    unittest.main()
