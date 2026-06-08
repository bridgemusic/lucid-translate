# 交接说明书 · Lucid Translate

> 给接手本项目的 AI agent。读完这份你就能安全地继续开发。先读这份，再读 [README.md](./README.md)。

## 1. 这是什么

一个**极简的 Chrome 网页翻译插件**（Manifest V3）：一键把当前网页全部文字**原地翻译**成用户母语。用户**自带 LLM API Key**（DeepSeek/Kimi/智谱/通义/OpenAI/Claude/Gemini）。

**技术栈刻意选择**：原生 HTML/CSS/JS，**零依赖、零构建**。产品代码不含任何 npm 运行时依赖，clone 即可在 `chrome://extensions` 加载。jsdom 仅是测试用的 devDependency。

GitHub：https://github.com/bridgemusic/lucid-translate · 当前版本 v1.0。

## 2. 产品哲学（最重要，违背它的改动基本都是错的）

像苹果产品一样：**极简、稳定、优雅、克制**。以**用户体验**取胜，不是堆功能。

- **第一性目标 = 网站可适配性**：用户因 Google 翻译"在很多网站点了没反应"而做这个。无论 SPA、Shadow DOM、同源 iframe，正文都要稳定翻出来。这是核心竞争力，任何改动不能损害它。
- **表面极简，背后把脏活全干了**：UI 上只有"选语言 + 一个按钮 + 设置入口"，但内部做了大量稳定性工作（标签保护、id 回填、重试、防循环）。
- **刻意不做**（除非用户明确要求，否则不要加）：多翻译引擎、PDF/视频字幕、划词翻译、快捷键、按语言的细粒度规则、翻译缓存。**加功能前先问用户**——这个项目的默认答案是"不加"。
- **克制 = 不打扰**：自动弹窗、自动续翻这些"主动服务"都做了严格的退出/记忆机制，绝不烦人、绝不擅自烧用户 API 额度。

## 3. 架构（四个运行环境）

| 环境 | 文件 | 职责 |
|------|------|------|
| **Popup** | `popup/*` | 主面板：选源/目标语言、翻译/还原按钮、设置入口、进度 |
| **Options** | `options/*` | 设置页：选服务商（自动配地址/模型）、API Key、呈现模式、智能提示开关 |
| **Content** | `content/content.js` `content/content.css` | 注入页面：DOM 块切分、懒翻译、流式渲染、还原、自动提示弹窗 |
| **Background** | `background.js` | service worker：**唯一对外发请求处**、调 LLM、右键菜单、会话状态 |

**关键安全约束**：**API Key 只在 background 读取与使用，绝不下发到页面世界（content）**。content 通过 `chrome.runtime.sendMessage` 请求翻译，background 才接触 key。改动时务必维持这条边界。

`lib/` 下是共享逻辑：
- `dom-walker.js` — 块级切分、Shadow DOM/iframe 穿透、skip 规则（**最易出 bug 的地方**）
- `inline-tags.js` — 内联标签保护（`<a>/<code>/<img>` 翻译不被破坏）
- `batch-queue.js` — 批处理、按 id 回填、指数退避重试
- `observers.js` — IntersectionObserver 懒翻译 + MutationObserver 增量 + 防自我循环
- `providers.js` — 三种协议 adapter（OpenAI 兼容/Claude/Gemini）+ 结构化输出
- `storage.js` — chrome.storage 封装、服务商目录 `SERVICES`、blocklist helper
- `languages.js` — 语言列表与名称映射

**注意**：`lib/inline-tags.js`、`dom-walker.js`、`batch-queue.js`、`observers.js` 是以普通 content script 注入的 **IIFE**，挂在 `window.LT` 命名空间（**不是** ES module）。而 `storage.js`、`providers.js`、`languages.js` 是 **ES module**（被 background/popup/options import）。改动时别搞混两种模块形态。

## 4. 必须知道的"血泪坑"（这些都修过，别让它们回归）

这些都有回归测试守着（见第 5 节）。改 `lib/` 前**务必先跑 `npm test`**，改完再跑。

