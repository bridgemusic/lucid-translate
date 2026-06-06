// 语言列表与名称映射。
// 同时被 popup（ES module 引入）和 content（通过 window.LT 命名空间）使用，
// 因此这里既做 ESM 导出，也在非 module 环境下挂到全局 LT 上。

export const LANGUAGES = [
  { code: "auto", zh: "自动检测", en: "Auto-detect" },
  { code: "en", zh: "英语", en: "English" },
  { code: "zh-Hans", zh: "简体中文", en: "Chinese (Simplified)" },
  { code: "zh-Hant", zh: "繁体中文", en: "Chinese (Traditional)" },
  { code: "ja", zh: "日语", en: "Japanese" },
  { code: "ko", zh: "韩语", en: "Korean" },
  { code: "fr", zh: "法语", en: "French" },
  { code: "de", zh: "德语", en: "German" },
  { code: "es", zh: "西班牙语", en: "Spanish" },
  { code: "pt", zh: "葡萄牙语", en: "Portuguese" },
  { code: "ru", zh: "俄语", en: "Russian" },
  { code: "it", zh: "意大利语", en: "Italian" },
  { code: "ar", zh: "阿拉伯语", en: "Arabic" },
  { code: "hi", zh: "印地语", en: "Hindi" },
  { code: "th", zh: "泰语", en: "Thai" },
  { code: "vi", zh: "越南语", en: "Vietnamese" },
];

// 用于翻译提示词的英文全称（LLM 对英文语言名最稳）。
export const PROMPT_NAME = {
  en: "English",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  ru: "Russian",
  it: "Italian",
  ar: "Arabic",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
};

// chrome.i18n.detectLanguage 返回的码（如 "zh-CN"）归一到我们的码。
export function normalizeDetected(code) {
  if (!code) return null;
  const lower = code.toLowerCase();
  if (lower.startsWith("zh")) {
    return lower.includes("tw") || lower.includes("hant") ? "zh-Hant" : "zh-Hans";
  }
  // 取主语言段：en-US -> en
  return lower.split("-")[0];
}

export function displayName(code, uiLang = "zh") {
  const item = LANGUAGES.find((l) => l.code === code);
  if (!item) return code;
  return uiLang === "zh" ? item.zh : item.en;
}
