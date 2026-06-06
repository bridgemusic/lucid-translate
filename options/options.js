// 设置页逻辑：选服务商即自动配置地址/模型，用户只需粘 Key。即时保存。
import {
  getSettings,
  saveSettings,
  clearBlocklist,
  SERVICES,
  getService,
} from "../lib/storage.js";

const $ = (id) => document.getElementById(id);
let settings = null;

init();

async function init() {
  settings = await getSettings();
  populateServices();
  renderService();
  renderMode();
  renderSmartHints();
  bindEvents();
}

function renderSmartHints() {
  $("autoDetect").checked = settings.autoDetect !== false;
}

function populateServices() {
  const sel = $("serviceSelect");
  for (const svc of SERVICES) {
    sel.add(new Option(svc.name, svc.id));
  }
}

// 取当前服务商已保存的配置（含解析后的默认值）。
function currentConfig() {
  const svc = getService(settings.service);
  const saved = settings.serviceConfigs[settings.service] || {};
  return {
    svc,
    apiKey: saved.apiKey || "",
    model: saved.model || svc.model || "",
    baseUrl: saved.baseUrl || svc.baseUrl || "",
  };
}

function renderService() {
  const { svc, apiKey, model, baseUrl } = currentConfig();
  $("serviceSelect").value = settings.service;
  $("serviceHint").textContent = svc.hint || "";

  $("apiKey").value = apiKey;
  $("model").value = model;
  $("baseUrl").value = baseUrl;

  // 获取 Key 的官网链接
  const link = $("keyLink");
  if (svc.keyUrl) {
    link.href = svc.keyUrl;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }

  // Base URL 仅在「自定义」时显示（其它服务商已自动配置好，不打扰用户）。
  $("baseUrlField").style.display = svc.custom ? "" : "none";

  // 测试结果清空
  $("testResult").textContent = "";
  $("testResult").className = "test-result";
}

function renderMode() {
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === settings.displayMode;
  });
}

function bindEvents() {
  // 切换服务商
  $("serviceSelect").addEventListener("change", async (e) => {
    settings.service = e.target.value;
    await saveSettings({ service: settings.service });
    renderService();
    flashSaved();
  });

  // Key / model / baseUrl 即时保存（按服务商分别存）。
  $("apiKey").addEventListener("input", () => persistField("apiKey", $("apiKey").value));
  $("model").addEventListener("input", () => persistField("model", $("model").value));
  $("baseUrl").addEventListener("input", () => persistField("baseUrl", $("baseUrl").value));

  // 显示 / 隐藏 key
  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "隐藏" : "显示";
  });

  // 呈现模式
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener("change", async () => {
      if (!r.checked) return;
      settings.displayMode = r.value;
      await saveSettings({ displayMode: r.value });
      flashSaved();
    });
  });

  // 自动提示开关
  $("autoDetect").addEventListener("change", async (e) => {
    settings.autoDetect = e.target.checked;
    await saveSettings({ autoDetect: settings.autoDetect });
    flashSaved();
  });

  // 恢复所有网站的提示（清空黑名单）
  $("clearBlocklist").addEventListener("click", async () => {
    await clearBlocklist();
    const r = $("clearResult");
    r.textContent = "已恢复，所有网站将重新提示";
    setTimeout(() => (r.textContent = ""), 2400);
  });

  $("testBtn").addEventListener("click", testConnection);
}

let saveTimer = null;
function persistField(key, value) {
  const id = settings.service;
  if (!settings.serviceConfigs[id]) settings.serviceConfigs[id] = {};
  settings.serviceConfigs[id][key] = value.trim();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings({ serviceConfigs: settings.serviceConfigs });
    flashSaved();
  }, 400);
}

async function testConnection() {
  const result = $("testResult");
  const btn = $("testBtn");
  result.className = "test-result testing";
  result.textContent = "测试中…";
  btn.disabled = true;

  const { svc } = currentConfig();
  // 用表单里的草稿配置测试（无需先保存）。
  const config = {
    provider: svc.protocol,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || svc.model,
    baseUrl: $("baseUrl").value.trim() || svc.baseUrl,
  };

  if (!config.apiKey) {
    result.className = "test-result fail";
    result.textContent = "请先填入 API Key";
    btn.disabled = false;
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: "testConnection", config });
    if (resp && resp.ok) {
      result.className = "test-result ok";
      result.textContent = `连接成功（Hello → ${resp.sample}）`;
    } else {
      result.className = "test-result fail";
      result.textContent = "失败：" + friendlyError(resp ? resp.error : "未知错误");
    }
  } catch (err) {
    result.className = "test-result fail";
    result.textContent = "失败：" + friendlyError(String(err));
  } finally {
    btn.disabled = false;
  }
}

function friendlyError(msg) {
  if (!msg) return "未知错误";
  if (msg.includes("401") || msg.includes("403")) return "API Key 无效或无权限";
  if (msg.includes("404")) return "模型名称或接口地址不正确";
  if (msg.includes("429")) return "请求过于频繁或额度不足";
  if (msg.includes("NO_API_KEY")) return "尚未填入 API Key";
  if (msg.toLowerCase().includes("failed to fetch")) return "网络错误或接口地址不可达";
  return msg.slice(0, 120);
}

function flashSaved() {
  const el = $("savedIndicator");
  el.classList.add("show");
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => el.classList.remove("show"), 1200);
}