1. **块切分漏翻**：标题文字常包在 `<a>` 里（`<h3><a>标题</a></h3>`）；栏目标签是游离内联（`<div><a>SCIENCE</a><h3>..</h3></div>`）。`dom-walker.js` 的 `isLeafBlock`/`isOrphanInline` 专门处理这些。
2. **重复收集**：`<a><h2>标题</h2></a>` 外层 `<a>` 和内层 `<h2>` 不能都收集，否则同一文字翻两次、双语模式插两份。`isOrphanInline` 里有 `containsBlock` 排除。
3. **图片重复**：双语模式插"译文副本"时，`<img>` 等替换型元素不能克隆进副本（`applyTranslation(..., {stripReplaced:true})`）。`<img>` 也不能被当块级子元素（`REPLACED_TAGS`）。
4. **译文错位**：批处理结果**必须按 id 回填，绝不按顺序**。
5. **慢 + 偶发失败同源**：无重试是主因。`batch-queue.js` 有指数退避重试、部分缺失只补缺失段、鉴权错误不重试。
6. **SPA 死循环**：自己注入的译文会触发 MutationObserver → 用 WeakSet 标记跳过（`observers.js` 的 `skipMoNodes`）。
7. **整页跳转断翻**：普通链接跳转会重载整页、销毁 content script。用 `chrome.storage.session` 记住"本会话续翻的域名"，新页面查 `shouldAutoTranslate` 自动续翻（同域、点还原即停）。

## 5. 测试（改代码前后都要跑）

```bash
npm install   # 首次：装 jsdom（仅测试用）
npm test      # 运行全部回归测试，当前 41 例
```

- 测试用 Node 内置 `node --test` + jsdom，在 `test/` 下。
- `test/helpers.js` 用 jsdom 还原 Chrome content script 环境（IIFE 库加载到 `window.LT`），测的是真实运行路径。
- **铁律：改了 `lib/` 的切分/标签/批处理逻辑，必须先跑 `npm test` 确认不回归。这个项目反复出现过"修 A 坏 B"，测试是唯一的安全网。** 新增/改动这类逻辑时，请同步补测试。

## 6. 如何本地验证（测试之外的真机验证）

1. `chrome://extensions` → 开启开发者模式 → "加载已解压的扩展程序" → 选项目根目录。
2. **改了代码后必须点插件卡片的刷新 🔄 重载**，且**目标网页要 `Cmd/Ctrl+R` 刷新**（content script 才会更新）。
3. 设置页填一个真实 API Key（DeepSeek 最易获取）→ "测试连接"应成功。
4. 重点验证网站适配性：普通英文网页、SPA（如 React 文档站）、含 Shadow DOM 的站点。
5. 无图形环境时，可用 headless Chrome 渲染 popup/options/toast 截图做视觉验证（历史上这么做过）。

## 7. 工作方式约定（沿用至今，请继续）

- **改动前若涉及多文件或产品决策，先用计划/提问跟用户对齐**，不要擅自扩大范围。
- **加功能前先问"这是否违背极简"**；用户多次明确表达过"不堆功能、不烧额度"。
- **每个改动配回归测试**；提交信息写清根因与修复（中文，看 git log 的风格）。
- 提交规范：在 main 分支工作；commit message 末尾带 `Co-Authored-By` 行（看现有 git log）。**只在用户要求时才 commit/push。**
- 用户环境 **WebSearch 不可用**，需联网用 `~/.claude/tools/websearch`（见用户全局 CLAUDE.md）。

## 8. 当前状态与可能的下一步

- v1.0 已上线，功能完整、41 测试全过、工作区干净、已推送 GitHub。
- 用户尚未确定下一步。讨论过但**暂缓**的：翻译缓存（判断为现阶段性价比不高）。曾提过的候选：快捷键翻译、失败段一键重试。**这些都需用户拍板后再做，不要自作主张。**
- 尚未上架 Chrome Web Store（README 有上架路径说明）。

---
有疑问先读对应源文件 + 跑测试，多数行为测试里都有例子。保持克制，祝顺利。
