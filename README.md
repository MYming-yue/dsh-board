# DSH-board

[![CI](https://github.com/MYming-yue/dsh-board/actions/workflows/ci.yml/badge.svg)](https://github.com/MYming-yue/dsh-board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在 DSH 对话旁，放一张人和 AI 可以长期共同维护的白板。**

A persistent shared whiteboard beside the native DeepSeek Harness conversation.

DSH-board 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地插件，基于 [draft-board](https://github.com/MYming-yue/draft-board)。白板保留理解和成果，对话用来提出问题、讨论与纠正：学一个概念、拆解一个产品，或持续打磨一个项目。

公开试用版为 **0.1.5**，当前源码为 **0.1.8-dev.2 开发预览**（未发布正式新版）。插件单独维护宿主集成，白板界面和模型通过 [upstream.json](upstream.json) 固定上游提交构建，不维护两套白板代码。已构建的安装包可以独立安装，无需相邻的 draft-board 仓库；尚未发布到 npm。

## 可以做什么

- 完整白板在左，DSH 原生对话在右；对话可展开／收起，分隔线可拖动调整宽度。
- 保留 Markdown、LaTeX、图片、卡片备注、关系、集合、布局、结构视图、历史和撤销／重做。
- 选中卡片／连线，通过“外形与连线”选择步骤矩形、判断菱形、起止圆角、实线／虚线／流动虚线和流程折线，支持分叉、汇合与反馈路径。菜单换外形时固定整个卡片中心，自由曲线绕障保持平滑；流动虚线沿箭头方向移动，减少动态效果和 PNG 中保持静态。使用新样式后文件升级为 3.0，新版可读取旧草稿。
- 新开或切换聊天继续同一张白板，直到主动“新建”或“打开”另一份草稿。
- 选中卡片后发消息，AI 知道本条回复所指的对象；不改写用户回复，不自动附上卡片全文。
- AI 通过 `draft_board_read`／`draft_board_apply` 主动维护白板，复用原子批次、版本校验与整轮撤销。
- 开发预览提供“AI 布局整理”：按语义和已有结构摆放卡片，只移动位置；连线自动绕开卡片和可见备注。
- 在“设置 → DSH-board 白板”管理启用与卡片关联；关闭功能保留草稿。
- 标准白板使用方法指导 AI 精简核心、分离备注，合理使用父子卡、集合与公式卡；用户可阅读、编辑自己的本地方法文件。

## 兼容范围

| 项目 | 已验证范围 |
| --- | --- |
| DSH CLI | 0.1.5-rc.1 |
| DSH 组合包 | 0.1.5-rc.2 |
| 宿主 profile | web |
| 实际宿主联调 | Windows、Chrome |
| 构建环境 | Node.js 22+、npm、Git |

布局和消息提交适配依赖 DSH 当前接口，升级宿主后需要重新验证。其他 DSH 版本和操作系统的完整宿主集成尚未确认；欢迎附版本信息反馈。

## 安装试用版

先确保 DSH web profile 可以正常启动。到 [Releases](https://github.com/MYming-yue/dsh-board/releases) 下载 `dsh-board-0.1.5.tgz`；安装已构建的包不需要 Git、编译工具或 draft-board 源码。

以下为 PowerShell 示例，使用 GitHub CLI 下载。也可以在浏览器下载，再将最后一行改为安装包的绝对路径。

```powershell
$dshHomePath = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pluginDir = Join-Path $dshHomePath 'local-plugins'
New-Item -ItemType Directory -Force $pluginDir | Out-Null
gh release download v0.1.5 --repo MYming-yue/dsh-board --pattern 'dsh-board-0.1.5.tgz' --dir $pluginDir
dsh plugin --profile web add ("file:" + (Join-Path $pluginDir 'dsh-board-0.1.5.tgz'))
```

安装后重启 DSH Web Host，并重新载入页面。在设置中找到“DSH-board 白板”，确认共同白板已启用。

DSH home 使用 `DSH_HOME`，未设置时默认 `~/.dsh`。不要将插件安装到另一个 profile 或 home。更新同样下载新版本安装包后执行 `add` 并重启；构建包使用不同版本和文件名，避免本地依赖缓存误用旧包。

## 第一次体验

1. 在白板上双击创建一张卡片。
2. 选中它，在右侧发送“给这张卡片补充解释”。
3. 观察 AI 工具记录与画布更新，点击“撤销最新一轮”回退该批次。
4. 新开聊天，确认仍然是当前白板。

AI 使用 DSH 原有模型、工具和审批流程。插件不增加模型 API 配置，不管理账户，也不添加云同步。

## AI 布局整理（开发预览）

选择一个 DSH 对话后，点击白板顶栏“AI 布局整理”。普通点击整理全板，Shift 点击只整理选中卡片及父子后代。它使用当前 DSH 模型和原生对话，会产生一次模型请求；既有输入和待发附件保留。长指令与模型输出默认收进紧凑的布局任务入口，点击“查看过程”仍可展开。白板下方显示带轻量动画的真实状态，完成后自动收起，失败保留原因；系统选择减少动态效果时关闭动画。

AI 读取内容、已有关系、集合与实际卡片外框，按清晰、克制、留白适度的原则组织布局。任务仅能提交坐标；不创建或删除卡片，不改正文、尺寸、关系或集合。候选通过几何检查后一次应用，可“撤销最新一轮”；失败保留原布局，最多三次候选。无需移动不增加历史。

等待时可继续编辑，但内容或显示尺寸变化会使旧任务失效，需重新整理。点击“取消整理”阻止提交；要停止模型生成，使用右侧 DSH 原生停止按钮。模型布局的审美与语义质量仍需实际体验调整。独立 Draft Board 的离线整理保留。

## 白板使用方法提示词

打开“设置 → DSH-board 白板 → 白板使用方法提示词”，可以阅读 AI 使用的说明并保存自己的写法。标准方法见 [board-guide.md](docs/board-guide.md)：白板保留核心与知识结构，详细解释放备注，按需要选择父子层级、集合、关联和纯公式卡。它不会强制每块白板使用全部工具，也不替代你本轮明确的写作要求。

用户副本位于 `$DSH_HOME/dsh-board/board-guide.md`，未设置 DSH_HOME 时为 `~/.dsh/dsh-board/board-guide.md`。也可用本地编辑器修改，约 1.5 秒同步到设置页和后续模型请求；设置页保存立即生效。升级保留已有文件，空文件可停用写法建议。

“载入标准方法”先填入编辑器，点击“保存修改”才生效。保存保留上一版 `board-guide.previous.md`；同时在本地编辑时会提示版本冲突并保留编辑内容。UTF-8 文件最多 16 KiB；无效文件不覆盖，AI 暂时保留最近有效说明。方法编辑不改变当前白板或既有聊天，布局整理仍只允许移动卡片。

这是一份可调整的写作指导，实际精简程度与工具使用仍需结合模型输出体验。

## 保存、上下文与管理

草稿位于 `$DSH_HOME/dsh-board/`，包含图片与历史；`current.json` 指向当前草稿。主动更换时保留前一份宿主文件。原生“打开”“保存”“另存为”继续可用：宿主持有一份副本，绑定的磁盘原文件仍通过白板保存入口回写，页面刷新后需重新绑定其文件句柄。

固定协作规则及用户的方法说明注册在系统提示末尾；卡片身份和短标题在本轮运行上下文末尾注入。相同关联复用原生快照，不为每条回复重复追加。不附上全文、时间戳或修订号，不重写既有历史；发生过变化的快照仍由宿主保留，缓存命中率取决于宿主和模型服务。

“设置 → DSH-board 白板”提供“启用共同白板”和“发送时关联选中的卡片”。关闭白板恢复完整聊天区、暂停白板工具，保留草稿与未提交输入；重新启用后继续维护。选项和待处理关联保存在 `plugin-state.json`。

浏览器约每 750ms 与宿主同步。输入、指针操作、布局和回放期间保留当前操作。并行修改冲突时保留双方内容、暂停镜像；另存为后重新打开副本，明确选择继续维护的版本。当前没有自动合并、多任务白板管理、多人协作、AI 图片解析或完整消息／批次追溯。

卸载插件：

```text
dsh plugin --profile web remove dsh-board
```

随后重启宿主；卸载不会删除 `$DSH_HOME/dsh-board/` 中的草稿。

## 从源码构建

```bash
git clone https://github.com/MYming-yue/dsh-board.git
cd dsh-board
npm ci
node node_modules/playwright-core/cli.js install chromium
npm run check
```

首次构建自动拉取锁定的 draft-board 提交并执行其锁定依赖安装，需要访问 GitHub 与 npm。源码缓存在被忽略的 `.upstream/`；构建产物位于 `lib/`。上游锁不变时复用缓存；更新需显式修改 `upstream.json` 并重新验证。构建不会读取个人 DSH 配置、模型凭据或草稿。

`npm run check` 执行上游类型检查、界面与模型构建、插件测试，以及真实浏览器的安装包检查。安装包检查从 tgz 解压运行，验证持久化、画布接收批次与整轮撤销，不调用模型 API。`DSH_BOARD_BROWSER=chromium` 可指定 Playwright Chromium；默认依次尝试系统 Chrome、Edge、Chromium。Linux 可用 `install --with-deps chromium`。

发布包：

```bash
npm run build
npm pack --pack-destination artifacts
```

贡献前阅读 [AGENTS.md](AGENTS.md) 和 [规格](docs/spec.md)。涉及宿主接口的变化仍需在实际 DSH 中联调，不能只用合成宿主检查宣称兼容。布局呈现的本机组件联调可设置 `DSH_BOARD_NATIVE_ROOT` 为已安装 DSH 包下的 `node_modules`，执行 `node scripts/smoke-native-layout.mjs`：只读取本机前端源码，用真实 SlotCore 和 Chat 渲染器验证合成历史的折叠／展开，不读取个人会话或凭据、不调用模型 API。

## 来源与许可

本项目采用 [MIT License](LICENSE)。插件最初位于 draft-board 的 `plugins/dsh-board/`，从提交 `c37c6fe` 拆出。

白板界面和纯模型来自锁定的 draft-board，安装包保留其许可证及来源。构建会收集所嵌入运行依赖的许可证，写入 `lib/THIRD_PARTY_NOTICES.txt`；包含 React、KaTeX、markdown-it、fflate、nanoid 等依赖的声明。DSH 本体由使用者单独安装，本插件不打包分发 DSH 源码。
