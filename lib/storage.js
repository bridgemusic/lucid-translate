// chrome.storage.local 的薄封装 + 默认值 + 服务商目录。
// 全部存 local 而非 sync：API key 不应跨设备同步，降低泄露面。

// 服务商目录。国产模型大多兼容 OpenAI 接口，这里内置好协议/地址/模型/获取Key链接，
// 用户在设置页只需「选服务商 + 粘 Key」，无需理解 Base URL 等概念。
//   protocol: 底层请求协议（providers.js 的三个 adapter 之一）
//   baseUrl : 该服务商的接口地址（OpenAI 协议各家不同；官方 OpenAI 留空走默认）
//   model   : 默认推荐模型
//   keyUrl  : 获取 API Key 的官网页面
//   custom  : 是否允许用户自定义 Base URL（兼容未列出的服务）
export const SERVICES = [
  {
    id: "deepseek",
    name: "DeepSeek 深度求索",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
    hint: "国产，便宜稳定，推荐新手起步。",
  },
  {
    id: "kimi",
    name: "Kimi 月之暗面",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    hint: "国产，长文本能力强。",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    hint: "国产，glm-4-flash 免费额度友好。",
  },
  {
    id: "qwen",
    name: "通义千问 Qwen",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-turbo",
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    hint: "国产，阿里云百炼平台。",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "", // 留空走官方 https://api.openai.com
    model: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    hint: "需要海外网络环境。",
  },
  {
    id: "claude",
    name: "Claude（Anthropic）",
    protocol: "claude",
    baseUrl: "",
    model: "claude-haiku-4-5-20251001",
    keyUrl: "https://console.anthropic.com/settings/keys",
    hint: "翻译质量高，需要海外网络环境。",
  },
  {
    id: "gemini",
    name: "Gemini（Google）",
    protocol: "gemini",
    baseUrl: "",
    model: "gemini-2.0-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    hint: "免费额度友好，需要海外网络环境。",
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    protocol: "openai",
    baseUrl: "",
    model: "",
    keyUrl: "",
    custom: true,
    hint: "任何兼容 OpenAI 接口的服务，手动填写地址与模型。",
  },
];

export function getService(id) {
  return SERVICES.find((s) => s.id === id) || SERVICES[0];
}

const DEFAULTS = {
  // 当前选中的服务商 id（见 SERVICES）
  service: "deepseek",
  // 按服务商分别存储的配置：{ [serviceId]: { apiKey, model, baseUrl } }
  // model/baseUrl 留空则回退到服务商目录里的默认值。
  serviceConfigs: {},

  // 翻译偏好
  sourceLang: "en",
  targetLang: "zh-Hans",
  displayMode: "bilingual", // "bilingual" 双语对照（默认） | "replace" 原地替换

  // 站点黑名单（域名，命中则不自动检测/提示）
  blocklist: [],
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return {
    ...DEFAULTS,
    ...stored,
    serviceConfigs: { ...DEFAULTS.serviceConfigs, ...(stored.serviceConfigs || {}) },
  };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

// 返回当前服务商的有效配置（解析默认值后的 protocol/key/model/baseUrl）。
export async function getActiveProviderConfig() {
  const s = await getSettings();
  const svc = getService(s.service);
  const cfg = s.serviceConfigs[s.service] || {};
  return {
    service: svc.id,
    provider: svc.protocol, // providers.js 按 protocol 选 adapter
    apiKey: (cfg.apiKey || "").trim(),
    model: (cfg.model || svc.model || "").trim(),
    baseUrl: (cfg.baseUrl || svc.baseUrl || "").trim(),
  };
}

export { DEFAULTS };
