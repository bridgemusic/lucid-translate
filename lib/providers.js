// LLM provider 适配。被 background（service worker，ES module）引入。
// 统一接口：translate({ segments, sourceLang, targetLang, config, context }) -> {id, text}[]
//
// 三家都用原生结构化输出强约束返回格式（只接 3 家的天然优势）：
//   OpenAI  : response_format json_schema
//   Gemini  : responseSchema + responseMimeType
//   Claude  : tool_choice 强制调用一个固定 schema 的工具

import { PROMPT_NAME } from "./languages.js";

// segments: [{id, text}]，text 含 <wN>…</wN> 内联标记与 #N# 占位符。
function buildSystemPrompt(sourceLang, targetLang) {
  const src = PROMPT_NAME[sourceLang] || sourceLang || "the source language";
  const tgt = PROMPT_NAME[targetLang] || targetLang;
  return [
    `You are a professional translation engine. Translate each segment's text into ${tgt}.`,
    sourceLang && sourceLang !== "auto" ? `The source text is in ${src}.` : "",
    "STRICT RULES:",
    `1. Return EVERY input segment with its EXACT same "id". Keep the count and order.`,
    `2. Preserve ALL inline markup tags like <w0>...</w0> exactly as they appear — translate only the text inside them, never alter, drop, or renumber the tags.`,
    `3. Keep placeholder tokens like #0# #1# verbatim. They are protected content (code, images). Never translate or move them out of place.`,
    `4. Preserve leading/trailing whitespace of each segment.`,
    `5. Output translation only — no explanations, no added punctuation, no markdown.`,
    `6. If a segment is a proper noun, brand, or code identifier that should not be translated, return it unchanged.`,
    "",
    `OUTPUT FORMAT: Return ONLY a JSON object of the exact shape:`,
    `{"translations":[{"id":<same id>,"text":"<translated text>"}, ...]}`,
    `No markdown code fences, no commentary — just the raw JSON object.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// 统一的输出 JSON Schema：{ translations: [{id, text}] }
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

function userPayload(segments) {
  return JSON.stringify({ segments });
}

async function fetchJson(url, options, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return JSON.parse(body);
  } finally {
    clearTimeout(t);
  }
}

// 把任意来源的 translations 数组校验/归一为 [{id:Number, text:String}]
function normalizeTranslations(arr) {
  if (!Array.isArray(arr)) throw new Error("translations is not an array");
  return arr
    .filter((x) => x && (typeof x.id === "number" || typeof x.id === "string"))
    .map((x) => ({ id: Number(x.id), text: String(x.text ?? "") }));
}

// 宽松 JSON 解析：部分模型即便被要求纯 JSON，仍可能包 ```json 围栏或前后多余文字。
// 先直接 parse，失败则剥离围栏 / 截取首个 {…} 再试。
function parseLooseJson(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    /* fall through */
  }
  let s = str.trim();
  // 去掉 ```json ... ``` 围栏
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(s);
  } catch (_) {
    /* fall through */
  }
  // 截取首个 { 到最后一个 } 之间的内容
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(s.slice(first, last + 1));
  }
  throw new Error("Cannot parse JSON from model response");
}

// 智能拼接 OpenAI 兼容接口地址。各家 Base URL 格式不统一：
//   Kimi  https://api.moonshot.cn/v1          （已含 /v1）
//   智谱  https://open.bigmodel.cn/api/paas/v4 （已含 /v4）
//   通义  .../compatible-mode/v1               （已含 /v1）
//   DeepSeek/官方 OpenAI                        （不含版本段）
// 已含 /vN 段则直接补 /chat/completions，否则补 /v1/chat/completions，避免拼出 /v1/v1/。
function openaiEndpoint(base) {
  const clean = base.replace(/\/$/, "");
  if (/\/v\d+$/.test(clean)) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

// ———————————————————— OpenAI（兼容接口） ————————————————————
async function openaiTranslate({ segments, sourceLang, targetLang, config }) {
  const base = config.baseUrl || "https://api.openai.com";
  const url = openaiEndpoint(base);
  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    // 用最通用的 json_object 而非 json_schema：国产兼容接口（DeepSeek/Kimi/智谱/通义）
    // 大多支持 json_object，但未必支持较新的 json_schema。输出结构由 prompt 约束。
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: "system", content: buildSystemPrompt(sourceLang, targetLang) },
        { role: "user", content: userPayload(segments) },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const content = data?.choices?.[0]?.message?.content || "{}";
  return normalizeTranslations(parseLooseJson(content).translations);
}

// ———————————————————— Anthropic Claude ————————————————————
async function claudeTranslate({ segments, sourceLang, targetLang, config }) {
  const base = (config.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const url = `${base}/v1/messages`;
  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 8192,
      temperature: 0,
      system: buildSystemPrompt(sourceLang, targetLang),
      tool_choice: { type: "tool", name: "return_translations" },
      tools: [
        {
          name: "return_translations",
          description: "Return the translated segments.",
          input_schema: OUTPUT_SCHEMA,
        },
      ],
      messages: [{ role: "user", content: userPayload(segments) }],
    }),
  });
  const toolUse = (data?.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return tool_use");
  return normalizeTranslations(toolUse.input.translations);
}

// ———————————————————— Google Gemini ————————————————————
async function geminiTranslate({ segments, sourceLang, targetLang, config }) {
  const base = (config.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const url = `${base}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${config.apiKey}`;
  // Gemini 的 responseSchema 不支持 additionalProperties，需用裁剪版。
  const geminiSchema = {
    type: "object",
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "integer" }, text: { type: "string" } },
          required: ["id", "text"],
        },
      },
    },
    required: ["translations"],
  };
  const data = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt(sourceLang, targetLang) }] },
      contents: [{ role: "user", parts: [{ text: userPayload(segments) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: geminiSchema,
      },
    }),
  });
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return normalizeTranslations(JSON.parse(text).translations);
}

const ADAPTERS = {
  openai: openaiTranslate,
  claude: claudeTranslate,
  gemini: geminiTranslate,
};

export async function translate({ segments, sourceLang, targetLang, config }) {
  const adapter = ADAPTERS[config.provider];
  if (!adapter) throw new Error("Unknown provider: " + config.provider);
  if (!config.apiKey) throw new Error("NO_API_KEY");
  return adapter({ segments, sourceLang, targetLang, config });
}

// 轻量「测试连接」：翻一个固定短语，验证 key/model/endpoint 可用。
export async function testConnection(config) {
  const out = await translate({
    segments: [{ id: 0, text: "Hello" }],
    sourceLang: "en",
    targetLang: "zh-Hans",
    config,
  });
  if (!out.length || !out[0].text) throw new Error("Empty response");
  return out[0].text;
}
