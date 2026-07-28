# LinguaGacha-FateExtra-本地化

此代码仓库是 LinguaGacha 的自定义分支。

目的：

- Fate/EXTRA 中文本地化
- 脚本提取
- 翻译工作流
- 重新导入管线

原始项目：

https://github.com/neavo/LinguaGacha

## 项目关系

LinguaGacha FE 固定基于 LinguaGacha `v0.103.0`、提交
`df858d53c7d97484cf5b2f763c751e9fc3c72f67`。普通 LinguaGacha 项目的导入、翻译、校对、
百宝箱和导出流程保持原样；本仓库新增的行为只对显式启用
`fate_extra.adapter.v1` 的项目生效。

应用名称、appId、用户配置目录和构建产物均与原版独立，可并行安装：

- 应用名称：`LinguaGacha FE`
- Windows 数据目录：`LinguaGachaFE`
- Windows x64 便携包：`LinguaGacha-FE-v0.103.0-fe.1-win-x64.zip`

## 安装与启动

最终用户可下载 Windows x64 便携包，解压后运行 `LinguaGacha-FE.exe`。开发模式需要
Node.js 24 和 npm：

```powershell
npm install
npm run dev
```

LinguaGacha FE 不包含游戏镜像、EBOOT、完整译文、`.lg` 项目或分类数据库。

## 启用 Fate/Extra 适配

1. 打开一个 `.lg` 项目。
2. 进入“百宝箱”，选择“Fate/Extra 汉化适配”。
3. 选择六份带索引日文原稿所在目录。默认路径：
   `D:\AA_Fe_Transition\灵瓜处理\最终文本分支_带索引日文原版`。
4. 选择外置只读分类数据库。默认路径：
   `D:\AA_Fe_Transition\文本安全分类\FE文本安全分类.sqlite`。
5. 先执行扫描并检查报告；只有 6 个文件、34,693 条逻辑游戏文本且分类匹配率为
   100% 时才能应用。
6. 应用前会自动备份原 `.lg`。转换在单一 SQLite 事务中完成，失败时整体回滚。

适配器把 `路径 | char:数字 | 正文` 识别为索引文本，以同一 `path + char` 合并首行和续行。
索引不进入翻译提示、不进入校对正文，也不计入文本行数；真实物理换行保存在
`src`/`dst` 中。原始索引、透传行、分类信息和源文哈希保存在
`extra_field.__linguagacha_fe_v1`，不会引入与原版冲突的新 `text_type`。

本仓库版本化保存了：

- `resource/fate-extra/rules/翻译工具接入说明.md`
- `resource/fate-extra/rules/翻译注意事项.md`
- `resource/fate-extra/rules/translation-prompt.md`

其中翻译提示规则只会附加到已启用 FE 适配的工作单元。

## 迁移现有译文

扫描页面默认识别：

```text
D:\灵瓜\FE_尼禄线_凛分支_保留索引日文.lg
```

旧 `.lg` 的五个稳定分支优先按源文与物理行号精确迁移；尼禄/凛分支只接受精确或唯一
高置信匹配。歧义项不会按顺序强制填入，而是留空、标记“迁移待确认”，并在输出目录
生成 CSV/JSON 清单。

也可以导入 `D:\AA_Fe_Transition\灵瓜处理` 下的六份无索引 TXT。导入器仍以索引原稿和
源文匹配为准，不使用不可靠的全局顺序填充。

## PSP 画面预览与“溢出”

启用 FE 项目后，侧边栏会出现“PSP 画面预览”。预览器使用 480×272 Canvas，正文区域
宽度为 432 px、最多显示 3 行，并支持：

- 上一条、下一条、逐条浏览；
- 搜索、文件筛选和警告筛选；
- 原文/译文切换；
- 从者和性别条件组合切换；
- Ruby、颜色、变量、图标、字号及偏移控制符；
- 新字符在正式同步前由内置 Noto Sans CJK SC 以同尺寸临时渲染。

