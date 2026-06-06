<div align="center">

# 译 · Lucid Translate

**一键翻译整页网页。极简、稳定、优雅。**

自带你自己的 LLM API Key（OpenAI / Claude / Gemini），翻译能力完全由你掌控。

</div>

---

## 这是什么

一个只做好一件事的 Chrome 翻译插件：**把当前网页的所有文字一键翻译成你的母语**，原地呈现，让网页读起来就像母语网站。

它不是又一把"翻译瑞士军刀"。没有 PDF、没有视频字幕、没有划词、没有十几个引擎、没有复杂的规则系统。它只靠两件事取胜：

- **稳定的网站适配性** —— 无论网页是否动态加载（React/Vue 等 SPA）、是否使用 Shadow DOM 组件、是否含同源 iframe，正文都能被稳定翻译出来。这正是许多翻译插件"点了没反应"的地方。
- **极简优雅的体验** —— 一个开关、两个语言下拉、一个设置入口。每一步都最简单、最无脑。

## 核心特性

- **一键整页翻译**，原地呈现，再次点击即可还原。
- **双语对照 / 原地替换** 两种模式可切换（默认双语对照，最可靠）。
- **滚动懒翻译** —— 只翻译进入视口的内容，首屏秒出，不浪费 API 额度。
- **逐段流式渲染** —— 哪段先翻好哪段先显示，单段失败可点击重试。
- **自动提示** —— 打开匹配源语言的网页时，右上角轻提示一下，点一下即可翻译（本地检测、不耗 API；点 × 则该站不再提示）。
- **右键翻译** —— 任意网页右键即可「翻译此页 / 还原原文」，文案随状态切换。
- **自带 API Key** —— 内置 DeepSeek、Kimi、智谱 GLM、通义千问、OpenAI、Claude、Gemini，选服务商即自动配置地址与模型；也支持任意 OpenAI 兼容接口（自定义 Base URL）。
- **隐私优先** —— API Key 只存在本地、只在后台使用，绝不进入网页、绝不上传第三方。

## 安装

### 正式安装（推荐）

> 🚧 即将上架 Chrome 应用商店。届时可像安装任何插件一样，一键"添加至 Chrome"，自动更新，无需开发者模式。

### 开发 / 尝鲜安装

1. 下载或 `git clone` 本仓库。
2. 打开 Chrome，访问 `chrome://extensions`。
3. 打开右上角的 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择本项目文件夹。
5. 完成。点击工具栏的"译"图标即可使用。

## 配置（首次使用）

1. 首次安装会自动打开设置页（也可点插件面板右上角的齿轮进入）。
2. 从 **服务商** 下拉里选一家（如 **DeepSeek**）—— 接口地址和推荐模型会自动填好。
3. 点设置页里的「→ 前往该服务官网获取 API Key」链接拿到 Key，粘进 **API Key** 框。
4. 点击 **测试连接** 确认可用。
5. 回到任意网页，点击插件图标 → **翻译此页**。

> **国产模型同样支持**（它们都兼容 OpenAI 接口，选对应服务商即可，无需手填地址）：
> | 服务商 | 获取 Key | 推荐模型 |
> |--------|----------|----------|
> | DeepSeek 深度求索 | https://platform.deepseek.com/api_keys | `deepseek-chat` |
> | Kimi 月之暗面 | https://platform.moonshot.cn/console/api-keys | `moonshot-v1-8k` |
> | 智谱 GLM | https://open.bigmodel.cn/usercenter/apikeys | `glm-4-flash` |
> | 通义千问 Qwen | https://bailian.console.aliyun.com | `qwen-turbo` |
> | OpenAI | https://platform.openai.com/api-keys | `gpt-4o-mini` |
> | Claude | https://console.anthropic.com/settings/keys | `claude-haiku-4-5` |
> | Gemini | https://aistudio.google.com/apikey | `gemini-2.0-flash` |
>
> 想用上表之外的服务？选「**自定义（OpenAI 兼容）**」，手动填接口地址与模型即可。
> 注：自定义地址若指向上述域名之外的站点，需在 `manifest.json` 的 `host_permissions` 增加该域名。

## 工作原理

```
Popup（主面板）          Options（设置页）
   选语言/触发              绑定 API Key
       │                        │
       └──────── chrome.runtime ────────┐
                                        ▼
Content Script（页面内）         Background（service worker）
  · DOM 块级切分                  · 唯一对外发请求处
  · Shadow DOM / iframe 穿透      · 调用 LLM（结构化输出）
  · 懒翻译 + SPA 增量监听          · API Key 只在此读取
  · 内联标签保护 + 流式渲染         · 批处理编排
```

设计要点：

- **API Key 隔离**：Key 只在 background 读取与使用，永不下发到网页世界，降低泄露面。
- **内联标签保护**：翻译前把 `<a> <code> <img>` 等序列化为占位符/轻量标记，翻译后精确还原，绝不破坏链接和格式。
- **按 id 回填**：批量翻译的结果严格按段落 id 对齐回填，长页面也不会错位串行。
- **结构化输出**：三家 LLM 均使用各自的原生结构化输出（JSON Schema / tool），返回格式强约束，更稳。
- **防自我循环**：注入的译文节点被 `WeakSet` 标记，MutationObserver 跳过它们，动态网页不会无限翻译。

## 支持范围

✅ 支持：普通 HTML 网页、SPA 单页应用（动态内容 + 路由切换）、open Shadow DOM、同源 iframe。

❌ 暂不支持（刻意保持极简，"明确不支持"好过"做不稳"）：PDF、视频字幕、closed Shadow DOM、跨源 iframe。

## 上架 Chrome 应用商店（维护者参考）

本项目为原生 JS、零构建，浏览器可直接运行，因此打包即上传、无需编译：

1. 将项目文件夹打包为 zip（排除 `.git`、文档等）。
2. 注册 [Chrome 开发者账号](https://chrome.google.com/webstore/devconsole)（一次性 $5，Google 收取）。
3. 在开发者后台上传 zip、填写商店信息与截图、提交审核（通常数日内通过）。

## 技术栈

原生 HTML / CSS / JavaScript + Manifest V3。**零依赖、零构建** —— clone 即用，代码透明可读。

## 开发与测试

产品本身零依赖；核心逻辑（DOM 块切分、内联标签保护、批处理重试）有回归测试，用 Node 内置测试运行器 + jsdom（仅开发期依赖，不打包进扩展）：

```bash
npm install   # 安装 jsdom（devDependency）
npm test      # 运行全部回归测试
```

改动 `lib/` 下的切分/翻译/批处理逻辑后，请先跑 `npm test`，避免回退已修复的边界（链接内标题、游离栏目标签、图文混排、译文不错位、失败重试等）。

## License

[MIT](./LICENSE)
