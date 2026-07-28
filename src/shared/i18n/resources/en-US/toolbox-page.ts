import { zh_cn_toolbox_page } from "../zh-CN/toolbox-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_toolbox_page = {
  title: "Toolbox",
  entries: {
    ts_conversion: {
      title: "TS Conversion",
      description:
        "Batch convert the target text or character names between Traditional and Simplified Chinese with text protection",
    },
    fate_extra: {
      title: "Fate/Extra Localization Adapter",
      description:
        "Connect indexes and safety classifications, migrate translations, sync PSP fonts, and export reimport data",
    },
  },
} satisfies LocaleMessageSchema<typeof zh_cn_toolbox_page>;