校对状态 `FE_PSP_OVERFLOW` 在界面中显示为“溢出”。含条件控制符的文本会遍历所有
支持的从者与性别组合，任一组合超过 432 px 或 3 行即标记。控制符、换行、槽位容量、
共享存储和未解析存储仍可作为 FE 规则警告显示，但普通警告只需确认，不会阻止导出。

## 自动字库同步

内置基线由当前六份译文重建，验收数据为：

- 可见字符：2,848；
- 主字库新增扩展字形：171；
- 复用日版原生字形：77；
- Ruby 字库新增读音字形：738；
- 主字库与 Ruby 字库缺字：均为 0；
- 剩余 Shift-JIS 用户扩展编码槽：168。

保存后的预览使用内置字体缓存；每次 FE 导出前，应用会扫描项目全部 `dst`，剥离控制符
并展开所有可见条件分支，同时扫描 Ruby 读音。已有编码永不重排，新字符按 Unicode
顺序追加到 Shift-JIS 用户扩展区。随后重新生成：

- 主字库与 Ruby 字库二进制；
- 所有纹理页；
- `chinese-glyph-codec.json`、Ruby 映射及字体映射；
- `textures.ini`；
- 带逐文件 SHA-256 的 `font-manifest.json`。

字库生成 helper 已封装为独立 Windows 可执行文件，发布包运行时不依赖本机 Python。
“PSP 字库缺字”和“不可编码字符”不会作为校对警告出现：导出前同步负责解决这些问题。
只有扩展编码槽耗尽属于硬错误；此时导出会以“编码槽已耗尽”安全停止，不替换字符、不
截断文本。

## 导出与重新导入

FE 页面提供：

- **无索引译文**：默认模式，只输出译文和原样透传行。
- **恢复索引译文**：在每条逻辑游戏文本首行恢复原始 `path + char` 前缀。

导出固定执行：

1. 全项目字库同步；
2. 字库编码、纹理槽和预览映射覆盖验证；
3. FE 控制符、显示溢出和存储容量 QA；
4. 输出文本、QA JSON/CSV 和迁移待确认清单；
5. 输出供重新导入管线使用的字库、映射和 manifest。

源文件的 BOM、编码与换行风格会被保留。字库同步失败、索引结构损坏或输出目录不可写
是系统错误；普通 FE 警告不会阻止文本与重新导入资源输出。

## 开发、测试与构建

```powershell
npm install
npm run check
npm run lint
npm test
npm run format
npm run build
```

重新构建无需 Python 的字库 helper：

```powershell
python -m PyInstaller --onefile `
  --name fate-extra-font-builder `
  --distpath resource\fate-extra\bin `
  --workpath build\pyinstaller-font `
  --specpath build\pyinstaller-font `
  buildtools\fate-extra-font\font_builder.py
```

关键验收包括：普通项目行为回归、6/34,693/100% 扫描基准、迁移歧义不静默错填、
18 个全宽字恰好 432 px、19 个字或第 4 行标记溢出、所有条件分支检查、六份译文
主/Ruby 字库零缺字、编码槽耗尽安全失败，以及两种索引导出结构。

## 授权与声明

LinguaGacha 的原始代码权利归原项目作者所有。固定的上游提交没有随源码仓库提供
独立 `LICENSE` 文件，因此本分支不额外授予对上游代码的许可；使用、修改或再分发前
请向原作者确认许可条件。
Noto Sans CJK SC 来自 Adobe/Google Noto CJK 项目，按随字体保存的
SIL Open Font License 1.1 再分发。详细资源说明见 `resource/fate-extra/NOTICE.md`。

本分支及 Fate/Extra 预览、映射和生成资源仅供非商业交流、研究与学习，不得用于商业
用途。游戏及其素材的权利归相应权利人所有；使用者须自行确认补丁和资源的再分发权利。
