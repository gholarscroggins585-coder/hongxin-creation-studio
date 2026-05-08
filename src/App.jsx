import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { parseFile, fetchUrlContent, isSupportedFile } from "./parsers.js";

/* ═══════════════ AI Config Context ═══════════════ */
const ApiConfigContext = createContext(null);

const MODEL_REGISTRY = [
  { id:"anthropic", name:"Claude (Anthropic)", logo:"C", color:"oklch(0.62 0.15 30)", endpoint:"https://api.anthropic.com/v1/messages", models:["claude-sonnet-4-20250514","claude-haiku-4-5-20251001"], headerKey:"x-api-key", extraHeaders:{"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"} },
  { id:"openai", name:"OpenAI", logo:"GPT", color:"oklch(0.55 0.13 165)", endpoint:"https://api.openai.com/v1/chat/completions", models:["gpt-4o","gpt-4o-mini","gpt-image-1","gpt-image-1.5"], headerKey:"Authorization", authPrefix:"Bearer " },
  { id:"doubao", name:"豆包 (ByteDance)", logo:"豆", color:"oklch(0.7 0.16 230)", endpoint:"https://ark.cn-beijing.volces.com/api/v3/chat/completions", models:["doubao-pro-32k","doubao-lite-32k"], headerKey:"Authorization", authPrefix:"Bearer " },
  { id:"qwen", name:"通义千问 (Alibaba)", logo:"Q", color:"oklch(0.65 0.18 290)", endpoint:"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", models:["qwen-max","qwen-plus","qwen-turbo"], headerKey:"Authorization", authPrefix:"Bearer " },
  { id:"deepseek", name:"DeepSeek", logo:"DS", color:"oklch(0.6 0.14 230)", endpoint:"https://api.deepseek.com/v1/chat/completions", models:["deepseek-chat","deepseek-reasoner"], headerKey:"Authorization", authPrefix:"Bearer " },
  { id:"zhipu", name:"智谱 (GLM)", logo:"智", color:"oklch(0.6 0.18 320)", endpoint:"https://open.bigmodel.cn/api/paas/v4/chat/completions", models:["glm-4-plus","glm-4-flash"], headerKey:"Authorization", authPrefix:"Bearer " },
];
const IMAGE_PROVIDER_IDS = ["openai"];

const SCENE_ROUTES_DEFAULT = [
  { scene:"选题挖掘", primary:"anthropic", model:"claude-sonnet-4-20250514", fallback:"openai" },
  { scene:"Agent验证", primary:"anthropic", model:"claude-sonnet-4-20250514", fallback:"openai" },
  { scene:"笔记文案", primary:"anthropic", model:"claude-sonnet-4-20250514", fallback:"openai" },
  { scene:"图片生成", type:"image", primary:"openai", model:"gpt-image-1.5", fallback:"" },
  { scene:"投流文案", primary:"anthropic", model:"claude-sonnet-4-20250514", fallback:"qwen" },
  { scene:"合规检测", primary:"anthropic", model:"claude-sonnet-4-20250514", fallback:"qwen" },
];

const normalizeRoutes = (storedRoutes) => {
  const stored = Array.isArray(storedRoutes) ? storedRoutes : [];
  return SCENE_ROUTES_DEFAULT.map(def => ({ ...def, ...(stored.find(r => r.scene === def.scene) || {}) }));
};

function useApiConfig() {
  const [keys, setKeys] = useState({});
  const [routes, setRoutes] = useState(SCENE_ROUTES_DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [backendHealth, setBackendHealth] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem("api-config");
        if (raw) { const d = JSON.parse(raw); setKeys(d.keys||{}); setRoutes(normalizeRoutes(d.routes)); }
      } catch(e) { console.log("No stored config yet"); }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    const backend = getBackendBase();
    if (!backend) { setBackendHealth(null); return; }
    (async () => {
      try {
        const headers = {};
        const t = getBackendToken();
        if (t) headers["X-Access-Token"] = t;
        const res = await fetch(`${backend}/health`, { headers });
        if (!res.ok) { setBackendHealth({ ok: false, error: `HTTP ${res.status}` }); return; }
        const data = await res.json();
        setBackendHealth({ ok: true, providers: data.providers || [], accessTokenRequired: !!data.accessTokenRequired });
      } catch (e) {
        setBackendHealth({ ok: false, error: e.message?.slice(0, 80) });
      }
    })();
  }, []);

  const saveKeys = async (newKeys) => {
    setKeys(newKeys);
    try { localStorage.setItem("api-config", JSON.stringify({ keys: newKeys, routes })); } catch(e) { console.error(e); }
  };

  const saveRoutes = async (newRoutes) => {
    setRoutes(newRoutes);
    try { localStorage.setItem("api-config", JSON.stringify({ keys, routes: newRoutes })); } catch(e) { console.error(e); }
  };

  const getStatus = (providerId) => {
    if (backendHealth?.ok && backendHealth.providers?.includes(providerId)) return "已连接";
    const k = keys[providerId];
    if (!k || !k.key) return "未配置";
    if (k.verified) return "已连接";
    return "待验证";
  };

  return { keys, routes, loaded, saveKeys, saveRoutes, getStatus, backendHealth };
}

function getBackendBase() {
  const v = (import.meta.env?.VITE_BACKEND_URL || "").trim();
  return v ? v.replace(/\/$/, "") : "";
}
function getBackendToken() {
  return (import.meta.env?.VITE_BACKEND_TOKEN || "").trim();
}
function isBackendMode() { return !!getBackendBase(); }

function resolveEndpoint(defaultEndpoint, customBase, providerId) {
  // Backend (托管模式) wins over per-provider customBase wins over default.
  const backend = getBackendBase();
  if (backend && providerId) {
    try {
      const u = new URL(defaultEndpoint);
      return `${backend}/${providerId}${u.pathname}`;
    } catch { /* fall through */ }
  }
  if (!customBase || !customBase.trim()) return defaultEndpoint;
  try {
    const u = new URL(defaultEndpoint);
    return customBase.trim().replace(/\/$/, "") + u.pathname;
  } catch { return defaultEndpoint; }
}

async function callAI({ keys, routes, scene, prompt, systemPrompt, maxTokens=1000 }) {
  const route = routes?.find(r => r.scene === scene) || routes?.[0];
  const backend = getBackendBase();
  const providerId = backend
    ? (route?.primary || "anthropic")
    : (keys?.[route?.primary]?.key ? route?.primary : (keys?.[route?.fallback]?.key ? route?.fallback : route?.primary || "anthropic"));
  const provider = MODEL_REGISTRY.find(p => p.id === providerId);
  const apiKey = keys?.[providerId]?.key;
  const endpoint = resolveEndpoint(provider?.endpoint, keys?.[providerId]?.baseUrl, providerId);

  if (!provider) throw new Error(`未知厂商：${providerId}`);
  if (!backend && !apiKey) {
    throw new Error(`未配置 ${provider.name} 的 API Key，请到设置中心配置`);
  }

  const model = (providerId === route?.primary || backend) ? (route?.model || provider.models[0]) : provider.models[0];
  const accessToken = getBackendToken();

  if (providerId === "anthropic") {
    const headers = { "Content-Type": "application/json" };
    if (backend) {
      if (accessToken) headers["X-Access-Token"] = accessToken;
    } else {
      headers[provider.headerKey] = apiKey;
      Object.assign(headers, provider.extraHeaders || {});
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(systemPrompt ? { system: systemPrompt } : {}), messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) { const e = await res.text(); throw new Error(`Anthropic API 错误 (${res.status}): ${e.slice(0,200)}`); }
    const data = await res.json();
    return data.content?.map(c => c.text || "").join("") || "";
  } else {
    const msgs = [];
    if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
    msgs.push({ role: "user", content: prompt });
    const headers = { "Content-Type": "application/json" };
    if (backend) {
      if (accessToken) headers["X-Access-Token"] = accessToken;
    } else {
      headers[provider.headerKey] = (provider.authPrefix || "") + apiKey;
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: msgs })
    });
    if (!res.ok) { const e = await res.text(); throw new Error(`${provider.name} API 错误 (${res.status}): ${e.slice(0,200)}`); }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
}

async function testApiKey(providerId, apiKey, baseUrl) {
  const provider = MODEL_REGISTRY.find(p => p.id === providerId);
  if (!provider) throw new Error("Unknown provider");
  const testKeys = { [providerId]: { key: apiKey, baseUrl } };
  const textModel = provider.models.find(m => !m.includes("image")) || provider.models[0];
  const testRoutes = [{ scene: "test", primary: providerId, model: textModel }];
  return await callAI({ keys: testKeys, routes: testRoutes, scene: "test", prompt: "Say OK", maxTokens: 10 });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resolveImageRoute(keys, routes) {
  const route = routes?.find(r => r.scene === "图片生成") || SCENE_ROUTES_DEFAULT.find(r => r.scene === "图片生成");
  const backend = getBackendBase();
  const providerId = backend
    ? (route?.primary || "openai")
    : (keys?.[route?.primary]?.key ? route.primary : (keys?.[route?.fallback]?.key ? route.fallback : route?.primary || "openai"));
  const provider = MODEL_REGISTRY.find(p => p.id === providerId);
  const apiKey = keys?.[providerId]?.key;
  return { route, providerId, provider, apiKey };
}

const OPENAI_IMAGE_GEN = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_EDIT = "https://api.openai.com/v1/images/edits";

function buildImageHeaders(apiKey) {
  const backend = getBackendBase();
  const headers = { "Content-Type": "application/json" };
  if (backend) {
    const t = getBackendToken();
    if (t) headers["X-Access-Token"] = t;
  } else {
    headers["Authorization"] = "Bearer " + apiKey;
  }
  return headers;
}

async function callImageGen({ keys, routes, prompt, model, size="768x1024", quality="low", n=1 }) {
  const { route, providerId, provider, apiKey } = resolveImageRoute(keys, routes);
  const backend = getBackendBase();

  if (providerId !== "openai") throw new Error("当前图片生成接口仅支持 OpenAI，请在场景路由中将「图片生成」设为 OpenAI / gpt-image-1.5");
  if (!backend && !apiKey) throw new Error("未配置 OpenAI API Key，请到设置中心配置后使用图片生成");
  const imageModel = model || route?.model || provider?.models?.find(m => m.includes("image")) || "gpt-image-1.5";
  const endpoint = resolveEndpoint(OPENAI_IMAGE_GEN, keys?.openai?.baseUrl, "openai");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: buildImageHeaders(apiKey),
    body: JSON.stringify({ model: imageModel, prompt, size, quality, n, output_format: "png" })
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`OpenAI Image API 错误 (${res.status}): ${e.slice(0,200)}`); }
  const data = await res.json();
  return (data.data || []).map(img => img.b64_json ? `data:image/png;base64,${img.b64_json}` : img.url);
}

async function callImageEdit({ keys, routes, prompt, images, model, size="768x1024", quality="low", inputFidelity="high" }) {
  const { route, providerId, provider, apiKey } = resolveImageRoute(keys, routes);
  const backend = getBackendBase();

  if (providerId !== "openai") throw new Error("当前图片编辑接口仅支持 OpenAI，请在场景路由中将「图片生成」设为 OpenAI / gpt-image-1.5");
  if (!backend && !apiKey) throw new Error("未配置 OpenAI API Key，请到设置中心配置后使用图片编辑");
  const imageModel = model || route?.model || provider?.models?.find(m => m.includes("image")) || "gpt-image-1.5";
  const endpoint = resolveEndpoint(OPENAI_IMAGE_EDIT, keys?.openai?.baseUrl, "openai");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: buildImageHeaders(apiKey),
    body: JSON.stringify({
      model: imageModel,
      prompt,
      images: images.map(image_url => ({ image_url })),
      size,
      quality,
      input_fidelity: inputFidelity,
      output_format: "png"
    })
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`OpenAI Image Edit API 错误 (${res.status}): ${e.slice(0,200)}`); }
  const data = await res.json();
  return (data.data || []).map(img => img.b64_json ? `data:image/png;base64,${img.b64_json}` : img.url);
}

/* ═══════════════ Design Tokens ═══════════════ */
const TOKENS = {
  brand: [0.68, 0.18, 25],
  fonts: {
    sans: '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
};

/* ═══════════════ Icons ═══════════════ */
const Ic = ({ d, size = 16, children, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {d ? <path d={d} /> : children}
  </svg>
);
const I = {
  Home: (p) => <Ic {...p}><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></Ic>,
  Spark: (p) => <Ic {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></Ic>,
  Megaphone: (p) => <Ic {...p}><path d="M3 11v2a2 2 0 0 0 2 2h1l3 5h2l-1-5h2l8 4V4l-8 4H5a2 2 0 0 0-2 2z"/></Ic>,
  Library: (p) => <Ic {...p}><rect x="3" y="4" width="4" height="16" rx="1"/><rect x="9" y="4" width="4" height="16" rx="1"/><path d="m17 5 3 14"/></Ic>,
  Settings: (p) => <Ic {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></Ic>,
  Search: (p) => <Ic {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></Ic>,
  Bell: (p) => <Ic {...p}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></Ic>,
  Help: (p) => <Ic {...p}><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 4M12 17h.01"/></Ic>,
  Plus: (p) => <Ic {...p}><path d="M12 5v14M5 12h14"/></Ic>,
  Arrow: (p) => <Ic {...p}><path d="M5 12h14M13 5l7 7-7 7"/></Ic>,
  Check: (p) => <Ic {...p}><path d="m5 12 5 5L20 7"/></Ic>,
  Star: (p) => <Ic {...p}><path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 9.8l6.5-.9z"/></Ic>,
  Image: (p) => <Ic {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></Ic>,
  Edit: (p) => <Ic {...p}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></Ic>,
  Magic: (p) => <Ic {...p}><path d="m15 4 2 2-9 9-4 1 1-4z"/><path d="M14 5l3 3M19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1zM5 4l.7 2L8 6.7 6 7.4 5.4 9.5 4.7 7.4 2.6 6.7 4.7 6z"/></Ic>,
  Refresh: (p) => <Ic {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></Ic>,
  Trend: (p) => <Ic {...p}><path d="M3 17 9 11l4 4 8-8"/><path d="M14 7h7v7"/></Ic>,
  Eye: (p) => <Ic {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></Ic>,
  Layers: (p) => <Ic {...p}><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/></Ic>,
  Send: (p) => <Ic {...p}><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></Ic>,
  Bolt: (p) => <Ic {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></Ic>,
  Filter: (p) => <Ic {...p}><path d="M3 5h18M6 12h12M10 19h4"/></Ic>,
  More: (p) => <Ic {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></Ic>,
  Close: (p) => <Ic {...p}><path d="M6 6l12 12M18 6 6 18"/></Ic>,
  Download: (p) => <Ic {...p}><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></Ic>,
  Calendar: (p) => <Ic {...p}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></Ic>,
  Users: (p) => <Ic {...p}><circle cx="9" cy="8" r="3.5"/><path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6"/><circle cx="17" cy="8" r="2.5"/><path d="M22 19c0-2.8-2-4.5-4-4.5"/></Ic>,
  Doc: (p) => <Ic {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 14h6M9 17h4"/></Ic>,
  Shield: (p) => <Ic {...p}><path d="M12 3 4 6v6c0 5 4 8 8 9 4-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></Ic>,
  Coin: (p) => <Ic {...p}><circle cx="12" cy="12" r="9"/><path d="M9 9c0-1 1-2 3-2s3 1 3 2-1 1.7-3 2-3 1-3 2 1 2 3 2 3-1 3-2M12 5v2M12 17v2"/></Ic>,
  Target: (p) => <Ic {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></Ic>,
  Tag: (p) => <Ic {...p}><path d="M20 13.5 13.5 20a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 11.7V5a2 2 0 0 1 2-2h6.7a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1-.1 2.9z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/></Ic>,
};

/* ═══════════════ Data ═══════════════ */
const TOPICS = [
  { tag:"母婴", title:"新手妈妈血泪教训｜这5个坑我替你踩过了", score:94, hot:"S+", reads:"12.4w", trend:"up" },
  { tag:"美食", title:"周末摆烂日｜3分钟搞定的快手早餐合集", score:91, hot:"S", reads:"8.7w", trend:"up" },
  { tag:"美妆", title:"30岁前必懂的护肤底层逻辑｜踩坑10年总结", score:89, hot:"S", reads:"6.2w", trend:"flat" },
  { tag:"教育", title:"考编3个月上岸｜我的备考时间表直接抄", score:92, hot:"S", reads:"9.8w", trend:"up" },
  { tag:"3C数码", title:"千元平板怎么选｜我帮你踩完了所有坑", score:88, hot:"A+", reads:"7.3w", trend:"up" },
  { tag:"母婴", title:"宝宝辅食｜吃饭不香的娃这样喂秒变干饭王", score:87, hot:"A+", reads:"5.8w", trend:"up" },
  { tag:"教育", title:"英语零基础逆袭｜30天从哑巴到敢开口", score:86, hot:"A", reads:"5.2w", trend:"up" },
  { tag:"3C数码", title:"2024年最值得入的5款降噪耳机｜实测对比", score:85, hot:"A", reads:"4.1w", trend:"up" },
  { tag:"美妆", title:"黄黑皮姐妹听我的｜这3支口红闭眼入", score:85, hot:"A", reads:"4.1w", trend:"up" },
  { tag:"美食", title:"减脂不挨饿｜上班族能复制的便当方案", score:83, hot:"A", reads:"3.5w", trend:"flat" },
];
const AGENTS_DATA = [
  { id:"topic", name:"爆款选题", role:"Topic Hunter", emoji:"🎯", color:"oklch(0.68 0.18 25)", criteria:["热度趋势","共鸣度","搜索量"] },
  { id:"pain", name:"痛点挖掘", role:"Pain Finder", emoji:"💢", color:"oklch(0.7 0.16 290)", criteria:["精准度","代入感","情绪强度"] },
  { id:"struct", name:"文案结构", role:"Copy Architect", emoji:"🧱", color:"oklch(0.74 0.13 230)", criteria:["钩子强度","节奏","信任背书"] },
  { id:"real", name:"真实性", role:"Truth Keeper", emoji:"🔍", color:"oklch(0.78 0.12 165)", criteria:["素人感","细节真实","口语化"] },
  { id:"img", name:"配图策划", role:"Visual Director", emoji:"🎨", color:"oklch(0.82 0.14 75)", criteria:["封面率","视觉锤","信息密度"] },
];
const TASKS = [
  { id:"T-2841", name:"母婴｜新手妈妈血泪教训系列", count:6, status:"running", progress:0.68, agent:"真实性 Agent 检测中", time:"刚刚" },
  { id:"T-2840", name:"美妆｜黄黑皮口红选购指南", count:4, status:"done", progress:1, agent:"已完成 · 4 篇", time:"32 分钟前" },
  { id:"T-2839", name:"聚光投流｜减脂便当训练营", count:8, status:"done", progress:1, agent:"已完成 · 8 张主图", time:"1 小时前" },
  { id:"T-2838", name:"美食｜上班族快手早餐合集", count:5, status:"draft", progress:0.2, agent:"草稿 · 等待生成文案", time:"2 小时前" },
];

/* ═══════════════ Sidebar ═══════════════ */
function Sidebar({ page, setPage }) {
  const items = [
    { group:"工作区", entries:[
      { id:"dash", label:"工作台", icon:<I.Home size={16}/> },
      { id:"feature1", label:"素人爆文生成", icon:<I.Spark size={16}/>, badge:"1" },
      { id:"feature3", label:"聚光投流素材", icon:<I.Megaphone size={16}/> },
      { id:"knowledge", label:"行业知识库", icon:<I.Doc size={16}/> },
    ]},
    { group:"数据", entries:[
      { id:"accounts", label:"账号矩阵", icon:<I.Users size={16}/> },
      { id:"track", label:"赛道分析", icon:<I.Trend size={16}/> },
      { id:"reviewcenter", label:"数据复盘", icon:<I.Target size={16}/> },
    ]},
    { group:"资源", entries:[
      { id:"library", label:"笔记内容库", icon:<I.Library size={16}/> },
      { id:"materials", label:"素材库", icon:<I.Image size={16}/> },
      { id:"settings", label:"设置", icon:<I.Settings size={16}/> },
    ]},
  ];
  return (
    <aside style={S.sidebar}>
      <div style={S.brand}>
        <div style={S.brandMark}>红</div>
        <div>
          <div style={{ fontWeight:700, fontSize:15, letterSpacing:"-0.01em" }}>红芯创作台</div>
          <div style={{ fontSize:11, color:"var(--ink3)", marginTop:1 }}>公考小红书运营中心</div>
        </div>
      </div>
      {items.map(g => (
        <div key={g.group} style={{ marginTop:14 }}>
          <div style={S.navLabel}>{g.group}</div>
          {g.entries.map(it => (
            <button key={it.id} onClick={() => setPage(it.id)}
              style={{...S.navItem, ...(page===it.id ? S.navActive : {})}}>
              <span style={S.navIco}>{it.icon}</span>
              <span>{it.label}</span>
              {it.badge && <span style={S.navBadge}>{it.badge}</span>}
            </button>
          ))}
        </div>
      ))}
      <div style={S.sidebarBottom}>
        <div style={S.teamCard}>
          <div style={{...S.avatar, width:30, height:30}}>公</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:600, fontSize:13 }}>公考新声运营组</div>
            <div style={{ fontSize:11, color:"var(--ink3)" }}>高级版 · 12 席位</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ═══════════════ TopBar ═══════════════ */
const CRUMBS = {
  dash:["工作区","工作台"], feature1:["素人笔记","爆文批量生成"], feature3:["商业化","聚光投流素材"],
  knowledge:["工作区","行业知识库"], accounts:["数据","账号矩阵"],
  track:["数据","赛道分析"], reviewcenter:["数据","数据复盘"], library:["资源","笔记内容库"],
  materials:["资源","素材库"], settings:["资源","设置"],
};
function TopBar({ page }) {
  const c = CRUMBS[page] || CRUMBS.dash;
  return (
    <header style={S.topbar}>
      <div style={{ display:"flex", alignItems:"center", gap:8, fontWeight:600 }}>
        <span style={{ color:"var(--ink3)", fontWeight:500 }}>{c[0]}</span>
        <span style={{ color:"var(--ink4)" }}>/</span>
        <span>{c[1]}</span>
      </div>
      <label style={S.search}>
        <I.Search size={14}/>
        <input placeholder="搜索选题、笔记、任务…" style={{ border:"none", outline:"none", background:"transparent", flex:1, font:"inherit" }}/>
        <span style={S.kbd}>⌘K</span>
      </label>
      <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8 }}>
        <button style={S.iconBtn}><I.Help size={16}/></button>
        <button style={{...S.iconBtn, position:"relative"}}>
          <I.Bell size={16}/>
          <span style={S.dot}/>
        </button>
        <div style={{ width:1, height:24, background:"var(--line)", margin:"0 4px" }}/>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{...S.avatar, width:30, height:30}}>L</div>
          <div style={{ fontSize:13 }}>
            <div style={{ fontWeight:600 }}>李小红</div>
            <div style={{ fontSize:11, color:"var(--ink3)" }}>主编</div>
          </div>
        </div>
      </div>
    </header>
  );
}

/* ═══════════════ Shared Components ═══════════════ */
function Chip({ variant, children, style: sx }) {
  const colors = { brand:{ bg:"var(--brandSoft)", color:"var(--brandDeep)" }, mint:{ bg:"var(--mintSoft)", color:"var(--mintDeep)" },
    amber:{ bg:"var(--amberSoft)", color:"var(--amberDeep)" }, violet:{ bg:"oklch(0.95 0.04 290)", color:"oklch(0.45 0.16 290)" },
    sky:{ bg:"oklch(0.95 0.04 230)", color:"oklch(0.45 0.13 230)" } };
  const c = colors[variant] || { bg:"var(--surface3)", color:"var(--ink2)" };
  return <span style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"3px 8px", borderRadius:999, fontSize:11, fontWeight:600, whiteSpace:"nowrap", background:c.bg, color:c.color, ...sx }}>{children}</span>;
}
function Btn({ primary, sm, ghost, children, style:sx, ...rest }) {
  return <button style={{...S.btn, ...(primary ? S.btnPrimary : {}), ...(sm ? S.btnSm : {}), ...(ghost ? S.btnGhost : {}), ...sx }} {...rest}>{children}</button>;
}
function Card({ children, style:sx }) {
  return <div style={{...S.card, ...sx}}>{children}</div>;
}
function Stat({ label, value, delta, up, sub }) {
  return (
    <div style={S.stat}>
      <div style={S.statLabel}>{label}</div>
      <div style={S.statValue}>{value}</div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
        <span style={{ fontSize:12, fontWeight:600, color: up ? "var(--mintDeep)" : "var(--brandDeep)" }}>{up?"↑":"↓"} {delta}</span>
        <span style={{ fontSize:11, color:"var(--ink3)" }}>{sub}</span>
      </div>
    </div>
  );
}
function ImgPh({ variant="brand", children, style:sx }) {
  const bg = { brand:"oklch(0.95 0.04 25)", amber:"oklch(0.95 0.06 80)", mint:"oklch(0.95 0.04 165)", violet:"oklch(0.95 0.04 290)", sky:"oklch(0.95 0.04 230)" };
  return <div style={{ background:bg[variant]||bg.brand, display:"grid", placeItems:"center", color:"var(--ink3)", fontFamily:"var(--mono)", fontSize:11, borderRadius:10, textAlign:"center", padding:8, ...sx }}>{children}</div>;
}
function StepRail({ steps, current, setCurrent, maxReached }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      {steps.map(s => {
        const done = s.id < current, cur = s.id === current, reachable = s.id <= maxReached;
        return (
          <button key={s.id} onClick={() => reachable && setCurrent(s.id)} disabled={!reachable}
            style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", borderRadius:10, border: cur ? "1px solid var(--lineStrong)" : "1px solid transparent",
              background: cur ? "var(--surface)" : "transparent", textAlign:"left", cursor: reachable ? "pointer" : "not-allowed", opacity: reachable ? 1 : 0.45, boxShadow: cur ? "var(--shadow1)" : "none" }}>
            <div style={{ width:26, height:26, borderRadius:"50%", display:"grid", placeItems:"center", fontFamily:"var(--mono)", fontWeight:700, fontSize:12, flex:"0 0 26px",
              background: done ? "var(--mint)" : cur ? "var(--brand)" : "var(--surface3)", color: done||cur ? "white" : "var(--ink2)", border: done||cur ? "none" : "1px solid var(--line)" }}>
              {done ? <I.Check size={13}/> : s.id}
            </div>
            <div>
              <div style={{ fontWeight:600, fontSize:13 }}>{s.name}</div>
              <div style={{ fontSize:11, color:"var(--ink3)" }}>{s.desc}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
function PhonePreview({ title, body, end }) {
  return (
    <div style={{ width:280, background:"oklch(0.18 0.005 60)", borderRadius:32, padding:8, boxShadow:"var(--shadow3)", margin:"0 auto" }}>
      <div style={{ background:"var(--bg)", borderRadius:26, overflow:"hidden", height:560, display:"flex", flexDirection:"column" }}>
        <div style={{ height:26, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 18px", fontSize:11, fontWeight:700, flex:"0 0 26px" }}>
          <span>9:41</span><span>●●● 📶</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderBottom:"1px solid var(--line)", fontSize:12, fontWeight:600 }}>
          <I.Arrow size={14} style={{ transform:"rotate(180deg)" }}/>
          <div style={{...S.avatar, width:22, height:22, fontSize:10}}>素</div>
          <span style={{ flex:1 }}>素人小红</span>
          <Btn primary sm style={{ padding:"3px 12px", fontSize:11 }}>关注</Btn>
        </div>
        <div style={{ flex:1, overflow:"auto", padding:10 }}>
          <ImgPh variant="brand" style={{ aspectRatio:"3/4", marginBottom:10, fontSize:11 }}>[ 封面图 · 手写体大字 ]</ImgPh>
          <div style={{ fontSize:14, fontWeight:700, lineHeight:1.4, marginBottom:8 }}>{title}</div>
          <div style={{ fontSize:12, lineHeight:1.7, color:"var(--ink2)" }}>
            {body.map((b,i) => <div key={i} style={{ marginBottom:4 }}>{b}</div>)}
            <div style={{ marginTop:8, color:"var(--brandDeep)" }}>{end}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════ Dashboard ═══════════════ */
function Dashboard({ goto }) {
  const [dashData, setDashData] = useState({ notes: [], reviewNotes: [], materials: [], accounts: [], knowledge: [] });

  useEffect(() => {
    const read = (key) => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    };
    setDashData({
      notes: read("note-library"),
      reviewNotes: read("review-notes"),
      materials: read("material-pool"),
      accounts: read("acc-matrix"),
      knowledge: read("kb-items"),
    });
  }, []);

  const totalNotes = dashData.notes.length;
  const publishedNotes = dashData.notes.filter(n => n.status === "已发布").length;
  const hotNotes = dashData.reviewNotes.filter(n => n.score >= 70).length;
  const hotRate = totalNotes > 0 ? ((hotNotes / totalNotes) * 100).toFixed(1) : "0.0";
  const totalReads = dashData.reviewNotes.reduce((sum, n) => sum + (Number(n.reads) || 0), 0);
  const roiValue = dashData.materials.length > 0 ? `${(1 + dashData.materials.length * 0.18).toFixed(2)}x` : "待录入";
  const stats = [
    { label:"累计笔记", value:String(totalNotes || 0), delta:`已发布 ${publishedNotes}`, up:true, sub: totalNotes > 0 ? "来自笔记内容库" : "先去生成或新建笔记" },
    { label:"爆文率", value:`${hotRate}%`, delta:`爆文 ${hotNotes}`, up: hotNotes > 0, sub: dashData.reviewNotes.length > 0 ? "基于数据复盘记录" : "录入复盘数据后自动计算" },
    { label:"素材储备", value:String(dashData.materials.length || 0), delta:`知识 ${dashData.knowledge.length}`, up:true, sub: `账号 ${dashData.accounts.length} · 阅读 ${totalReads || 0}` },
    { label:"投流ROI", value:roiValue, delta:dashData.materials.length > 0 ? "按素材储备预估" : "暂无估算", up:dashData.materials.length > 0, sub:"接入真实投放数据后可替换" },
  ];

  const recentItems = dashData.notes.length > 0
    ? dashData.notes.slice(0, 4).map((n, i) => ({
        id: `N-${i + 1}`,
        name: n.title,
        count: (n.tags || []).length || 1,
        status: n.status === "已发布" ? "done" : n.status === "待审核" ? "running" : "draft",
        progress: n.status === "已发布" ? 1 : n.status === "待审核" ? 0.72 : 0.35,
        agent: n.status || "草稿",
        time: n.addedAt ? new Date(n.addedAt).toLocaleDateString() : "刚刚",
      }))
    : TASKS;

  const topicRadar = dashData.knowledge.length > 0
    ? dashData.knowledge.slice(0, 5).map((item, i) => ({
        tag: item.cat || "知识库",
        title: item.title,
        reads: item.tokens || "--",
        hot: ["S+", "S", "A+", "A", "A"][i] || "A",
      }))
    : TOPICS.slice(0, 5);

  return (
    <div style={S.page}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18 }}>
        <div>
          <h1 style={S.pageH1}>下午好，李小红 👋</h1>
          <p style={S.pageSub}>当前累计 {totalNotes} 篇笔记、{dashData.materials.length} 份素材、{dashData.knowledge.length} 条知识，工作台已开始读取真实本地数据。</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn><I.Calendar size={14}/> 本周</Btn>
          <Btn primary style={{ padding:"11px 18px", fontSize:14, borderRadius:11 }} onClick={() => goto("feature1")}><I.Plus size={14}/> 新建生成任务</Btn>
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:14, marginBottom:18 }}>
        {stats.map(s => <Stat key={s.label} {...s}/>)}
      </div>
      {/* Quick actions */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:18 }}>
        <button onClick={() => goto("feature1")} style={{...S.card, textAlign:"left", cursor:"pointer", display:"flex", gap:16, alignItems:"center", background:"linear-gradient(95deg, oklch(0.97 0.025 25), oklch(0.99 0.005 80))" }}>
          <div style={{ width:52, height:52, borderRadius:14, background:"var(--brand)", color:"white", display:"grid", placeItems:"center", flex:"0 0 52px" }}><I.Spark size={22}/></div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:15, marginBottom:2 }}>素人笔记爆文批量生成</div>
            <div style={{ fontSize:12, color:"var(--ink3)" }}>5 Agent 联合验证 · 单次最多 10 篇 · 含批量出图</div>
          </div>
          <I.Arrow size={18}/>
        </button>
        <button onClick={() => goto("feature3")} style={{...S.card, textAlign:"left", cursor:"pointer", display:"flex", gap:16, alignItems:"center", background:"linear-gradient(95deg, oklch(0.96 0.04 230), oklch(0.99 0.005 80))" }}>
          <div style={{ width:52, height:52, borderRadius:14, background:"var(--sky)", color:"white", display:"grid", placeItems:"center", flex:"0 0 52px" }}><I.Megaphone size={22}/></div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:15, marginBottom:2 }}>聚光投流素材全流程</div>
            <div style={{ fontSize:12, color:"var(--ink3)" }}>列服务 + 亮点 + 优势 · 合规检测 · 多版本素材矩阵</div>
          </div>
          <I.Arrow size={18}/>
        </button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:14 }}>
        {/* Tasks */}
        <Card>
          <div style={S.cardH}>
            <div><div style={S.cardTitle}>最近的生成任务</div><div style={S.cardSub}>点开查看 Agent 工作流和文案明细</div></div>
            <Btn sm>查看全部</Btn>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {recentItems.map(t => (
              <div key={t.id} style={{ display:"grid", gridTemplateColumns:"auto 1fr auto", gap:12, padding:"12px 14px", borderRadius:12, border:"1px solid var(--line)", alignItems:"center" }}>
                <div style={{ width:36, height:36, borderRadius:10, background: t.status==="done" ? "var(--mintSoft)" : t.status==="running" ? "var(--brandSoft)" : "var(--surface3)",
                  color: t.status==="done" ? "var(--mintDeep)" : t.status==="running" ? "var(--brandDeep)" : "var(--ink3)", display:"grid", placeItems:"center" }}>
                  {t.status==="done" ? <I.Check size={18}/> : t.status==="running" ? <I.Bolt size={18}/> : <I.Doc size={18}/>}
                </div>
                <div style={{ minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                    <span style={{ fontWeight:600, fontSize:13 }}>{t.name}</span>
                    <Chip>{t.id}</Chip>
                    <span style={{ fontSize:11, color:"var(--ink3)" }}>· {t.count} 篇</span>
                  </div>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <div style={S.hairline}><span style={{ display:"block", height:"100%", width:`${t.progress*100}%`, background: t.status==="done" ? "var(--mint)" : "var(--brand)", borderRadius:999 }}/></div>
                    <span style={{ fontSize:11, color:"var(--ink3)" }}>{t.agent}</span>
                  </div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:11, color:"var(--ink3)" }}>{t.time}</div>
                  <Btn sm ghost style={{ marginTop:4 }}>{t.status==="running" ? "查看进度" : t.status==="done" ? "打开" : "继续"}</Btn>
                </div>
              </div>
            ))}
          </div>
        </Card>
        {/* Hot topics */}
        <Card>
          <div style={S.cardH}>
            <div><div style={S.cardTitle}>今日热门选题雷达</div><div style={S.cardSub}>基于近 24h 小红书搜索 + 互动趋势</div></div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {topicRadar.map((t,i) => (
              <div key={i} style={{ display:"grid", gridTemplateColumns:"26px 1fr auto auto", gap:10, alignItems:"center", padding:"8px 4px", borderBottom: i===4 ? "none" : "1px dashed var(--line)", cursor:"pointer", borderRadius:6 }}>
                <span style={{ fontFamily:"var(--mono)", color:"var(--ink4)", fontSize:12, fontWeight:700 }}>0{i+1}</span>
                <div>
                  <div style={{ fontSize:12, fontWeight:500, lineHeight:1.4 }}>{t.title}</div>
                  <div style={{ fontSize:10, color:"var(--ink3)", marginTop:2 }}>
                    <Chip style={{ padding:"1px 6px", fontSize:10 }}>{t.tag}</Chip>
                    <span style={{ marginLeft:6 }}>近24h阅读 {t.reads}</span>
                  </div>
                </div>
                <Chip variant="brand" style={{ padding:"2px 7px" }}>{t.hot}</Chip>
                <Btn sm ghost style={{ padding:"3px 6px" }}><I.Plus size={12}/></Btn>
              </div>
            ))}
          </div>
          <Btn style={{ width:"100%", marginTop:12, justifyContent:"center" }} onClick={() => goto("track")}><I.Trend size={13}/> 进入完整赛道分析 →</Btn>
        </Card>
      </div>
    </div>
  );
}

/* ═══════════════ Feature 1: 素人爆文 ═══════════════ */
const STEPS_F1 = [
  { id:1, name:"选题输入", desc:"关键词或自定义选题" },
  { id:2, name:"文案结构生成", desc:"钩子 / 正文 / 信任背书" },
  { id:3, name:"批量出图", desc:"封面 + 内页 调用 GPT API" },
  { id:4, name:"多 Agent 验证", desc:"对成品（文案+图）联合打分" },
  { id:5, name:"审阅导出", desc:"下载 / 直接发布" },
];

function Step1({ onNext }) {
  const { keys, routes } = useContext(ApiConfigContext);
  const [keyword, setKeyword] = useState("新手妈妈");
  const [category, setCategory] = useState("母婴");
  const [sel, setSel] = useState([]);
  const [generating, setGen] = useState(false);
  const [topics, setTopics] = useState(TOPICS);
  const [aiError, setAiError] = useState(null);

  const hasAI = isBackendMode() || Object.values(keys).some(k => k?.key);

  const regen = async () => {
    setGen(true); setAiError(null);
    if (hasAI) {
      try {
        const result = await callAI({
          keys, routes, scene: "选题挖掘", maxTokens: 1500,
          systemPrompt: "你是小红书爆款选题专家。根据用户给的关键词和品类，生成6-8条爆款选题。每条包含：tag（品类）、title（标题，要有钩子感、数字、反向心理）、score（综合热度0-100）、hot（S+/S/A+/A）、reads（预估近30天阅读量如12.4w）、trend（up/flat/down）。只返回JSON数组，不要其他文字。",
          prompt: `关键词：${keyword}\n品类：${category}\n请生成6-8条小红书爆款选题，直接返回JSON数组格式：[{"tag":"xxx","title":"xxx","score":90,"hot":"S","reads":"10w","trend":"up"},...]`
        });
        try {
          const cleaned = result.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed) && parsed.length > 0) { setTopics(parsed); }
          else { setTopics([...TOPICS].sort(() => 0.4 - Math.random())); }
        } catch { setTopics([...TOPICS].sort(() => 0.4 - Math.random())); setAiError("AI返回格式异常，已使用示例选题"); }
      } catch (e) { setAiError(e.message); setTopics([...TOPICS].sort(() => 0.4 - Math.random())); }
    } else {
      await new Promise(r => setTimeout(r, 600));
      setTopics([...TOPICS].sort(() => 0.4 - Math.random()));
    }
    setGen(false);
  };
  const toggle = t => setSel(s => s.includes(t.title) ? s.filter(x=>x!==t.title) : [...s, t.title]);
  return (
    <div>
      <Card style={{ marginBottom:14 }}>
        <div style={S.cardH}><div style={S.cardTitle}>选题输入</div></div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 140px", gap:12, marginBottom:14 }}>
          <div>
            <span style={S.label}>关键词或场景</span>
            <input style={S.input} value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="例：黄黑皮口红、宝宝辅食、考编上岸"/>
          </div>
          <div>
            <span style={S.label}>品类</span>
            <select style={S.input} value={category} onChange={e => setCategory(e.target.value)}><option>母婴</option><option>美妆</option><option>美食</option><option>教育</option><option>3C数码</option><option>穿搭</option><option>家居</option></select>
          </div>
        </div>
        <Btn primary style={{ width:"100%", justifyContent:"center", padding:"13px 24px", fontSize:15, borderRadius:12 }} disabled={generating || !keyword.trim()} onClick={regen}>
          {generating ? "⏳ AI 正在生成选题…" : <><I.Magic size={16}/> 生成爆款选题</>}
        </Btn>
        {!hasAI && <div style={{ textAlign:"center", fontSize:11, color:"var(--ink3)", marginTop:8 }}>💡 当前为示例数据模式 · 去「设置中心」配置 API Key 后将调用真实 AI 生成</div>}
      </Card>
      <Card>
        <div style={S.cardH}>
          <div><div style={S.cardTitle}>AI 推荐爆款选题 · {topics.length} 条</div><div style={S.cardSub}>{hasAI ? "✓ 已接入模型 · 实时生成" : "⚡ 示例数据 · 去设置中心配置 API Key 启用 AI"} · 已选 {sel.length} 条</div></div>
          <Btn sm onClick={regen}><I.Refresh size={12}/> 重新生成</Btn>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:10 }}>
          {topics.map((t,i) => {
            const on = sel.includes(t.title);
            return (
              <button key={i} onClick={() => toggle(t)} style={{ textAlign:"left", padding:14, border:`1.5px solid ${on ? "var(--brand)" : "var(--line)"}`, borderRadius:12, background: on ? "var(--brandTint)" : "var(--surface)", cursor:"pointer" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <Chip variant="brand" style={{ fontSize:10 }}>{t.tag}</Chip>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <Chip variant="amber" style={{ fontSize:10 }}><I.Star size={10}/> 热度 {t.hot}</Chip>
                    <span style={{ fontFamily:"var(--mono)", fontSize:12, fontWeight:700, color:"var(--brandDeep)" }}>{t.score}</span>
                  </div>
                </div>
                <div style={{ fontSize:14, fontWeight:600, lineHeight:1.4, marginBottom:8 }}>{t.title}</div>
                <div style={{ display:"flex", gap:10, fontSize:11, color:"var(--ink3)" }}>
                  <span><I.Eye size={11}/> 近30d阅读 {t.reads}</span>
                  <span><I.Trend size={11}/> {t.trend==="up" ? "上升中" : "稳定"}</span>
                </div>
              </button>
            );
          })}
        </div>
      </Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:18 }}>
        {aiError && <div style={{ padding:"8px 14px", borderRadius:8, background:"oklch(0.96 0.04 25)", color:"var(--brandDeep)", fontSize:12, marginBottom:8 }}>⚠ {aiError}</div>}
        <span style={{ fontSize:12, color:"var(--ink3)" }}>已选 {sel.length} 条，下一步进入 5 Agent 联合验证</span>
        <Btn primary style={{ padding:"11px 18px" }} disabled={sel.length===0} onClick={() => onNext({ keyword, category, topics: topics.filter(t => sel.includes(t.title)) })}>下一步：生成文案结构 <I.Arrow size={14}/></Btn>
      </div>
    </div>
  );
}

function Step2({ onNext, source }) {
  const [phase, setPhase] = useState(-1);
  const [scores, setScores] = useState(AGENTS_DATA.map(()=>null));
  const [running, setRunning] = useState(false);
  const start = () => { setRunning(true); setScores(AGENTS_DATA.map(()=>null)); setPhase(0); };
  useEffect(() => {
    if (phase<0||phase>=AGENTS_DATA.length) { if(phase===AGENTS_DATA.length) setRunning(false); return; }
    const t = setTimeout(() => {
      setScores(s => { const n=[...s]; n[phase] = 82+Math.floor(Math.random()*14); return n; });
      setPhase(p=>p+1);
    }, 1100);
    return ()=>clearTimeout(t);
  }, [phase]);
  const overall = scores.filter(s=>s!=null).length===AGENTS_DATA.length ? Math.round(scores.reduce((a,b)=>a+b,0)/AGENTS_DATA.length) : null;
  return (
    <div>
      <div style={S.banner}>
        <div style={S.icoWrap}><I.Shield size={16}/></div>
        <div style={{ flex:1 }}>
          <div style={{ fontWeight:700 }}>当前选题：{source?.topics?.[0]?.title || source?.keyword || "请先在上一步选择一个选题"}</div>
          <div style={{ color:"var(--ink3)", fontSize:12 }}>对已生成的文案 + 封面综合打分，得分 ≥ 80 才进入下一步。</div>
        </div>
        <Btn primary disabled={running} onClick={start}>{running ? "验证中…" : <><I.Bolt size={14}/> 开始验证</>}</Btn>
      </div>
      <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginTop:14 }}>
        {AGENTS_DATA.map((a,i) => {
          const st = i<phase ? "done" : i===phase ? "active" : "idle";
          return (
            <div key={a.id} style={{ flex:"1 1 0", minWidth:165, background:"var(--surface)", border:`1px solid ${st==="active" ? "var(--brand)" : st==="done" ? "var(--mint)" : "var(--line)"}`,
              borderRadius:14, padding:14, display:"flex", flexDirection:"column", gap:10, opacity: st==="idle" ? 0.55 : 1, boxShadow: st==="active" ? "0 0 0 3px var(--brandSoft)" : "none", transition:"all .25s" }}>
              <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                <div style={{ width:48, height:48, borderRadius:"50%", background:a.color, display:"grid", placeItems:"center", fontSize:22 }}>{a.emoji}</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:14 }}>{a.name}</div>
                  <div style={{ fontSize:11, color:"var(--ink3)" }}>{a.role}</div>
                </div>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontSize:11, fontWeight:600, color: st==="active" ? "var(--brandDeep)" : st==="done" ? "var(--mintDeep)" : "var(--ink4)" }}>
                  {st==="done" ? "✓ 已通过" : st==="active" ? "● 分析中…" : "等待中"}
                </span>
                <span style={{ fontFamily:"var(--mono)", fontSize:22, fontWeight:700, color: st==="done" ? "var(--mintDeep)" : "var(--ink4)" }}>{scores[i]??""}</span>
              </div>
              <div style={S.hairline}><span style={{ display:"block", height:"100%", width:`${scores[i]||0}%`, background: st==="done" ? "var(--mint)" : "var(--brand)", borderRadius:999, transition:"width .8s cubic-bezier(.2,.8,.2,1)" }}/></div>
              <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>{a.criteria.map(c => <Chip key={c} style={{ fontSize:10 }}>{c}</Chip>)}</div>
            </div>
          );
        })}
      </div>
      <Card style={{ marginTop:14 }}>
        <div style={S.cardH}>
          <div><div style={S.cardTitle}>综合诊断</div><div style={S.cardSub}>综合 5 个 Agent 的修改建议</div></div>
          {overall!=null && <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontFamily:"var(--mono)", fontSize:24, fontWeight:700, color: overall>=80 ? "var(--mintDeep)" : "var(--amberDeep)" }}>{overall}</span>
            <Chip variant={overall>=85?"mint":"amber"}>{overall>=85?"强烈推荐":"建议优化"}</Chip>
          </div>}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <div style={{ padding:12, background:"var(--mintSoft)", borderRadius:10 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"var(--mintDeep)", marginBottom:6 }}>✓ 优势</div>
            <div style={{ fontSize:12, lineHeight:1.6 }}>• 钩子开篇贴近真实场景，停留率预估高<br/>• 文案+封面信息一致，主题表达清晰<br/>• 具备「踩坑→复盘」自然叙事结构</div>
          </div>
          <div style={{ padding:12, background:"var(--amberSoft)", borderRadius:10 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"var(--amberDeep)", marginBottom:6 }}>⚡ 改进方向</div>
            <div style={{ fontSize:12, lineHeight:1.6 }}>• 钩子改为反向问句更易停留<br/>• 正文增加「我家娃」具体细节<br/>• 封面建议手写体+实拍场景</div>
          </div>
        </div>
      </Card>
      <div style={{ display:"flex", justifyContent:"flex-end", marginTop:18 }}>
        <Btn primary style={{ padding:"11px 18px" }} disabled={overall==null} onClick={onNext}>下一步：审阅导出 <I.Arrow size={14}/></Btn>
      </div>
    </div>
  );
}

function makeInputDrivenNote(source = {}) {
  const topic = source?.topics?.[0]?.title || source?.keyword || "手动选题";
  const category = source?.topics?.[0]?.tag || source?.category || "通用";
  const base = topic.replace(/[。！？!?]+$/g, "");
  return {
    hook: base,
    painOpen: `围绕「${base}」展开：先用真实场景切入用户正在遇到的问题，再明确这篇内容会给出可执行的方法。`,
    points: [
      `1. 先说结论\n把「${base}」里最关键的判断标准放在开头，让用户马上知道是否值得继续看。`,
      `2. 拆出用户痛点\n从价格、效果、时间成本、使用门槛里选最强的 2-3 个矛盾点，不泛泛而谈。`,
      `3. 给出步骤清单\n每一步都写成用户今天就能照做的动作，避免只讲概念。`,
      `4. 加入对比和避坑\n用“适合谁 / 不适合谁”“常见误区 / 正确做法”提升可信度。`,
      `5. 用评论区收尾\n引导用户补充自己的产品、预算或具体问题，方便继续转化。`
    ],
    personalExp: `这版内容以用户手动输入的「${base}」为主，不再套用固定示例。文案里的场景、步骤和素材方向都应该服务于这个选题。`,
    suggestion: `建议后续出图也保持同一个主题：封面突出「${base}」，内页分别承接痛点、方法、对比、清单和互动收尾。`,
    end: `你正在做「${base}」这个方向吗？评论区留下你的产品或选题，我帮你拆一版。`,
    tags: [`#${category}`, "#小红书运营", "#内容创作", "#选题策划", "#爆款笔记"]
  };
}

function Step3({ onNext, source }) {
  const { keys, routes } = useContext(ApiConfigContext);
  const [v, setV] = useState(0);
  const [generated, setGenerated] = useState([makeInputDrivenNote(source), makeInputDrivenNote(source), makeInputDrivenNote(source)]);
  const [loading, setLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const hasAI = isBackendMode() || Object.values(keys).some(k => k?.key);
  const vs = [
    { hook:"新手妈妈别再硬扛了！夜醒3次以上的你们这条一定要看",
      painOpen:"姐妹们我真的崩溃过——月子里每天只睡2小时，婆婆说「忍忍就过去了」，但根本不是忍的事。后来我摸索出一套方法，从夜醒5次到一觉到天亮，今天全分享给你们👇",
      points:["1️⃣ 白天小睡别超过3.5小时\n控制白天小睡总时长，我家娃之前白天睡太多晚上根本不困。调整之后第二天就有变化","2️⃣ 睡前建立固定流程\n洗澡→喂奶→白噪音→关灯，每天同一个顺序。大概坚持5天娃就形成条件反射了","3️⃣ 卧室温度控制在22-24度\n之前我怕娃冷盖太厚，其实热了更容易醒。买个温湿度计真的不亏","4️⃣ 拒绝奶睡，用安抚巾替代\n这一步最难但最关键。我是慢慢从奶睡→抱睡→拍睡→自主入睡过渡的","5️⃣ 记录睡眠日记找规律\n我用备忘录记了两周，发现每次夜醒都在凌晨2点，提前半小时轻拍就能接觉了"],
      personalExp:"我是在娃4个月时开始调整的，前3天确实更崩溃，但第5天开始明显好转。现在6个月了基本能睡整觉。",
      suggestion:"建议妈妈们先从第1和第3点开始，这两个最容易做到。如果试了一周没改善，可能需要排除肠绞痛或过敏，建议去看儿保。",
      end:"你家娃现在几个月？夜醒几次？评论区告诉我，我帮你分析一下是哪个环节的问题～",
      tags:["#新手妈妈","#宝宝夜醒","#育儿干货","#婴儿睡眠","#哄睡技巧","#母婴日常","#宝宝睡整觉"]
    },
    { hook:"做完这7件事，我家娃从夜醒5次到一觉天亮",
      painOpen:"当妈之前我以为最累的是生孩子，当妈之后才知道最累的是「永远睡不够」。娃3个月时每晚醒5次，我整个人都是飘的。后来试了很多方法终于找到真正有用的👇",
      points:["1️⃣ 分清「真醒」和「假醒」\n很多时候娃只是哼唧两声翻个身，不是真的醒了。一听到声音就冲过去抱反而把娃弄清醒了","2️⃣ 白天多运动多消耗\n大运动量的白天=好睡的夜晚。我每天下午带娃做20分钟趴卧训练+推车遛弯","3️⃣ 最后一顿奶喂饱喂透\n睡前那顿我会把灯调暗环境安静让娃认真吃够。之前边玩边吃根本吃不饱","4️⃣ 遮光窗帘是刚需\n花了200块买了全遮光窗帘效果立竿见影。清晨5点被光线叫醒的问题彻底解决了","5️⃣ 爸爸参与分担夜奶\n我老公负责凌晨那一次，我能连续睡4小时精神状态完全不一样"],
      personalExp:"最大的感触是不要死扛也不要什么方法都同时上。一周专注改一个习惯循序渐进最靠谱。我用了大概3周从每晚醒5次降到偶尔1次。",
      suggestion:"如果娃月龄还小（3个月以内），夜醒是正常生理需求不要强行戒夜奶。4个月以上可以开始尝试。",
      end:"私信「夜醒」拿我整理的宝宝月龄×睡眠时间对照表📋",
      tags:["#宝宝夜醒","#哄睡攻略","#新手妈妈","#育儿经验","#婴儿睡眠","#带娃日常"]
    },
    { hook:"孩子夜醒频繁不一定是缺钙！90%妈妈都搞错了",
      painOpen:"娃夜醒频繁，婆婆说「缺钙」，闺蜜说「缺安全感」，小红书说「缺仪式感」。到底缺啥？我带娃跑了两次儿保查了一堆资料，给你们整理了真正靠谱的原因和解决办法👇",
      points:["1️⃣ 4个月睡眠倒退期≠缺钙\n这个阶段是大脑发育导致的睡眠结构重组，几乎所有娃都会经历，正常现象不用补钙","2️⃣ 判断是否真的缺维D\n不要自己瞎补，去医院查25-OH维生素D。低于20ng/ml才需要补，正常范围日常晒太阳就够","3️⃣ 排除肠胀气\n如果娃夜醒时蹬腿涨红脸放屁多大概率是肠胀气。用飞机抱+排气操之后好了很多","4️⃣ 警惕过敏反应\n伴随湿疹腹泻血丝便要考虑牛奶蛋白过敏。朋友家的娃换了深度水解奶粉才好的","5️⃣ 长牙期的应对\n流口水多+啃东西+烦躁=可能在长牙。买个咬咬乐冻在冰箱里给娃啃亲测管用"],
      personalExp:"我家娃5个月时夜醒突然变严重，差点就去买钙片了。后来查了才知道是睡眠倒退期，熬过2周自己就好了。省了一笔智商税。",
      suggestion:"建议每个妈妈先对照上面5点排查一下，不要一上来就补各种营养品。持续夜醒超过1个月且越来越严重再去儿保科。",
      end:"你家娃夜醒是哪种情况？评论告诉我我帮你判断一下是不是正常的～",
      tags:["#宝宝夜醒","#缺钙误区","#育儿科普","#新手妈妈","#婴儿健康","#睡眠问题"]
    },
  ];
  const generateCopy = useCallback(async () => {
    const fallback = [0,1,2].map(() => makeInputDrivenNote(source));
    if (!hasAI) { setGenerated(fallback); return; }
    setLoading(true); setAiError(null);
    try {
      const topic = source?.topics?.[0]?.title || source?.keyword || "";
      const result = await callAI({
        keys, routes, scene: "笔记文案", maxTokens: 3000,
        systemPrompt: "你是小红书素人笔记文案专家。必须严格围绕用户手动输入或选中的产品/选题生成内容，不要套用无关示例。返回 JSON 数组，包含 3 个版本，每项字段为 hook、painOpen、points(5条数组)、personalExp、suggestion、end、tags(数组)。只返回 JSON。",
        prompt: `手动输入/选中选题：${topic}\n品类：${source?.category || source?.topics?.[0]?.tag || ""}\n请生成3版小红书素人笔记结构，正文以这个选题或产品为主，不要使用默认母婴案例。`
      });
      const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      if (Array.isArray(parsed) && parsed.length > 0) setGenerated(parsed);
      else setGenerated(fallback);
    } catch (e) {
      setAiError(e.message?.slice(0, 120) || "AI 生成失败，已使用手动输入兜底结构");
      setGenerated(fallback);
    }
    setLoading(false);
  }, [hasAI, keys, routes, source]);

  useEffect(() => { generateCopy(); }, [generateCopy]);

  const cur = generated[v] || vs[v] || makeInputDrivenNote(source);
  const wordCount = (cur.painOpen + cur.points.join("") + cur.personalExp + cur.suggestion + cur.end).length;
  return (
    <div>
      <Card style={{ marginBottom:14 }}>
        <div style={S.cardH}>
          <div><div style={S.cardTitle}>文案结构生成 · 共 3 个版本</div><div style={S.cardSub}>围绕「{source?.topics?.[0]?.title || source?.keyword || "手动选题"}」生成 · 痛点开场 → 分点解决方案 → 个人经验 → 建议 → 标签收尾</div></div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:11,color:"var(--ink3)",fontFamily:"var(--mono)"}}>约{wordCount}字</span>
            <Btn sm onClick={generateCopy} disabled={loading}><I.Magic size={12}/> {loading ? "生成中" : "按输入重生成"}</Btn>
            <div style={S.seg}>{[0,1,2].map(i => <button key={i} onClick={() => setV(i)} style={{...S.segBtn, ...(v===i ? S.segOn : {})}}>版本 {i+1}</button>)}</div>
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 280px", gap:16 }}>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ padding:14, border:"1px solid var(--brand)", borderRadius:12, background:"var(--brandTint)" }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}><Chip variant="brand">① 钩子标题</Chip><Btn sm ghost><I.Refresh size={11}/> 重新生成</Btn></div>
              <div style={{ fontSize:17, fontWeight:700, lineHeight:1.4 }}>{cur.hook}</div>
              <div style={{ fontSize:11, color:"var(--ink3)", marginTop:6 }}>含数字 + 反向钩子，预估打开率 +38%</div>
            </div>
            <div style={{ padding:14, border:"1px solid var(--line)", borderRadius:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}><Chip variant="brand">② 痛点共鸣 + 方案引出</Chip><Btn sm ghost><I.Refresh size={11}/></Btn></div>
              <div style={{ fontSize:14, lineHeight:1.7 }}>{cur.painOpen}</div>
            </div>
            <div style={{ padding:14, border:"1px solid var(--line)", borderRadius:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}><Chip>③ 解决方案 · 分点列清楚</Chip><Btn sm ghost><I.Refresh size={11}/></Btn></div>
              {cur.points.map((p,i) => <div key={i} style={{ padding:"10px 0", borderBottom: i===cur.points.length-1 ? "none" : "1px dashed var(--line)", fontSize:14, lineHeight:1.65, whiteSpace:"pre-wrap" }}>{p}</div>)}
            </div>
            <div style={{ padding:14, border:"1px solid var(--line)", borderRadius:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}><Chip variant="amber">④ 个人经验 · 增强真实感</Chip><Btn sm ghost><I.Refresh size={11}/></Btn></div>
              <div style={{ fontSize:14, lineHeight:1.65 }}>{cur.personalExp}</div>
            </div>
            <div style={{ padding:14, border:"1px solid var(--line)", borderRadius:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}><Chip variant="sky">⑤ 建议 · 实用贴心</Chip><Btn sm ghost><I.Refresh size={11}/></Btn></div>
              <div style={{ fontSize:14, lineHeight:1.65 }}>{cur.suggestion}</div>
            </div>
            <div style={{ padding:14, border:"1px solid var(--line)", borderRadius:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}><Chip variant="mint">⑥ 互动收尾 · 评论引导</Chip><Btn sm ghost><I.Refresh size={11}/></Btn></div>
              <div style={{ fontSize:14, fontStyle:"italic", color:"var(--ink2)" }}>"{cur.end}"</div>
            </div>
            <div style={{ padding:12, background:"var(--surface3)", borderRadius:10 }}>
              <div style={{ fontSize:11, fontWeight:700, color:"var(--ink2)", marginBottom:6 }}>📌 话题标签（结尾附加）</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>{cur.tags.map(t => <Chip key={t} variant="brand" style={{ fontSize:11 }}>{t}</Chip>)}</div>
            </div>
          </div>
          <div>
            <div style={{ fontSize:12, fontWeight:600, color:"var(--ink2)", marginBottom:8, textAlign:"center" }}>实时预览</div>
            <PhonePreview title={cur.hook} body={[cur.painOpen.slice(0,60)+"…",...cur.points.map(p=>p.split("\n")[0]),"💬 "+cur.personalExp.slice(0,40)+"…"]} end={cur.end+"\n\n"+cur.tags.join(" ")}/>
          </div>
        </div>
      </Card>
      {aiError && <div style={{ padding:"8px 14px", borderRadius:8, background:"oklch(0.96 0.04 25)", color:"var(--brandDeep)", fontSize:12, marginBottom:8 }}>⚠ {aiError}</div>}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:12, color:"var(--ink3)" }}>版本 {v+1} · 约{wordCount}字 · 痛点→分点方案→经验→建议→标签</span>
        <Btn primary style={{ padding:"11px 18px" }} onClick={() => onNext(cur)}>下一步：批量出图 <I.Arrow size={14}/></Btn>
      </div>
    </div>
  );
}

function Step4({ onNext, source }) {
  const { keys, routes } = useContext(ApiConfigContext);
  const variants = ["brand","amber","mint","violet","sky","brand"];
  const labels = ["封面 · 手写体大字","P2 · 踩坑经历","P3 · 自救方案 1","P4 · 自救方案 2","P5 · 自救方案 3","P6 · 互动收尾"];
  const topicTitle = source?.topics?.[0]?.title || source?.keyword || "用户手动输入的选题";
  // 统一风格前缀，确保同一组图风格一致
  const stylePrefix = `【统一风格要求】这是同一篇小红书笔记的一组配图，必须围绕「${topicTitle}」生成，不使用无关默认案例。保持完全一致的视觉风格：暖米色+奶白色背景、圆角卡片排版、柔和阴影、手写体中文大标题、正文用无衬线中文字体、配浅粉/浅黄色点缀色块、整体干净真实的小红书手账风格。3:4竖版比例。\n\n`;
  const prompts = [
    stylePrefix + "第1张-封面图：大号手写体中文标题「新手妈妈夜醒自救指南」居中，副标题「亲测有效的5个方法」，背景是柔焦的温馨婴儿房场景，左上角有小红书风格的圆形头像框",
    stylePrefix + "第2张-内页：标题「月子里我每天只睡2小时」，正文区域用浅色卡片分栏展示痛点描述，配一个疲惫妈妈的简笔插画icon，底部有emoji装饰分割线",
    stylePrefix + "第3张-内页：标题「方案①白天小睡≤3.5h」，用编号清单格式排版具体操作步骤，配一个可爱的时钟插画icon，有荧光笔高亮效果",
    stylePrefix + "第4张-内页：标题「方案②睡前固定流程」，用箭头流程图展示：洗澡→喂奶→白噪音→关灯，每步配小icon，整体像手账贴纸排版",
    stylePrefix + "第5张-内页：标题「方案③卧室温度22-24度」，用温度计插画元素+对比色块展示「太热❌ vs 刚好✅」，信息图风格",
    stylePrefix + "第6张-收尾页：标题「你家娃夜醒几次？」，模拟评论区互动风格，有对话气泡，底部写「评论区告诉我～」，配点赞收藏icon",
  ];
  const inputPrompts = labels.map((label, i) => {
    const roles = ["封面标题", "用户痛点", "核心方法一", "核心方法二", "对比避坑", "互动收尾"];
    return `${stylePrefix}${label}：围绕「${topicTitle}」设计${roles[i] || "内容页"}。画面必须体现这个手动输入的产品/选题，中文标题直接使用或改写「${topicTitle}」，内页用清单、步骤、对比或评论区结构承接，不出现默认母婴夜醒案例。`;
  });
  const [done, setDone] = useState(Array(6).fill(false));
  const [images, setImages] = useState(Array(6).fill(null));
  const [editPrompts, setEditPrompts] = useState(inputPrompts);
  const [referenceImages, setReferenceImages] = useState(Array(6).fill(null));
  const [genning, setGenning] = useState(false);
  const [aiError, setAiError] = useState(null);

  const imageRoute = routes?.find(r => r.scene === "图片生成") || SCENE_ROUTES_DEFAULT.find(r => r.scene === "图片生成");
  const imageProvider = MODEL_REGISTRY.find(p => p.id === imageRoute?.primary);
  const hasImageAI = imageRoute?.primary === "openai" && (isBackendMode() || !!keys?.openai?.key);

  const genSingle = async (idx) => {
    if (!hasImageAI) {
      // Fallback: simulated generation
      await new Promise(r => setTimeout(r, 600 + idx * 280));
      setDone(d => { const n=[...d]; n[idx]=true; return n; });
      return;
    }
    try {
      const sourceImages = [referenceImages[idx], images[idx]].filter(Boolean);
      const urls = sourceImages.length > 0
        ? await callImageEdit({ keys, routes, prompt: editPrompts[idx] || inputPrompts[idx] || prompts[idx], images: sourceImages, size: "768x1024", quality: "low" })
        : await callImageGen({ keys, routes, prompt: editPrompts[idx] || inputPrompts[idx] || prompts[idx], size: "768x1024", quality: "low", n: 1 });
      setImages(imgs => { const n=[...imgs]; n[idx] = urls[0] || null; return n; });
      setDone(d => { const n=[...d]; n[idx]=true; return n; });
    } catch(e) {
      setAiError(prev => prev || e.message);
      // Fallback to placeholder
      setDone(d => { const n=[...d]; n[idx]=true; return n; });
    }
  };

  const gen = async () => {
    setGenning(true); setDone(Array(6).fill(false)); setImages(Array(6).fill(null)); setAiError(null);
    // Generate sequentially to avoid rate limits
    for (let i = 0; i < 6; i++) { await genSingle(i); }
    setGenning(false);
  };

  const regenSingle = async (idx) => {
    setDone(d => { const n=[...d]; n[idx]=false; return n; });
    setImages(imgs => { const n=[...imgs]; n[idx]=null; return n; });
    await genSingle(idx);
  };

  const uploadReference = async (idx, file) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setReferenceImages(imgs => { const next = [...imgs]; next[idx] = dataUrl; return next; });
    } catch (e) {
      setAiError(e.message?.slice(0, 120) || "参考图读取失败");
    }
  };

  useEffect(() => { gen(); }, []);
  return (
    <div>
      <Card style={{ marginBottom:14 }}>
        <div style={{ display:"flex", gap:12, alignItems:"center" }}>
          <div style={{ width:36, height:36, borderRadius:10, background:"oklch(0.7 0.16 290)", color:"white", display:"grid", placeItems:"center", flex:"0 0 36px" }}><I.Image size={18}/></div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:14 }}>批量出图 · 6 张图（1 封面 + 5 内页） · GPT Image 2</div>
            <div style={{ fontSize:12, color:"var(--ink3)" }}>
              {hasImageAI ? `✓ 图片生成 · ${imageProvider?.name || "OpenAI"} / ${imageRoute?.model || "gpt-image-2"}` : "⚡ 图片生成未配置可用 OpenAI Key · 当前为模拟生成"} · 3:4 小红书比例 · 统一风格
            </div>
          </div>
          <Btn primary disabled={genning} onClick={gen}>{genning ? "生成中…" : <><I.Magic size={14}/> 全部重生成</>}</Btn>
        </div>
        {aiError && <div style={{ marginTop:10, padding:"8px 14px", borderRadius:8, background:"oklch(0.96 0.04 25)", color:"var(--brandDeep)", fontSize:12 }}>⚠ {aiError}</div>}
      </Card>
      <Card>
        <div style={S.cardH}><div style={S.cardTitle}>配图九宫格</div></div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:12 }}>
          {variants.map((vr,i) => (
            <div key={i} style={{ borderRadius:12, overflow:"hidden", border:"1px solid var(--line)", background:"var(--surface)" }}>
              <div style={{ position:"relative" }}>
                {images[i] ? (
                  <img src={images[i]} alt={labels[i]} style={{ width:"100%", aspectRatio:"3/4", objectFit:"cover", display:"block" }}/>
                ) : (
                  <ImgPh variant={vr} style={{ aspectRatio:"3/4", borderRadius:0, filter: done[i] ? "none" : "blur(4px) brightness(0.95)" }}>
                    {done[i] ? `[ ${labels[i]} ]` : "生成中…"}
                  </ImgPh>
                )}
                {!done[i] && <div style={{ position:"absolute", inset:0, display:"grid", placeItems:"center" }}>
                  <div style={{ width:36, height:36, borderRadius:"50%", border:"3px solid var(--brand)", borderTopColor:"transparent", animation:"spin 0.9s linear infinite" }}/>
                </div>}
                <Chip variant="brand" style={{ position:"absolute", top:8, left:8 }}>{i===0 ? "封面" : `P${i+1}`}</Chip>
                {done[i] && <div style={{ position:"absolute", bottom:8, right:8, display:"flex", gap:4 }}>
                  <button onClick={() => regenSingle(i)} style={{...S.iconBtn, width:26, height:26, background:"white", boxShadow:"var(--shadow1)"}}><I.Refresh size={12}/></button>
                  {images[i] && <a href={images[i]} download={`img_${i+1}.png`} style={{...S.iconBtn, width:26, height:26, background:"white", boxShadow:"var(--shadow1)", display:"grid", placeItems:"center", textDecoration:"none", color:"inherit"}}><I.Download size={12}/></a>}
                </div>}
              </div>
              <div style={{padding:10, borderTop:"1px solid var(--line)", display:"flex", flexDirection:"column", gap:8}}>
                <textarea style={{...S.input, minHeight:82, fontSize:11, lineHeight:1.5, resize:"vertical"}} value={editPrompts[i] || ""} onChange={e => setEditPrompts(list => { const next = [...list]; next[i] = e.target.value; return next; })} />
                <div style={{display:"flex", gap:8, alignItems:"center", justifyContent:"space-between"}}>
                  <label style={{fontSize:11, color:"var(--ink3)", cursor:"pointer"}}>
                    <input type="file" accept="image/*" style={{display:"none"}} onChange={e => uploadReference(i, e.target.files?.[0])}/>
                    {referenceImages[i] ? "已上传参考图" : "上传参考图"}
                  </label>
                  <Btn sm primary onClick={() => regenSingle(i)} disabled={!hasImageAI && !referenceImages[i] && !images[i]}><I.Magic size={11}/> 单张重绘</Btn>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{ display:"flex", justifyContent:"flex-end", marginTop:18 }}>
        <Btn primary style={{ padding:"11px 18px" }} disabled={!done.every(d=>d)} onClick={() => onNext({ images, imagePrompts: editPrompts })}>下一步：Agent 验证 <I.Arrow size={14}/></Btn>
      </div>
    </div>
  );
}

function Step5({ source }) {
  const topicTitle = source?.topics?.[0]?.title || source?.keyword || "手动选题";
  const note = source?.note || makeInputDrivenNote(source);
  const images = source?.images || [];
  const imagePrompts = source?.imagePrompts || [];
  const [saveStatus, setSaveStatus] = useState(null);
  const noteContent = [
    note.painOpen,
    ...(note.points || []),
    note.personalExp,
    note.suggestion,
    note.end,
    "",
    ...(note.tags || []),
  ].filter(Boolean).join("\n\n");

  const readStore = (key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const saveToLibrary = (status = "草稿") => {
    const notes = readStore("note-library");
    const nextNote = {
      id: Date.now(),
      title: note.hook || topicTitle,
      content: noteContent,
      tags: note.tags || [],
      status,
      account: "",
      addedAt: new Date().toISOString(),
      wordCount: noteContent.length,
      source: "素人爆文生成",
    };
    localStorage.setItem("note-library", JSON.stringify([nextNote, ...notes]));
    setSaveStatus(status === "待审核" ? "已保存到内容库，并进入待审核状态。" : "已保存到笔记内容库。");
  };

  const saveToMaterials = () => {
    const materials = readStore("material-pool");
    const promptPack = {
      id: Date.now(),
      type: "🤖Prompt",
      title: `${topicTitle} · 配图 Prompt 包`,
      content: imagePrompts.join("\n\n---\n\n"),
      tags: ["配图", "Prompt", source?.category || "小红书"],
      addedAt: new Date().toISOString(),
      used: 0,
    };
    localStorage.setItem("material-pool", JSON.stringify([promptPack, ...materials]));
    setSaveStatus("配图 Prompt 已保存到素材库。");
  };

  const downloadPackage = () => {
    const payload = {
      topic: topicTitle,
      note,
      imagePrompts,
      imageCount: images.filter(Boolean).length,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${topicTitle.replace(/[\\/:*?"<>|]/g, "_")}_素材包.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSaveStatus("素材包 JSON 已开始下载。");
  };

  return (
    <div>
      <Card style={{ background:"linear-gradient(95deg, oklch(0.95 0.04 165), oklch(0.99 0.005 80))", borderColor:"transparent" }}>
        <div style={{ display:"flex", gap:16, alignItems:"center" }}>
          <div style={{ width:48, height:48, borderRadius:14, background:"var(--mint)", color:"white", display:"grid", placeItems:"center", flex:"0 0 48px" }}><I.Check size={24}/></div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:16, fontWeight:700 }}>笔记已生成完成 🎉</div>
            <div style={{ fontSize:13, color:"var(--ink2)" }}>共 1 篇笔记 · {images.filter(Boolean).length || 6} 张图 · 约{noteContent.length}字 · 综合得分 89 · 痛点→方案→经验→标签</div>
          </div>
          <Btn onClick={saveToMaterials}><I.Library size={14}/> 存素材库</Btn>
          <Btn onClick={downloadPackage}><I.Download size={14}/> 下载素材包</Btn>
          <Btn primary onClick={() => saveToLibrary("待审核")}><I.Send size={14}/> 加入待审核</Btn>
        </div>
      </Card>
      {saveStatus && <div style={{ marginTop:10, padding:"8px 14px", borderRadius:8, background:"var(--mintSoft)", color:"var(--mintDeep)", fontSize:12, fontWeight:600 }}>✓ {saveStatus}</div>}
      <div style={{ marginTop:14, marginBottom:14, padding:"10px 14px", borderRadius:10, background:"var(--brandTint)", color:"var(--brandDeep)", fontSize:12, fontWeight:600 }}>本次素材主题：{topicTitle}</div>
      <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:14, marginTop:14 }}>
        <Card>
          <div style={S.cardTitle}>预览 & 编辑</div>
          <PhonePreview title={note.hook} body={[note.painOpen?.slice(0,70)+"…",...(note.points || []).map(p=>p.split("\n")[0]),"💬 "+(note.personalExp || "").slice(0,44)+"…","💡 "+(note.suggestion || "").slice(0,44)+"…"]} end={`${note.end}\n\n${(note.tags || []).join(" ")}`}/>
        </Card>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <Card>
            <div style={S.cardTitle}>落库操作</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:10}}>
              <Btn style={{justifyContent:"center"}} onClick={() => saveToLibrary("草稿")}><I.Doc size={14}/> 存草稿</Btn>
              <Btn primary style={{justifyContent:"center"}} onClick={() => saveToLibrary("待审核")}><I.Check size={14}/> 待审核</Btn>
            </div>
          </Card>
          <Card>
            <div style={S.cardTitle}>发布到</div>
            {["素人小红 · @素人小红 · 8.2w粉","公考新声 · @gkxs_2024 · 12.4w粉"].map((a,i) => (
              <label key={i} style={{ display:"flex", gap:10, padding:"10px 12px", border:"1px solid var(--line)", borderRadius:10, cursor:"pointer", alignItems:"center", marginTop:8 }}>
                <input type="checkbox" defaultChecked={i===0}/>
                <span style={{ fontSize:13, fontWeight:500 }}>{a}</span>
              </label>
            ))}
          </Card>
          <Card style={{ background:"var(--amberSoft)", borderColor:"transparent" }}>
            <div style={{ fontSize:13, fontWeight:700, color:"var(--amberDeep)", marginBottom:6 }}>⚠️ 合规建议</div>
            <div style={{ fontSize:12, lineHeight:1.7 }}>• 已通过敏感词检测<br/>• 建议互动收尾改为开放式问句<br/>• 3个账号同步发布建议错峰30分钟</div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Feature1() {
  const [step, setStep] = useState(1);
  const [max, setMax] = useState(1);
  const [source, setSource] = useState(null);
  const adv = n => { setStep(n); setMax(m=>Math.max(m,n)); };
  const nextFromTopics = data => { setSource(data); adv(2); };
  const mergeSource = data => setSource(s => ({ ...(s || {}), ...(data || {}) }));
  return (
    <div style={S.page}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:18 }}>
        <div><h1 style={S.pageH1}>素人爆文批量生成</h1><p style={S.pageSub}>一次生成多条经过 5 Agent 验证的真实分享笔记 · 含批量出图</p></div>
        <div style={{ display:"flex", gap:8 }}><Btn><I.Doc size={14}/> 历史任务</Btn><Btn><I.Help size={14}/> 看教程</Btn></div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"220px 1fr", gap:24 }}>
        <div>
          <StepRail steps={STEPS_F1} current={step} setCurrent={setStep} maxReached={max}/>
          <div style={{ marginTop:16, padding:12, background:"var(--surface3)", borderRadius:10, fontSize:11, color:"var(--ink3)" }}>
            <div style={{ fontWeight:700, color:"var(--ink2)", marginBottom:4 }}>💡 小贴士</div>
            任何步骤都可点击侧栏返回，已生成内容自动保留。
          </div>
        </div>
        <div>
          {step===1 && <Step1 onNext={nextFromTopics}/>}
          {step===2 && <Step3 source={source} onNext={(note) => { mergeSource({ note }); adv(3); }}/>}
          {step===3 && <Step4 source={source} onNext={(imageData) => { mergeSource(imageData); adv(4); }}/>}
          {step===4 && <Step2 source={source} onNext={() => adv(5)}/>}
          {step===5 && <Step5 source={source}/>}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════ Feature 3: 聚光投流 ═══════════════ */
const STEPS_F3 = [
  { id:1, name:"服务信息", desc:"列服务 + 亮点 + 优势" },
  { id:2, name:"受众定位", desc:"投放人群 + 场景" },
  { id:3, name:"笔记文案", desc:"好内容标准 · 真善美" },
  { id:4, name:"素材矩阵", desc:"多版本批量出图" },
  { id:5, name:"合规与导出", desc:"广告法检测 · 数据预估" },
];
function Feature3() {
  const { keys, routes } = useContext(ApiConfigContext);
  const [step, setStep] = useState(1);
  const [max, setMax] = useState(1);
  const adv = n => { setStep(n); setMax(m=>Math.max(m,n)); };
  const hasAI = isBackendMode() || Object.values(keys).some(k => k?.key);

  // Lifted state across steps
  const [serviceInfo, setServiceInfo] = useState({ name:"", industry:"母婴 · 早教课程", services:"", highlights:"", advantages:"", price:"", trust:"" });
  const [personas, setPersonas] = useState([]);
  const [painPoints, setPainPoints] = useState([]);
  const [adCopies, setAdCopies] = useState([]);
  const [imageMatrix, setImageMatrix] = useState([]);
  const [compliance, setCompliance] = useState(null);

  return (
    <div style={S.page}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:18 }}>
        <div><h1 style={S.pageH1}>聚光投流素材全流程</h1><p style={S.pageSub}>列服务 + 亮点 + 优势 → 多版本笔记 + 素材矩阵 + 合规检测一站式生成</p></div>
        {!hasAI && <Chip variant="amber" style={{ alignSelf:"start", fontSize:11 }}>⚡ 示例模式 · 配置 API Key 启用 AI</Chip>}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"220px 1fr", gap:24 }}>
        <div>
          <StepRail steps={STEPS_F3} current={step} setCurrent={setStep} maxReached={max}/>
          <div style={{ marginTop:16, padding:12, background:"var(--surface3)", borderRadius:10, fontSize:11, color:"var(--ink3)" }}>
            <div style={{ fontWeight:700, color:"var(--ink2)", marginBottom:4 }}>📐 内容标准</div>
            真 · 善 · 美 — 真实利他 · 围绕痛点 · 大白话表达
          </div>
        </div>
        <div>
          {step===1 && <F3S1 serviceInfo={serviceInfo} setServiceInfo={setServiceInfo} onNext={()=>adv(2)} keys={keys} routes={routes} hasAI={hasAI} setPersonas={setPersonas} setPainPoints={setPainPoints}/>}
          {step===2 && <F3S2 serviceInfo={serviceInfo} personas={personas} setPersonas={setPersonas} painPoints={painPoints} setPainPoints={setPainPoints} onNext={()=>adv(3)} keys={keys} routes={routes} hasAI={hasAI}/>}
          {step===3 && <F3S3 serviceInfo={serviceInfo} personas={personas} painPoints={painPoints} adCopies={adCopies} setAdCopies={setAdCopies} onNext={()=>adv(4)} keys={keys} routes={routes} hasAI={hasAI}/>}
          {step===4 && <F3S4 serviceInfo={serviceInfo} adCopies={adCopies} onNext={()=>adv(5)} keys={keys} routes={routes}/>}
          {step===5 && <F3S5 adCopies={adCopies} compliance={compliance} setCompliance={setCompliance} keys={keys} routes={routes} hasAI={hasAI}/>}
        </div>
      </div>
    </div>
  );
}

function F3S1({ serviceInfo, setServiceInfo, onNext, keys, routes, hasAI, setPersonas, setPainPoints }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [productBrief, setProductBrief] = useState(serviceInfo.name || "");
  const [kbItems, setKbItems] = useState([]);
  const [selectedKb, setSelectedKb] = useState("");
  const upd = (k,v) => setServiceInfo(s => ({...s, [k]:v}));

  useEffect(() => {
    try {
      const raw = localStorage.getItem("kb-items");
      if (raw) setKbItems(JSON.parse(raw));
    } catch {}
  }, []);

  const selectedKnowledge = kbItems.find(item => String(item.id) === String(selectedKb));
  const knowledgeText = selectedKnowledge ? [selectedKnowledge.title, selectedKnowledge.summary, selectedKnowledge.content].filter(Boolean).join("\n") : "";

  const applyServiceDraft = (draft) => {
    setServiceInfo(s => ({
      ...s,
      name: draft.name || productBrief || s.name,
      industry: draft.industry || s.industry,
      services: draft.services || s.services,
      highlights: draft.highlights || s.highlights,
      advantages: draft.advantages || s.advantages,
      price: draft.price || s.price,
      trust: draft.trust || s.trust,
    }));
  };

  const fallbackFill = () => {
    const name = productBrief.trim() || selectedKnowledge?.title || serviceInfo.name || "待投放产品";
    applyServiceDraft({
      name,
      services: selectedKnowledge?.summary || `围绕「${name}」整理核心服务/产品内容、适用场景、交付方式和用户能获得的结果。`,
      highlights: knowledgeText ? knowledgeText.slice(0, 180) : `突出「${name}」最容易被用户感知的卖点：省时间、有效果、易上手、有陪伴。`,
      advantages: "结合真实案例、用户反馈、服务流程、价格门槛和差异化优势，形成可投放的表达。",
      trust: selectedKnowledge?.title ? `参考知识库：${selectedKnowledge.title}` : "可补充用户数据、团队背景、案例反馈或平台评价。",
    });
  };

  const autoFillServiceInfo = async () => {
    if (!productBrief.trim() && !selectedKnowledge) return;
    setLoading(true); setError(null);
    if (!hasAI) {
      fallbackFill();
      setLoading(false);
      return;
    }
    try {
      const result = await callAI({ keys, routes, scene: "投流文案", maxTokens: 1200,
        systemPrompt: "你是小红书聚光投流策略专家。根据用户输入的产品/选题和可选知识库资料，补全投流前置服务信息。返回 JSON：{\"name\":\"产品/服务名称\",\"industry\":\"所属行业\",\"services\":\"列服务/产品内容\",\"highlights\":\"亮点\",\"advantages\":\"优势\",\"price\":\"客单价或价格区间\",\"trust\":\"信任背书\"}。只返回 JSON。",
        prompt: `产品/选题：${productBrief}\n\n知识库资料：\n${knowledgeText.slice(0, 5000)}\n\n请补全聚光投流素材生成需要的服务信息，内容必须以用户输入的产品或选题为主。`
      });
      const draft = JSON.parse(result.replace(/```json|```/g,"").trim());
      applyServiceDraft(draft);
    } catch(e) {
      setError(e.message?.slice(0,120) || "AI 自动补全失败，已使用兜底信息");
      fallbackFill();
    }
    setLoading(false);
  };

  const handleNext = async () => {
    if (!serviceInfo.name.trim() && (productBrief.trim() || selectedKnowledge)) {
      fallbackFill();
    }
    if (hasAI) {
      setLoading(true); setError(null);
      try {
        const result = await callAI({ keys, routes, scene: "投流文案", maxTokens: 1200,
          systemPrompt: "你是小红书投流专家。根据服务信息，生成目标人群画像和痛点。返回JSON：{\"personas\":[{\"name\":\"xxx\",\"age\":\"26-32\",\"emoji\":\"👶\",\"desc\":\"xxx\"},...], \"painPoints\":[{\"text\":\"xxx\",\"isCore\":true/false},...]}。只返回JSON。",
          prompt: `服务：${serviceInfo.name}\n行业：${serviceInfo.industry}\n服务内容：${serviceInfo.services}\n亮点：${serviceInfo.highlights}\n优势：${serviceInfo.advantages}\n客单价：${serviceInfo.price}\n\n请生成3-4个精准人群画像和5-6个用户痛点。`
        });
        try {
          const d = JSON.parse(result.replace(/```json|```/g,"").trim());
          if (d.personas) setPersonas(d.personas);
          if (d.painPoints) setPainPoints(d.painPoints);
        } catch { setError("AI返回格式异常，已使用默认数据"); }
      } catch(e) { setError(e.message); }
      setLoading(false);
    }
    onNext();
  };

  return (<div>
    <div style={S.banner}><div style={S.icoWrap}><I.Target size={16}/></div><div style={{flex:1}}><div style={{fontWeight:700}}>好内容标准：真 · 善 · 美</div><div style={{color:"var(--ink3)",fontSize:12}}><b>真</b>实利他 · <b>善</b>围绕用户痛点讲解决方案 · <b>美</b>说大白话</div></div></div>
    <Card style={{marginBottom:14,border:"1.5px solid var(--brand)"}}>
      <div style={S.cardH}><div><div style={S.cardTitle}>先确定产品/选题</div><div style={S.cardSub}>输入本次要投放的产品、服务或选题，AI 会先补齐下面的服务信息；也可以引用知识库资料。</div></div></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 220px",gap:12}}>
        <div>
          <span style={S.label}>产品 / 服务 / 选题</span>
          <input style={S.input} value={productBrief} onChange={e=>setProductBrief(e.target.value)} placeholder="例如：好梦星球婴幼儿睡眠训练课 / 千元平板选购指南 / 某款护肤精华投流"/>
        </div>
        <div>
          <span style={S.label}>引用知识库</span>
          <select style={S.input} value={selectedKb} onChange={e=>setSelectedKb(e.target.value)}>
            <option value="">不引用</option>
            {kbItems.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </div>
      </div>
      {selectedKnowledge && <div style={{marginTop:10,padding:"10px 12px",borderRadius:10,background:"var(--surface2)",fontSize:12,color:"var(--ink2)",lineHeight:1.6}}>
        <b>已选择：</b>{selectedKnowledge.title}<br/>{selectedKnowledge.summary}
      </div>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:12}}>
        <span style={{fontSize:11,color:"var(--ink3)"}}>没有配置 API Key 时会按产品/知识库生成一版可编辑的兜底信息。</span>
        <Btn primary disabled={loading || (!productBrief.trim() && !selectedKnowledge)} onClick={autoFillServiceInfo}>
          {loading ? "补全中…" : <><I.Magic size={14}/> AI 自动填服务信息</>}
        </Btn>
      </div>
    </Card>
    <Card>
      <div style={S.cardH}><div><div style={S.cardTitle}>服务信息确认</div><div style={S.cardSub}>这里由产品/选题和知识库自动生成，也支持手动修改；下一步将基于这些信息生成人群画像、痛点和投流文案。</div></div></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <div><span style={S.label}>服务/产品名称</span><input style={S.input} value={serviceInfo.name} onChange={e=>upd("name",e.target.value)}/></div>
        <div><span style={S.label}>所属行业</span><select style={S.input} value={serviceInfo.industry} onChange={e=>upd("industry",e.target.value)}><option>母婴 · 早教课程</option><option>美妆</option><option>美食</option><option>教育</option><option>3C数码</option><option>穿搭</option><option>家居</option></select></div>
        <div style={{gridColumn:"1/-1"}}><span style={S.label}>① 列服务</span><textarea style={{...S.input,minHeight:80}} value={serviceInfo.services} onChange={e=>upd("services",e.target.value)}/></div>
        <div><span style={S.label}>② 亮点</span><textarea style={{...S.input,minHeight:80}} value={serviceInfo.highlights} onChange={e=>upd("highlights",e.target.value)}/></div>
        <div><span style={S.label}>③ 优势</span><textarea style={{...S.input,minHeight:80}} value={serviceInfo.advantages} onChange={e=>upd("advantages",e.target.value)}/></div>
        <div><span style={S.label}>客单价</span><input style={S.input} value={serviceInfo.price} onChange={e=>upd("price",e.target.value)}/></div>
        <div><span style={S.label}>信任背书</span><input style={S.input} value={serviceInfo.trust} onChange={e=>upd("trust",e.target.value)}/></div>
      </div>
    </Card>
    {error && <div style={{marginTop:10,padding:"8px 14px",borderRadius:8,background:"oklch(0.96 0.04 25)",color:"var(--brandDeep)",fontSize:12}}>⚠ {error}</div>}
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:18}}>
      <Btn primary style={{padding:"13px 24px",fontSize:14}} disabled={loading || (!serviceInfo.name.trim() && !productBrief.trim() && !selectedKnowledge)} onClick={handleNext}>
        {loading ? "⏳ AI 分析中…" : <>下一步：AI 生成受众画像 <I.Arrow size={14}/></>}
      </Btn>
    </div>
  </div>);
}

function F3S2({ serviceInfo, personas, setPersonas, painPoints, setPainPoints, onNext, keys, routes, hasAI }) {
  const defaultPersonas = [{name:"新手宝妈",age:"26-32",emoji:"👶",desc:"第一次当妈，信息焦虑",on:true},{name:"二胎妈妈",age:"30-38",emoji:"👩",desc:"时间不够用",on:true},{name:"祖辈带娃",age:"55+",emoji:"👵",desc:"传统观念",on:false},{name:"准爸爸",age:"28-35",emoji:"👨",desc:"想帮忙但不知道怎么做",on:false}];
  const defaultPains = [{text:"夜醒频繁，自己睡眠严重不足",isCore:true},{text:"信息爆炸，不知道哪个建议靠谱",isCore:true},{text:"宝宝睡眠倒退期束手无策",isCore:true},{text:"线下培训贵，还要带娃出门",isCore:false}];
  const ps = personas.length > 0 ? personas.map((p,i)=>({...p,on:i<2})) : defaultPersonas;
  const pts = painPoints.length > 0 ? painPoints : defaultPains;
  const [selPersonas, setSelPersonas] = useState(ps.map(p=>p.on!==false));
  const [selPains, setSelPains] = useState(pts.map(p=>p.isCore!==false));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const regenPersonas = async () => {
    if (!hasAI) return;
    setLoading(true); setError(null);
    try {
      const result = await callAI({ keys, routes, scene: "投流文案", maxTokens: 800,
        systemPrompt: "根据服务信息生成4个投放人群画像。返回JSON数组：[{\"name\":\"xxx\",\"age\":\"26-32\",\"emoji\":\"👶\",\"desc\":\"xxx\"},...]。只返回JSON数组。",
        prompt: `服务：${serviceInfo.name}\n行业：${serviceInfo.industry}\n内容：${serviceInfo.services}\n请生成4个精准人群画像。`
      });
      const parsed = JSON.parse(result.replace(/```json|```/g,"").trim());
      if (Array.isArray(parsed)) { setPersonas(parsed); setSelPersonas(parsed.map((_,i)=>i<2)); }
    } catch(e) { setError(e.message?.slice(0,100)); }
    setLoading(false);
  };

  const colors = ["var(--brand)","oklch(0.7 0.16 290)","var(--mint)","var(--sky)","var(--amber)"];
  return (<div>
    <Card style={{marginBottom:14}}>
      <div style={S.cardH}><div><div style={S.cardTitle}>投放人群画像</div><div style={S.cardSub}>勾选 1-2 个核心人群，AI 将针对性生成文案</div></div><Btn sm onClick={regenPersonas} disabled={!hasAI||loading}><I.Magic size={12}/> {loading?"生成中…":"AI重新生成"}</Btn></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
        {ps.map((p,i) => <button key={i} onClick={()=>setSelPersonas(s=>{const n=[...s];n[i]=!n[i];return n;})} style={{textAlign:"left",padding:14,borderRadius:12,border:`1.5px solid ${selPersonas[i]?"var(--brand)":"var(--line)"}`,background:selPersonas[i]?"var(--brandTint)":"var(--surface)",cursor:"pointer"}}>
          <div style={{width:40,height:40,borderRadius:12,background:colors[i%5],display:"grid",placeItems:"center",fontSize:20,marginBottom:8}}>{p.emoji||"👤"}</div>
          <div style={{fontWeight:700,fontSize:14}}>{p.name}</div>
          <div style={{fontSize:11,color:"var(--ink3)",marginTop:2}}>{p.age||""} {p.desc||""}</div>
          {selPersonas[i] && <div style={{marginTop:8,fontSize:10,color:"var(--brandDeep)",fontWeight:700}}>✓ 已选</div>}
        </button>)}
      </div>
    </Card>
    <Card>
      <div style={S.cardH}><div><div style={S.cardTitle}>围绕用户痛点 · 善 · 解决问题</div></div></div>
      {pts.map((p,i) => (
        <label key={i} style={{display:"flex",gap:10,padding:"10px 14px",borderRadius:10,border:"1px solid var(--line)",background:selPains[i]?"var(--brandTint)":"var(--surface)",cursor:"pointer",alignItems:"center",marginBottom:8}}>
          <input type="checkbox" checked={selPains[i]} onChange={()=>setSelPains(s=>{const n=[...s];n[i]=!n[i];return n;})}/>
          <span style={{fontSize:13,flex:1}}>{p.text}</span>
          {selPains[i] && <Chip variant="brand" style={{fontSize:10}}>核心痛点</Chip>}
        </label>
      ))}
    </Card>
    {error && <div style={{marginTop:10,padding:"8px 14px",borderRadius:8,background:"oklch(0.96 0.04 25)",color:"var(--brandDeep)",fontSize:12}}>⚠ {error}</div>}
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:18}}>
      <Btn primary style={{padding:"13px 24px",fontSize:14}} disabled={!selPersonas.some(s=>s)} onClick={onNext}>
        下一步：AI 生成投流笔记 <I.Arrow size={14}/>
      </Btn>
    </div>
  </div>);
}

function F3S3({ serviceInfo, personas, painPoints, adCopies, setAdCopies, onNext, keys, routes, hasAI }) {
  const [active,setActive]=useState(0);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);

  const defaultCopies = [
    {tag:"新手宝妈 · 夜醒崩溃",title:"新手妈妈夜醒6次崩溃｜这套睡眠方案我用了一周就见效",painHook:"上周刷到一个宝妈凌晨3点发的朋友圈：「宝宝3个月了，每晚醒6次，我真的要疯了」。底下一堆妈妈说「我也是」。姐妹你是不是也这样？别慌，我之前比你更惨，但现在娃能睡整觉了👇",effectShow:"用了这套方法第5天，娃从夜醒6次降到2次。第10天开始睡整觉。不是玄学，是有科学依据的系统训练。",servicePoints:["1️⃣ 21天系统睡眠课\n不是那种「放下就走」的粗暴方法。从白天作息到夜间接觉一步步来温和不哭","2️⃣ 1对1专属睡眠顾问\n你家娃几个月什么气质类型目前夜醒模式，顾问会给你出专属方案","3️⃣ 24小时妈妈社群\n凌晨3点娃醒了不知道怎么办群里随时有人回","4️⃣ 配套月龄作息表\n0-12月每个阶段该睡多久怎么安排白天小睡一张表搞定","5️⃣ 无效全额退款\n21天没改善直接退没有附加条件"],trustProof:"已经帮 8w+ 家庭改善了宝宝睡眠，复购率 68%。教研团队有北师大儿童发展背景。",cta:"如果你家娃也夜醒频繁，评论区扣「夜醒」两个字，我发你一份免费的月龄睡眠自测表～",tags:["#宝宝睡眠训练","#夜醒解决方案","#新手妈妈必看","#婴儿睡整觉","#科学育儿","#21天睡眠课"]},
    {tag:"二胎妈妈 · 时间不够",title:"二胎妈妈别硬撑｜21天睡眠训练帮我每天多睡3小时",painHook:"二胎妈妈最大的奢侈品不是包，是「睡一个整觉」。老大还没哄睡老二又醒了，你是不是也在这个死循环里？",effectShow:"用了3周时间老大学会了自己关灯睡老二从夜醒4次到偶尔1次。我每天多睡了3个小时。",servicePoints:["1️⃣ 录播课碎片时间看\n每节15分钟喂奶时就能看完一节","2️⃣ 双娃作息错峰方案\n课程专门有模块讲两个娃怎么错开哄睡时间","3️⃣ 1对1顾问出方案\n两个不同月龄的娃怎么同时调整单独出表","4️⃣ 老大独立入睡训练\n3岁以上大娃有单独引导方法","5️⃣ 家人协作指南\n怎么让队友和老人配合你的训练节奏"],trustProof:"学员里二胎妈妈占比 43%。无效全额退款。",cta:"二胎妈妈们你们每天能睡几个小时？评论区聊聊～",tags:["#二胎妈妈","#睡眠训练","#双娃哄睡","#科学育儿","#妈妈自救","#独立入睡"]}
  ];

  const copies = adCopies.length > 0 ? adCopies : defaultCopies;
  const v = copies[active % copies.length];
  const wordCount = v ? (v.painHook + v.effectShow + v.servicePoints.join("") + v.trustProof + v.cta).length : 0;

  const generateCopies = async () => {
    if (!hasAI) return;
    setLoading(true); setError(null);
    try {
      const result = await callAI({ keys, routes, scene: "投流文案", maxTokens: 3000,
        systemPrompt: `你是小红书聚光投流文案专家。按照以下6段式结构生成投流笔记，每篇＜1000字：
① 场景痛点钩子：真实生活场景切入，3秒共鸣
② 效果展示：具体数字+时间线前后对比
③ 服务亮点FAB分点：5个编号要点，每点用FAB法则（属性→优势→益处）
④ 信任背书：用户数据、复购率、团队背景
⑤ 行动指令+互动收尾：给出具体行动降低门槛
⑥ 话题标签：6-7个精准标签

返回JSON数组：[{"tag":"人群标签","title":"标题","painHook":"xxx","effectShow":"xxx","servicePoints":["1️⃣ xxx\\nxxx",...5个],"trustProof":"xxx","cta":"xxx","tags":["#xxx",...]}]
生成2-3个版本，每个版本针对不同人群。只返回JSON。`,
        prompt: `服务信息：\n名称：${serviceInfo.name}\n行业：${serviceInfo.industry}\n服务：${serviceInfo.services}\n亮点：${serviceInfo.highlights}\n优势：${serviceInfo.advantages}\n客单价：${serviceInfo.price}\n信任背书：${serviceInfo.trust}\n\n目标人群：${personas.map(p=>p.name).join("、")}\n核心痛点：${painPoints.filter(p=>p.isCore).map(p=>p.text).join("、")}\n\n请生成3个版本的投流笔记。`
      });
      const parsed = JSON.parse(result.replace(/```json|```/g,"").trim());
      if (Array.isArray(parsed) && parsed.length > 0) { setAdCopies(parsed); setActive(0); }
    } catch(e) { setError(e.message?.slice(0,120)); }
    setLoading(false);
  };

  return (<div>
    <div style={S.banner}><div style={S.icoWrap}><I.Bolt size={16}/></div><div style={{flex:1}}><div style={{fontWeight:700}}>最优投流文案结构（6段式）</div><div style={{color:"var(--ink3)",fontSize:12}}>场景痛点钩子 → 效果展示 → 服务亮点FAB → 信任背书 → 行动指令 → 标签</div></div><span style={{fontSize:11,fontFamily:"var(--mono)",color:"var(--ink3)"}}>约{wordCount}字 / ＜1000</span></div>
    <Card style={{marginBottom:14}}>
      <div style={S.cardH}><div><div style={S.cardTitle}>{copies.length > 0 ? `已生成 ${copies.length} 个版本投流笔记` : "点击生成投流笔记"}</div><div style={S.cardSub}>场景切入 + 效果展示 + FAB服务 + 信任背书 + 行动指令 + 标签</div></div>
        <Btn sm onClick={generateCopies} disabled={!hasAI||loading}>{loading ? "生成中…" : <><I.Magic size={12}/> {adCopies.length>0?"全部重生成":"AI 生成文案"}</>}</Btn>
      </div>
      {copies.length > 0 && <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {copies.map((c,i) => <button key={i} onClick={()=>setActive(i)} style={{padding:"8px 12px",borderRadius:10,border:`1.5px solid ${i===active?"var(--brand)":"var(--line)"}`,background:i===active?"var(--brandTint)":"var(--surface)",fontSize:12,fontWeight:600,cursor:"pointer"}}>
          <span style={{fontFamily:"var(--mono)",color:"var(--ink4)",marginRight:6}}>0{i+1}</span>{c.tag||`版本${i+1}`}
        </button>)}
      </div>}
    </Card>
    {v && <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:14}}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Card style={{borderLeft:"3px solid var(--brand)"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><Chip variant="brand">① 场景痛点钩子</Chip></div><div style={{fontSize:14,lineHeight:1.7}}>{v.painHook}</div></Card>
        <Card style={{borderLeft:"3px solid var(--mint)"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><Chip variant="mint">② 效果展示 · 前后对比</Chip></div><div style={{fontSize:14,lineHeight:1.7}}>{v.effectShow}</div></Card>
        <Card style={{borderLeft:"3px solid var(--sky)"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><Chip variant="sky">③ 服务亮点 · FAB分点</Chip></div>{v.servicePoints.map((p,i)=><div key={i} style={{padding:"10px 0",borderBottom:i===v.servicePoints.length-1?"none":"1px dashed var(--line)",fontSize:13,lineHeight:1.65,whiteSpace:"pre-wrap"}}>{p}</div>)}</Card>
        <Card style={{borderLeft:"3px solid var(--amber)"}}><Chip variant="amber" style={{marginBottom:8}}>④ 信任背书</Chip><div style={{fontSize:14,lineHeight:1.7}}>{v.trustProof}</div></Card>
        <Card style={{borderLeft:"3px solid oklch(0.7 0.16 290)"}}><Chip variant="violet" style={{marginBottom:8}}>⑤ 行动指令 + 互动收尾</Chip><div style={{fontSize:14,lineHeight:1.7,fontStyle:"italic"}}>{v.cta}</div></Card>
        <div style={{padding:12,background:"var(--surface3)",borderRadius:10}}><div style={{fontSize:11,fontWeight:700,color:"var(--ink2)",marginBottom:6}}>📌 话题标签（结尾附加）</div><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{(v.tags||[]).map(t => <Chip key={t} variant="brand" style={{fontSize:11}}>{t}</Chip>)}</div></div>
      </div>
      <div><div style={{fontSize:12,fontWeight:600,color:"var(--ink2)",marginBottom:8,textAlign:"center"}}>实时预览</div><PhonePreview title={v.title} body={[v.painHook?.slice(0,55)+"…","🎯 "+v.effectShow?.slice(0,40)+"…",...(v.servicePoints||[]).map(p=>p.split("\n")[0]),"🏅 "+v.trustProof?.slice(0,35)+"…"]} end={v.cta?.slice(0,50)+"…\n\n"+(v.tags||[]).join(" ")}/></div>
    </div>}
    {error && <div style={{marginTop:10,padding:"8px 14px",borderRadius:8,background:"oklch(0.96 0.04 25)",color:"var(--brandDeep)",fontSize:12}}>⚠ {error}</div>}
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:18}}>
      <Btn primary style={{padding:"13px 24px",fontSize:14}} onClick={onNext}>下一步：批量出图 <I.Arrow size={14}/></Btn>
    </div>
  </div>);
}

function F3S4({ serviceInfo, adCopies, onNext, keys, routes }) {
  const imageRoute = routes?.find(r => r.scene === "图片生成") || SCENE_ROUTES_DEFAULT.find(r => r.scene === "图片生成");
  const imageProvider = MODEL_REGISTRY.find(p => p.id === imageRoute?.primary);
  const hasImageAI = imageRoute?.primary === "openai" && (isBackendMode() || !!keys?.openai?.key);
  const copies = adCopies.length > 0 ? adCopies : [{tag:"版本1"},{tag:"版本2"}];
  const treats = ["实拍·大字报","清单·表格风","对比·B/A","信任·数据卡"];
  const [images, setImages] = useState({});
  const [cellPrompts, setCellPrompts] = useState({});
  const [referenceImages, setReferenceImages] = useState({});
  const [loading, setLoading] = useState({});
  const [error, setError] = useState(null);

  const stylePrefix = `【统一风格】小红书聚光投流主图，3:4竖版比例，干净专业的信息图风格，浅色背景（米白/浅粉），大号中文标题，圆角卡片布局，统一色调。产品/服务：${serviceInfo?.name||""}。`;

  const genImage = async (row, col) => {
    const key = `${row}-${col}`;
    if (!hasImageAI) { setLoading(l=>({...l,[key]:true})); await new Promise(r=>setTimeout(r,800)); setLoading(l=>({...l,[key]:false})); setImages(m=>({...m,[key]:"placeholder"})); return; }
    setLoading(l => ({...l,[key]:true}));
    try {
      const copy = copies[row] || {};
      const prompt = `${stylePrefix}\n风格：${treats[col]}。\n人群：${copy.tag||""}。\n标题文字：「${copy.title?.slice(0,20)||serviceInfo?.name||""}」`;
      const sourceImages = [referenceImages[key], images[key] && images[key] !== "placeholder" ? images[key] : null].filter(Boolean);
      const urls = sourceImages.length > 0
        ? await callImageEdit({ keys, routes, prompt: cellPrompts[key] || prompt, images: sourceImages, size:"768x1024", quality:"low" })
        : await callImageGen({ keys, routes, prompt: cellPrompts[key] || prompt, size:"768x1024", quality:"low", n:1 });
      setImages(m => ({...m,[key]: urls[0] || "placeholder"}));
    } catch(e) { setError(e.message?.slice(0,100)); setImages(m=>({...m,[key]:"placeholder"})); }
    setLoading(l => ({...l,[key]:false}));
  };

  const genAll = async () => { setError(null); for(let r=0;r<Math.min(copies.length,3);r++) for(let c=0;c<4;c++) await genImage(r,c); };
  const uploadReference = async (key, file) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setReferenceImages(prev => ({...prev, [key]: dataUrl}));
    } catch (e) {
      setError(e.message?.slice(0,100) || "参考图读取失败");
    }
  };

  return (<div>
    <Card style={{marginBottom:14}}>
      <div style={{display:"flex",gap:12,alignItems:"center"}}>
        <div style={{width:36,height:36,borderRadius:10,background:"oklch(0.7 0.16 290)",color:"white",display:"grid",placeItems:"center",flex:"0 0 36px"}}><I.Layers size={18}/></div>
        <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14}}>素材矩阵 · {Math.min(copies.length,3)} 人群 × 4 风格 = {Math.min(copies.length,3)*4} 张主图</div><div style={{fontSize:12,color:"var(--ink3)"}}>{hasImageAI ? `✓ 图片生成 · ${imageProvider?.name || "OpenAI"} / ${imageRoute?.model || "gpt-image-2"} · 3:4竖版` : "⚡ 图片生成未配置可用 OpenAI Key · 点击生成为占位图"}</div></div>
        <Btn primary onClick={genAll}><I.Magic size={14}/> 全部生成</Btn>
      </div>
    </Card>
    {error && <div style={{marginBottom:10,padding:"8px 14px",borderRadius:8,background:"oklch(0.96 0.04 25)",color:"var(--brandDeep)",fontSize:12}}>⚠ {error}</div>}
    <Card>
      <div style={{display:"grid",gridTemplateColumns:"180px repeat(4,1fr)",gap:10}}>
        <div/>{treats.map(t => <div key={t} style={{fontSize:11,fontWeight:700,color:"var(--ink2)",textAlign:"center"}}>{t}</div>)}
        {copies.slice(0,3).map((row,ri) => <React.Fragment key={ri}>
          <div style={{fontSize:12,fontWeight:600,display:"flex",alignItems:"center"}}><Chip variant="brand" style={{fontSize:10}}>人群 {ri+1}</Chip><span style={{marginLeft:6}}>{row.tag||""}</span></div>
          {[0,1,2,3].map(ci => { const key=`${ri}-${ci}`; return <div key={ci} style={{position:"relative",cursor:"pointer"}} onClick={()=>genImage(ri,ci)}>
            {images[key] && images[key]!=="placeholder" ? <img src={images[key]} style={{width:"100%",aspectRatio:"3/4",objectFit:"cover",borderRadius:8}}/> : <ImgPh variant={["brand","amber","mint","violet"][ci]} style={{aspectRatio:"3/4",fontSize:10,fontWeight:600}}>{loading[key] ? "生成中…" : images[key] ? "[ 占位图 ]" : "[ 点击生成 ]"}</ImgPh>}
            {loading[key] && <div style={{position:"absolute",inset:0,display:"grid",placeItems:"center",background:"rgba(255,255,255,0.6)"}}><div style={{width:24,height:24,borderRadius:"50%",border:"3px solid var(--brand)",borderTopColor:"transparent",animation:"spin 0.9s linear infinite"}}/></div>}
          </div>;})}
        </React.Fragment>)}
      </div>
    </Card>
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:18}}><Btn primary style={{padding:"13px 24px",fontSize:14}} onClick={onNext}>下一步：合规与导出 <I.Arrow size={14}/></Btn></div>
  </div>);
}

function F3S5({ adCopies, compliance, setCompliance, keys, routes, hasAI }) {
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const copies = adCopies.length > 0 ? adCopies : [];
  const defaultCompliance = {issues:[{word:"最有效",level:"高风险",note:"已替换为「真的好用」"},{word:"100%见效",level:"高风险",note:"已替换为「我用一周明显改善」"},{word:"国家级",level:"中风险",note:"建议改为「专家团队认证」"}],stats:{totalWords:4238,hits:3},estimates:{impressions:"21.4w",clicks:"8,254",leads:"412",cpl:"¥1.94"}};
  const comp = compliance || defaultCompliance;

  const runCompliance = async () => {
    if (!hasAI) { setCompliance(defaultCompliance); return; }
    setLoading(true); setError(null);
    try {
      const allText = copies.map(c => [c.title,c.painHook,c.effectShow,...(c.servicePoints||[]),c.trustProof,c.cta].join("\n")).join("\n\n");
      const result = await callAI({ keys, routes, scene: "合规检测", maxTokens: 1000,
        systemPrompt: "你是小红书广告法合规检测专家。检测文案中的广告法违规词和敏感表述。返回JSON：{\"issues\":[{\"word\":\"xxx\",\"level\":\"高风险/中风险\",\"note\":\"改写建议\"},...],\"stats\":{\"totalWords\":数字,\"hits\":数字},\"estimates\":{\"impressions\":\"21w\",\"clicks\":\"8000\",\"leads\":\"400\",\"cpl\":\"¥2.00\"}}。只返回JSON。",
        prompt: `请检测以下${copies.length}篇投流笔记的合规性：\n\n${allText}`
      });
      const parsed = JSON.parse(result.replace(/```json|```/g,"").trim());
      setCompliance(parsed);
    } catch(e) { setError(e.message?.slice(0,100)); setCompliance(defaultCompliance); }
    setLoading(false);
  };

  useEffect(() => { if(!compliance) runCompliance(); }, []);

  return (<div>
    <Card style={{background:"linear-gradient(95deg, oklch(0.95 0.04 165), oklch(0.99 0.005 80))",borderColor:"transparent",marginBottom:14}}>
      <div style={{display:"flex",gap:16,alignItems:"center"}}>
        <div style={{width:48,height:48,borderRadius:14,background:"var(--mint)",color:"white",display:"grid",placeItems:"center",flex:"0 0 48px"}}><I.Shield size={22}/></div>
        <div style={{flex:1}}><div style={{fontSize:16,fontWeight:700}}>合规检测{comp.issues?.length>0?` · 发现 ${comp.issues.length} 处问题`:" · 检测中"}</div><div style={{fontSize:13,color:"var(--ink2)"}}>共 {copies.length||6} 篇笔记 · 每篇＜1000字 · 6段式结构 · 标签结尾</div></div>
        <Btn onClick={runCompliance} disabled={loading}>{loading ? "检测中…" : <><I.Refresh size={14}/> 重新检测</>}</Btn>
        <Btn><I.Download size={14}/> 导出投放包</Btn>
        <Btn primary><I.Send size={14}/> 同步到聚光后台</Btn>
      </div>
    </Card>
    {error && <div style={{marginBottom:10,padding:"8px 14px",borderRadius:8,background:"oklch(0.96 0.04 25)",color:"var(--brandDeep)",fontSize:12}}>⚠ {error}</div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
      <Card>
        <div style={S.cardTitle}>敏感词检测 · 已自动改写</div>
        {(comp.issues||[]).map((s,i) =>
          <div key={i} style={{padding:"10px 12px",border:"1px solid var(--line)",borderRadius:10,display:"flex",gap:10,alignItems:"flex-start",marginTop:8}}>
            <Chip variant={s.level==="高风险"?"brand":"amber"} style={{fontSize:10}}>{s.level}</Chip>
            <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>"{s.word}"</div><div style={{fontSize:12,color:"var(--ink3)",marginTop:2}}>{s.note}</div></div>
          </div>
        )}
        <div style={{marginTop:12,padding:"10px 12px",background:"var(--mintSoft)",color:"var(--mintDeep)",borderRadius:10,fontSize:12,fontWeight:600}}>✓ 共扫描 {comp.stats?.totalWords||"—"} 字 · 命中 {comp.stats?.hits||0} 处 · 已全部自动改写</div>
      </Card>
      <Card>
        <div style={S.cardTitle}>投流效果预估</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}>
          {[{l:"预估展现",v:comp.estimates?.impressions||"—",s:"日预算800元"},{l:"预估点击",v:comp.estimates?.clicks||"—",s:"CTR 3.86%"},{l:"预估表单",v:comp.estimates?.leads||"—",s:"转化率4.99%"},{l:"预估CPL",v:comp.estimates?.cpl||"—",s:"行业均值¥3.20"}].map(p =>
            <div key={p.l} style={{padding:14,background:"var(--surface3)",borderRadius:12}}><div style={{fontSize:11,color:"var(--ink3)",fontWeight:600}}>{p.l}</div><div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700,marginTop:4}}>{p.v}</div><div style={{fontSize:11,color:"var(--ink3)"}}>{p.s}</div></div>
          )}
        </div>
      </Card>
    </div>
  </div>);
}

/* ═══════════════ Settings ═══════════════ */
const PROVIDER_LINKS = {
  anthropic: { console: "https://console.anthropic.com/settings/keys", help: "需开通海外手机号注册并充值；CORS 已默认允许浏览器直连。" },
  openai: { console: "https://platform.openai.com/api-keys", help: "图片生成必须使用 OpenAI；浏览器直连受 OpenAI CORS 限制，建议挂代理。" },
  doubao: { console: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", help: "火山方舟控制台开通豆包模型后创建 API Key；多数情况下需自建代理转发。" },
  qwen: { console: "https://bailian.console.aliyun.com/?apiKey=1", help: "阿里云百炼开通通义千问后获取 Key；建议自建代理。" },
  deepseek: { console: "https://platform.deepseek.com/api_keys", help: "DeepSeek 平台直接申请；浏览器多数会撞 CORS，建议自建代理。" },
  zhipu: { console: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys", help: "智谱 BigModel 开放平台获取 Key；建议自建代理。" },
};

function SettingsPage() {
  const { keys, routes, saveKeys, saveRoutes, getStatus, backendHealth } = useContext(ApiConfigContext);
  const backendUrl = getBackendBase();
  const [tab,setTab]=useState("models");
  const [editing,setEditing]=useState(null);
  const [editKey,setEditKey]=useState("");
  const [editBase,setEditBase]=useState("");
  const [testing,setTesting]=useState(false);
  const [testResult,setTestResult]=useState(null);
  const [showKey,setShowKey]=useState({});
  const [corsProxy, setCorsProxy] = useState("");

  useEffect(() => {
    try { setCorsProxy(localStorage.getItem("kb-cors-proxy") || ""); } catch {}
  }, []);

  const startEdit = (id) => { setEditing(id); setEditKey(keys[id]?.key || ""); setEditBase(keys[id]?.baseUrl || ""); setTestResult(null); };
  const cancelEdit = () => { setEditing(null); setEditKey(""); setEditBase(""); setTestResult(null); };

  const handleTest = async (id) => {
    setTesting(true); setTestResult(null);
    try {
      await testApiKey(id, editKey, editBase);
      setTestResult({ ok: true, msg: "连接成功！模型返回正常" });
    } catch(e) {
      setTestResult({ ok: false, msg: e.message?.slice(0, 160) || "连接失败" });
    }
    setTesting(false);
  };

  const handleSave = async (id) => {
    const newKeys = { ...keys, [id]: { key: editKey, baseUrl: editBase || undefined, verified: testResult?.ok || false, savedAt: new Date().toISOString() } };
    await saveKeys(newKeys);
    setEditing(null); setEditKey(""); setEditBase(""); setTestResult(null);
  };

  const handleDelete = async (id) => {
    const newKeys = { ...keys }; delete newKeys[id];
    await saveKeys(newKeys);
  };

  const handleRouteChange = async (sceneIdx, field, value) => {
    const newRoutes = routes.map((r,i) => i===sceneIdx ? { ...r, [field]: value } : r);
    await saveRoutes(newRoutes);
  };

  const saveCorsProxy = (val) => {
    setCorsProxy(val);
    try { localStorage.setItem("kb-cors-proxy", val.trim()); } catch {}
  };

  const maskKey = (k) => k ? k.slice(0,8) + "•".repeat(Math.max(0,k.length-12)) + k.slice(-4) : "";

  const connectedCount = MODEL_REGISTRY.filter(p => getStatus(p.id)==="已连接").length;

  return (<div style={S.page}>
    <h1 style={S.pageH1}>设置中心</h1>
    <p style={S.pageSub}>接入各家大模型 API Key，配置完成后即可在生成流程中调用真实 AI</p>

    {/* 连接状态总览 */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:18}}>
      <div style={S.stat}><div style={S.statLabel}>已接入模型</div><div style={{...S.statValue,fontSize:24}}>{connectedCount} / {MODEL_REGISTRY.length}</div></div>
      <div style={S.stat}><div style={S.statLabel}>文本生成</div><div style={{...S.statValue,fontSize:24,color:connectedCount>0?"var(--mintDeep)":"var(--ink3)"}}>{connectedCount>0?"就绪":"未配置"}</div></div>
      <div style={S.stat}><div style={S.statLabel}>图片生成 (GPT Image 2)</div><div style={{...S.statValue,fontSize:24,color:getStatus("openai")==="已连接"?"var(--mintDeep)":"var(--ink3)"}}>{getStatus("openai")==="已连接"?"就绪":"未配置"}</div></div>
    </div>

    <div style={{display:"flex",gap:4,borderBottom:"1px solid var(--line)",marginBottom:16}}>
      {[{id:"models",label:"模型接入 · API Keys"},{id:"routing",label:"场景路由"},{id:"network",label:"网络/代理"}].map(t => <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"9px 14px",fontSize:13,fontWeight:600,whiteSpace:"nowrap",color:tab===t.id?"var(--ink)":"var(--ink3)",border:"none",background:"transparent",borderBottom:tab===t.id?"2px solid var(--brand)":"2px solid transparent",marginBottom:-1,cursor:"pointer"}}>{t.label}</button>)}
    </div>

    {tab==="models" && <div>
      {backendUrl && backendHealth?.ok && <Card style={{marginBottom:14, background:"linear-gradient(95deg, var(--mintSoft), oklch(0.99 0.005 80))", borderColor:"transparent"}}>
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <div style={{...S.icoWrap, background:"var(--mint)", flex:"0 0 32px"}}><I.Check size={16}/></div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4,color:"var(--mintDeep)"}}>✓ 已接入托管后端 · 开箱即用</div>
            <div style={{fontSize:12,color:"var(--ink2)",lineHeight:1.7}}>
              当前站点已连接到管理员配置的 Worker 后端（<code style={{fontFamily:"var(--mono)",background:"var(--surface3)",padding:"0 4px",borderRadius:3}}>{backendUrl}</code>），无需自行配置 API Key 即可使用全部 AI 能力。<br/>
              已就绪厂商：{(backendHealth.providers || []).map(p => <Chip key={p} variant="mint" style={{fontSize:11,marginRight:6}}>{MODEL_REGISTRY.find(m=>m.id===p)?.name || p}</Chip>)}
              {(!backendHealth.providers || backendHealth.providers.length === 0) && <span style={{color:"var(--brandDeep)"}}>⚠ 后端未配置任何模型密钥，请联系管理员</span>}
              <br/><span style={{fontSize:11,color:"var(--ink3)"}}>下方仍可填入个人 Key 覆盖托管后端（仅当前浏览器生效）。</span>
            </div>
          </div>
        </div>
      </Card>}
      {backendUrl && backendHealth && !backendHealth.ok && <Card style={{marginBottom:14, background:"oklch(0.96 0.04 25)", borderColor:"transparent"}}>
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <div style={{...S.icoWrap, background:"var(--brand)", flex:"0 0 32px"}}><I.Help size={16}/></div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4,color:"var(--brandDeep)"}}>托管后端不可达</div>
            <div style={{fontSize:12,color:"var(--ink2)",lineHeight:1.7}}>
              已配置 VITE_BACKEND_URL = <code style={{fontFamily:"var(--mono)"}}>{backendUrl}</code> 但 /health 检查失败：{backendHealth.error}。请联系管理员，或在下方填入个人 API Key 临时使用。
            </div>
          </div>
        </div>
      </Card>}
      {!backendUrl && <Card style={{marginBottom:14, background:"linear-gradient(95deg, var(--brandTint), oklch(0.99 0.005 80))", borderColor:"transparent"}}>
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <div style={{...S.icoWrap, background:"var(--brand)", flex:"0 0 32px"}}><I.Bolt size={16}/></div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>30 秒接入指南</div>
            <div style={{fontSize:12,color:"var(--ink2)",lineHeight:1.7}}>
              <b>新手最短路径</b>：① 注册 <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{color:"var(--brandDeep)"}}>Anthropic</a> 拿到 Key（文本生成，CORS 已开放）→ ② 注册 <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{color:"var(--brandDeep)"}}>OpenAI</a>（图片生成必需）→ ③ 在下方对应卡片填入 Key 并测试连接 → 立刻可用。<br/>
              <b>遇到 CORS 报错？</b>切到「网络/代理」标签部署一个 Cloudflare Worker（已附模板，2 分钟），把 Worker URL 填到对应模型卡的「自定义 BaseURL」即可。<br/>
              <b>想给团队/客户开箱即用？</b>看 worker/ 目录下的 Cloudflare Worker 后端，部署后用 <code style={{fontFamily:"var(--mono)",background:"var(--surface3)",padding:"0 4px",borderRadius:3}}>VITE_BACKEND_URL</code> 重新构建即可让所有访客零配置使用。
            </div>
          </div>
        </div>
      </Card>}
      <div style={S.banner}><div style={S.icoWrap}><I.Shield size={16}/></div><div style={{flex:1}}><div style={{fontWeight:700}}>API Key 安全说明</div><div style={{color:"var(--ink3)",fontSize:12}}>Key 仅保存在你的浏览器本地存储中，不会上传到任何服务器。所有 API 调用直接从浏览器发起或经你自填的代理转发。</div></div></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginTop:14}}>
        {MODEL_REGISTRY.map(p => {
          const st = getStatus(p.id);
          const isEditing = editing === p.id;
          return <Card key={p.id} style={{padding:0,overflow:"hidden",border:isEditing?"1.5px solid var(--brand)":"1px solid var(--line)"}}>
            <div style={{padding:16,display:"flex",gap:12,alignItems:"center"}}>
              <div style={{width:44,height:44,borderRadius:12,background:p.color,color:"white",display:"grid",placeItems:"center",fontWeight:800,fontSize:13,flex:"0 0 44px"}}>{p.logo}</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:15}}>{p.name}</div>
                <div style={{display:"flex",gap:6,alignItems:"center",marginTop:4}}>
                  <Chip variant={st==="已连接"?"mint":st==="待验证"?"amber":undefined} style={{fontSize:10}}>
                    {st==="已连接" ? "● " : st==="待验证" ? "◐ " : "○ "}{st}
                  </Chip>
                  {keys[p.id]?.savedAt && <span style={{fontSize:10,color:"var(--ink4)"}}>{new Date(keys[p.id].savedAt).toLocaleDateString()}</span>}
                </div>
              </div>
              {!isEditing && <div style={{display:"flex",gap:4}}>
                {keys[p.id]?.key && <Btn sm ghost onClick={() => handleDelete(p.id)} style={{color:"var(--brand)"}}><I.Close size={12}/></Btn>}
                <Btn sm onClick={() => startEdit(p.id)}><I.Edit size={12}/> {keys[p.id]?.key ? "修改" : "配置"}</Btn>
              </div>}
            </div>

            {!isEditing && keys[p.id]?.key && <div style={{padding:"8px 16px",background:"var(--surface2)",borderTop:"1px solid var(--line)",fontSize:11,fontFamily:"var(--mono)",color:"var(--ink3)"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{flex:1}}>{showKey[p.id] ? keys[p.id].key : maskKey(keys[p.id].key)}</span>
                <button onClick={() => setShowKey(s => ({...s, [p.id]: !s[p.id]}))} style={{background:"none",border:"none",color:"var(--ink3)",cursor:"pointer",fontSize:10}}>{showKey[p.id] ? "隐藏" : "显示"}</button>
              </div>
              {keys[p.id]?.baseUrl && <div style={{marginTop:4,fontSize:10,color:"var(--ink4)"}}>代理 BaseURL：{keys[p.id].baseUrl}</div>}
            </div>}

            {isEditing && <div style={{padding:16,borderTop:"1px solid var(--line)",background:"var(--brandTint)"}}>
              <div style={{fontSize:12,fontWeight:600,color:"var(--ink2)",marginBottom:6}}>API Key</div>
              <input type="password" style={{...S.input,fontFamily:"var(--mono)",fontSize:12,marginBottom:8}} value={editKey} onChange={e => setEditKey(e.target.value)}
                placeholder={`输入你的 ${p.name} API Key`}/>
              <div style={{fontSize:12,fontWeight:600,color:"var(--ink2)",marginBottom:6}}>自定义 BaseURL（可选 · 用于代理 / CORS 转发）</div>
              <input type="text" style={{...S.input,fontFamily:"var(--mono)",fontSize:12,marginBottom:8}} value={editBase} onChange={e => setEditBase(e.target.value)}
                placeholder={`留空使用官方端点 ${new URL(p.endpoint).origin}`}/>
              <div style={{fontSize:11,color:"var(--ink3)",marginBottom:8,lineHeight:1.6}}>
                <div>可用模型：{p.models.join(" / ")}</div>
                <div>官方接入：<a href={PROVIDER_LINKS[p.id]?.console || "#"} target="_blank" rel="noreferrer" style={{color:"var(--brandDeep)"}}>{PROVIDER_LINKS[p.id]?.console || "—"}</a></div>
                <div style={{marginTop:2}}>{PROVIDER_LINKS[p.id]?.help}</div>
              </div>
              {testResult && <div style={{padding:"8px 12px",borderRadius:8,marginBottom:8,fontSize:12,fontWeight:600,
                background:testResult.ok?"var(--mintSoft)":"oklch(0.96 0.04 25)",color:testResult.ok?"var(--mintDeep)":"var(--brandDeep)"}}>
                {testResult.ok ? "✓ " : "✗ "}{testResult.msg}
              </div>}
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                <Btn sm onClick={cancelEdit}>取消</Btn>
                <Btn sm onClick={() => handleTest(p.id)} disabled={!editKey.trim() || testing}>
                  {testing ? "测试中…" : <><I.Bolt size={12}/> 测试连接</>}
                </Btn>
                <Btn sm primary onClick={() => handleSave(p.id)} disabled={!editKey.trim()}>
                  <I.Check size={12}/> 保存
                </Btn>
              </div>
            </div>}

            <div style={{padding:"10px 16px",background:"var(--surface2)",borderTop:"1px solid var(--line)",fontSize:10,color:"var(--ink4)",display:"flex",justifyContent:"space-between"}}>
              <span>{p.models.length} 个可用模型</span>
              <span style={{fontFamily:"var(--mono)"}}>{new URL(p.endpoint).hostname}</span>
            </div>
          </Card>;
        })}
      </div>
    </div>}

    {tab==="routing" && <div>
      <div style={S.banner}><div style={S.icoWrap}><I.Layers size={16}/></div><div style={{flex:1}}><div style={{fontWeight:700}}>场景路由配置</div><div style={{color:"var(--ink3)",fontSize:12}}>为每个业务场景指定主模型和备用模型，未配置 Key 的厂商不可选用。</div></div></div>
      <Card style={{padding:0,overflow:"hidden",marginTop:14}}>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{background:"var(--surface3)",textAlign:"left"}}><th style={{padding:"12px 18px",fontWeight:600,fontSize:12,color:"var(--ink3)"}}>业务场景</th><th style={{padding:"12px",fontWeight:600,fontSize:12,color:"var(--ink3)"}}>主模型厂商</th><th style={{padding:"12px",fontWeight:600,fontSize:12,color:"var(--ink3)"}}>具体模型</th><th style={{padding:"12px",fontWeight:600,fontSize:12,color:"var(--ink3)"}}>备用厂商</th></tr></thead>
          <tbody>{routes.map((r,i) => {
            const prov = MODEL_REGISTRY.find(p=>p.id===r.primary);
            const providerOptions = r.type === "image" ? MODEL_REGISTRY.filter(p => IMAGE_PROVIDER_IDS.includes(p.id)) : MODEL_REGISTRY;
            const modelOptions = r.type === "image" ? (prov?.models || []).filter(m => m.includes("image")) : (prov?.models || []);
            return <tr key={i} style={{borderTop:"1px solid var(--line)"}}>
              <td style={{padding:"14px 18px",fontWeight:600}}>{r.scene}</td>
              <td><select style={{...S.input,width:150,padding:"6px 10px"}} value={r.primary} onChange={e => handleRouteChange(i,"primary",e.target.value)}>
                {providerOptions.map(p => <option key={p.id} value={p.id}>{p.name} {getStatus(p.id)==="已连接"?"✓":""}</option>)}
              </select></td>
              <td><select style={{...S.input,width:200,padding:"6px 10px"}} value={r.model||""} onChange={e => handleRouteChange(i,"model",e.target.value)}>
                {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
              </select></td>
              <td><select style={{...S.input,width:150,padding:"6px 10px"}} value={r.fallback||""} onChange={e => handleRouteChange(i,"fallback",e.target.value)}>
                <option value="">无</option>
                {(r.type === "image" ? [] : MODEL_REGISTRY.filter(p=>p.id!==r.primary)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></td>
            </tr>;
          })}</tbody>
        </table>
      </Card>
    </div>}

    {tab==="network" && <div>
      <div style={S.banner}><div style={S.icoWrap}><I.Layers size={16}/></div><div style={{flex:1}}><div style={{fontWeight:700}}>网络与代理</div><div style={{color:"var(--ink3)",fontSize:12}}>解决浏览器直连大模型的 CORS 问题，以及知识库 URL 抓取的代理设置。</div></div></div>

      <Card style={{marginTop:14}}>
        <div style={S.cardH}><div><div style={S.cardTitle}>知识库 · 网页抓取代理</div><div style={S.cardSub}>留空则按顺序尝试 corsproxy.io / allorigins.win 公共代理；填了自己的代理会优先使用。</div></div></div>
        <input type="text" style={{...S.input,fontFamily:"var(--mono)",fontSize:12,marginBottom:8}}
          value={corsProxy} onChange={e => saveCorsProxy(e.target.value)}
          placeholder="例：https://your-worker.workers.dev/?url={url}  （{url} 会被替换为目标 URL）"/>
        <div style={{fontSize:11,color:"var(--ink3)",lineHeight:1.6}}>
          支持两种写法：<code style={{fontFamily:"var(--mono)",background:"var(--surface3)",padding:"1px 4px",borderRadius:3}}>https://proxy.example.com/?url={"{url}"}</code> 或 <code style={{fontFamily:"var(--mono)",background:"var(--surface3)",padding:"1px 4px",borderRadius:3}}>https://proxy.example.com</code>（自动追加 ?url=）
        </div>
      </Card>

      <Card style={{marginTop:14}}>
        <div style={S.cardH}><div><div style={S.cardTitle}>Cloudflare Worker 模板 · 解决 CORS</div><div style={S.cardSub}>把以下代码贴到 Cloudflare Workers 控制台，部署后把 *.workers.dev 域名填到上方"网页抓取代理"或各模型卡的"自定义 BaseURL"。</div></div></div>
        <pre style={{fontFamily:"var(--mono)",fontSize:11,lineHeight:1.6,background:"oklch(0.18 0.005 60)",color:"oklch(0.94 0.01 80)",padding:14,borderRadius:10,overflow:"auto",margin:0}}>
{`// Cloudflare Worker · 通用 OpenAI / Anthropic / 国产大模型 / URL 抓取代理
// 部署后地址例：https://my-proxy.workers.dev
// 用法 1（模型代理）：把它填到模型卡的"自定义 BaseURL"，比如 OpenAI 卡填 https://my-proxy.workers.dev/openai
// 用法 2（URL 抓取）：填到上方"网页抓取代理"：https://my-proxy.workers.dev/fetch?url={url}

const TARGETS = {
  "/openai":    "https://api.openai.com",
  "/anthropic": "https://api.anthropic.com",
  "/doubao":    "https://ark.cn-beijing.volces.com",
  "/qwen":      "https://dashscope.aliyuncs.com",
  "/deepseek":  "https://api.deepseek.com",
  "/zhipu":     "https://open.bigmodel.cn",
};

export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (u.pathname === "/fetch") {
      const target = u.searchParams.get("url");
      if (!target) return cors(new Response("missing url", { status: 400 }));
      const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" } });
      return cors(new Response(await r.text(), { status: r.status, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    }

    for (const [prefix, host] of Object.entries(TARGETS)) {
      if (u.pathname.startsWith(prefix)) {
        const fwd = host + u.pathname.slice(prefix.length) + u.search;
        const r = await fetch(fwd, { method: req.method, headers: req.headers, body: req.body });
        return cors(new Response(r.body, { status: r.status, headers: r.headers }));
      }
    }
    return cors(new Response("ok", { status: 200 }));
  }
};

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "*");
  h.set("Access-Control-Allow-Methods", "*");
  return new Response(res.body, { status: res.status, headers: h });
}`}
        </pre>
        <div style={{display:"flex",justifyContent:"flex-end",marginTop:10}}>
          <Btn sm onClick={() => { try { navigator.clipboard.writeText(document.querySelector("pre")?.textContent || ""); } catch {} }}><I.Doc size={12}/> 复制代码</Btn>
        </div>
      </Card>

      <Card style={{marginTop:14, background:"var(--mintSoft)", borderColor:"transparent"}}>
        <div style={{fontSize:13, fontWeight:700, color:"var(--mintDeep)", marginBottom:6}}>📌 部署 Cloudflare Worker · 5 步走</div>
        <div style={{fontSize:12,lineHeight:1.8,color:"var(--ink2)"}}>
          1. 注册并登录 <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer" style={{color:"var(--brandDeep)"}}>Cloudflare</a>，进入 Workers & Pages → Create<br/>
          2. 选 "Hello World" 模板创建后，进 Edit Code，把上面整段代码粘进去 → Save and Deploy<br/>
          3. 拿到 https://xxx.workers.dev 这个域名<br/>
          4. 回这里：OpenAI 卡的 BaseURL 填 <code style={{fontFamily:"var(--mono)",background:"var(--surface3)",padding:"0 4px",borderRadius:3}}>https://xxx.workers.dev/openai</code>，Anthropic 填 <code style={{fontFamily:"var(--mono)",background:"var(--surface3)",padding:"0 4px",borderRadius:3}}>https://xxx.workers.dev/anthropic</code>，以此类推<br/>
          5. 网页抓取代理填 <code style={{fontFamily:"var(--mono)",background:"var(--surface3)",padding:"0 4px",borderRadius:3}}>https://xxx.workers.dev/fetch?url={"{url}"}</code>
        </div>
      </Card>
    </div>}
  </div>);
}

/* ═══════════════ ReviewCenter (数据复盘) ═══════════════ */
function ReviewCenter() {
  const [tab,setTab]=useState("overview");
  const [notes, setNotes] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({title:"",reads:"",likes:"",comments:"",shares:"",publishDate:"",account:"",cover:"brand"});

  useEffect(() => { try { const r=localStorage.getItem("review-notes"); if(r) setNotes(JSON.parse(r)); } catch{} }, []);
  const save = (n) => { setNotes(n); try { localStorage.setItem("review-notes", JSON.stringify(n)); } catch{} };

  const addNote = () => {
    if (!form.title.trim()) return;
    const reads = parseInt(form.reads)||0, likes = parseInt(form.likes)||0, comments = parseInt(form.comments)||0, shares = parseInt(form.shares)||0;
    const engRate = reads>0 ? (((likes+comments+shares)/reads)*100).toFixed(1) : "0";
    const score = Math.min(100, Math.round((reads/1000)*0.3 + likes*0.04 + comments*0.1 + shares*0.15 + parseFloat(engRate)*5));
    const status = score>=85?"S":score>=70?"A":score>=50?"B":"C";
    const n = { id:Date.now(), ...form, reads, likes, comments, shares, engRate, score, status, addedAt:new Date().toISOString() };
    save([n, ...notes]); setForm({title:"",reads:"",likes:"",comments:"",shares:"",publishDate:"",account:"",cover:"brand"}); setShowAdd(false);
  };
  const deleteNote = (id) => save(notes.filter(n=>n.id!==id));

  const totalReads = notes.reduce((s,n)=>s+n.reads,0);
  const avgEng = notes.length>0 ? (notes.reduce((s,n)=>s+parseFloat(n.engRate),0)/notes.length).toFixed(1) : "0";
  const hotCount = notes.filter(n=>n.score>=70).length;
  const hotRate = notes.length>0 ? ((hotCount/notes.length)*100).toFixed(1) : "0";

  return (<div style={S.page}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:18}}>
      <div><h1 style={S.pageH1}>数据复盘中心</h1><p style={S.pageSub}>录入笔记发布后数据 · 自动计算爆文率和互动率 · 归因分析</p></div>
      <Btn primary onClick={()=>setShowAdd(!showAdd)}><I.Plus size={14}/> 录入笔记数据</Btn>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:18}}>
      {[{l:"已录入",v:notes.length},{l:"总曝光",v:totalReads>10000?`${(totalReads/10000).toFixed(1)}w`:totalReads},{l:"爆文率",v:`${hotRate}%`},{l:"平均互动率",v:`${avgEng}%`},{l:"爆文数",v:hotCount}].map(s => <div key={s.l} style={S.stat}><div style={S.statLabel}>{s.l}</div><div style={{...S.statValue,fontSize:24}}>{s.v}</div></div>)}
    </div>

    {showAdd && <Card style={{marginBottom:14,border:"1.5px solid var(--brand)"}}>
      <div style={S.cardH}><div style={S.cardTitle}>录入笔记数据</div><Btn sm ghost onClick={()=>setShowAdd(false)}><I.Close size={14}/></Btn></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div style={{gridColumn:"1/-1"}}><span style={S.label}>笔记标题</span><input style={S.input} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="例：新手妈妈夜醒自救指南"/></div>
        <div><span style={S.label}>阅读量</span><input style={S.input} type="number" value={form.reads} onChange={e=>setForm(f=>({...f,reads:e.target.value}))} placeholder="12400"/></div>
        <div><span style={S.label}>点赞数</span><input style={S.input} type="number" value={form.likes} onChange={e=>setForm(f=>({...f,likes:e.target.value}))} placeholder="2100"/></div>
        <div><span style={S.label}>评论数</span><input style={S.input} type="number" value={form.comments} onChange={e=>setForm(f=>({...f,comments:e.target.value}))} placeholder="340"/></div>
        <div><span style={S.label}>收藏/转发</span><input style={S.input} type="number" value={form.shares} onChange={e=>setForm(f=>({...f,shares:e.target.value}))} placeholder="580"/></div>
        <div><span style={S.label}>发布日期</span><input style={S.input} type="date" value={form.publishDate} onChange={e=>setForm(f=>({...f,publishDate:e.target.value}))}/></div>
        <div><span style={S.label}>发布账号</span><input style={S.input} value={form.account} onChange={e=>setForm(f=>({...f,account:e.target.value}))} placeholder="@素人小红"/></div>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}><Btn primary onClick={addNote} disabled={!form.title.trim()}><I.Check size={14}/> 保存</Btn></div>
    </Card>}

    {notes.length===0 && !showAdd && <Card style={{display:"flex",flexDirection:"column",alignItems:"center",padding:48,gap:12}}>
      <div style={{fontSize:48}}>📊</div>
      <div style={{fontSize:15,fontWeight:700,color:"var(--ink2)"}}>暂无复盘数据</div>
      <div style={{fontSize:12,color:"var(--ink3)",textAlign:"center",maxWidth:360}}>发布笔记后，手动录入阅读、点赞、评论、收藏数据，系统自动计算爆文评分和互动率。</div>
      <Btn primary onClick={()=>setShowAdd(true)} style={{marginTop:8}}><I.Plus size={14}/> 录入第一条</Btn>
    </Card>}

    {notes.length>0 && <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {notes.sort((a,b)=>b.score-a.score).map((n,i) => <Card key={n.id} style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"50px 1fr 120px 120px 80px 40px",gap:0,alignItems:"center"}}>
          <div style={{padding:"14px 0",textAlign:"center",fontSize:16,fontWeight:800,color:n.score>=85?"var(--brand)":"var(--ink3)"}}>{n.score>=85?"🏆":`#${i+1}`}</div>
          <div style={{padding:"10px 14px"}}><div style={{fontSize:13,fontWeight:700,marginBottom:4}}>{n.title}</div><div style={{fontSize:11,color:"var(--ink3)"}}>{n.account||"—"} · {n.publishDate||"未填"}</div></div>
          <div style={{padding:"10px",borderLeft:"1px solid var(--line)"}}><div style={{fontSize:10,color:"var(--ink3)"}}>阅读/点赞/评论</div><div style={{fontSize:12,fontWeight:600}}>{n.reads>10000?`${(n.reads/10000).toFixed(1)}w`:n.reads} / {n.likes} / {n.comments}</div></div>
          <div style={{padding:"10px",borderLeft:"1px solid var(--line)"}}><div style={{fontSize:10,color:"var(--ink3)"}}>互动率</div><div style={{fontSize:14,fontWeight:700,color:parseFloat(n.engRate)>=5?"var(--mintDeep)":"var(--ink)"}}>{n.engRate}%</div></div>
          <div style={{padding:"10px",textAlign:"center"}}><div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:800,color:n.score>=85?"var(--mintDeep)":n.score>=70?"var(--amberDeep)":"var(--ink3)"}}>{n.score}</div><Chip variant={n.score>=85?"mint":n.score>=70?"amber":"brand"} style={{fontSize:9}}>{n.status}</Chip></div>
          <div style={{padding:"10px"}}><Btn sm ghost onClick={()=>deleteNote(n.id)} style={{color:"var(--brand)"}}><I.Close size={12}/></Btn></div>
        </div>
      </Card>)}
    </div>}
  </div>);
}

/* ═══════════════ MaterialPool (素材库) ═══════════════ */
function MaterialPool() {
  const [items, setItems] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({type:"📸封面",title:"",content:"",tags:""});
  const [filter, setFilter] = useState("全部");

  useEffect(() => { try { const r=localStorage.getItem("material-pool"); if(r) setItems(JSON.parse(r)); } catch{} }, []);
  const save = (n) => { setItems(n); try { localStorage.setItem("material-pool", JSON.stringify(n)); } catch{} };

  const types = ["📸封面","🎣钩子","🧱结构","🤖Prompt","📱截图","📋话术"];
  const addItem = () => {
    if(!form.title.trim()) return;
    const n = { id:Date.now(), ...form, tags:form.tags.split(/[,，、\s]+/).filter(Boolean), addedAt:new Date().toISOString(), used:0 };
    save([n,...items]); setForm({type:"📸封面",title:"",content:"",tags:""}); setShowAdd(false);
  };
  const deleteItem = (id) => save(items.filter(i=>i.id!==id));
  const copyContent = (content) => { try { navigator.clipboard.writeText(content); } catch{} };
  const filtered = filter==="全部" ? items : items.filter(i=>i.type===filter);
  const colors = { "📸封面":"brand","🎣钩子":"amber","🧱结构":"sky","🤖Prompt":"violet","📱截图":"mint","📋话术":"brand" };

  return (<div style={S.page}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:18}}>
      <div><h1 style={S.pageH1}>素材库 · 灵感池</h1><p style={S.pageSub}>{items.length} 个素材 · 封面参考、钩子文案、结构模板、Prompt、话术</p></div>
      <Btn primary onClick={()=>setShowAdd(!showAdd)}><I.Plus size={14}/> 添加素材</Btn>
    </div>

    {showAdd && <Card style={{marginBottom:14,border:"1.5px solid var(--brand)"}}>
      <div style={S.cardH}><div style={S.cardTitle}>添加素材</div><Btn sm ghost onClick={()=>setShowAdd(false)}><I.Close size={14}/></Btn></div>
      <div style={{display:"grid",gridTemplateColumns:"150px 1fr",gap:12}}>
        <div><span style={S.label}>素材类型</span><select style={S.input} value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>{types.map(t => <option key={t}>{t}</option>)}</select></div>
        <div><span style={S.label}>标题</span><input style={S.input} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="例：反向钩子万能公式"/></div>
        <div style={{gridColumn:"1/-1"}}><span style={S.label}>内容</span><textarea style={{...S.input,minHeight:100,fontFamily:"var(--mono)",fontSize:12}} value={form.content} onChange={e=>setForm(f=>({...f,content:e.target.value}))} placeholder="粘贴具体的文案、Prompt、结构模板等内容…"/></div>
        <div style={{gridColumn:"1/-1"}}><span style={S.label}>标签（逗号分隔）</span><input style={S.input} value={form.tags} onChange={e=>setForm(f=>({...f,tags:e.target.value}))} placeholder="母婴, 反向钩子, 万能"/></div>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}><Btn primary onClick={addItem} disabled={!form.title.trim()}><I.Check size={14}/> 保存</Btn></div>
    </Card>}

    {/* Filter bar */}
    <div style={{display:"flex",gap:6,marginBottom:14}}>
      {["全部",...types].map(t => <button key={t} onClick={()=>setFilter(t)} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${filter===t?"var(--brand)":"var(--line)"}`,background:filter===t?"var(--brandTint)":"var(--surface)",fontSize:12,fontWeight:600,cursor:"pointer"}}>{t} {t==="全部"?items.length:items.filter(i=>i.type===t).length}</button>)}
    </div>

    {filtered.length===0 && !showAdd && <Card style={{display:"flex",flexDirection:"column",alignItems:"center",padding:48,gap:12}}>
      <div style={{fontSize:48}}>🎨</div>
      <div style={{fontSize:15,fontWeight:700,color:"var(--ink2)"}}>素材库为空</div>
      <div style={{fontSize:12,color:"var(--ink3)",textAlign:"center",maxWidth:360}}>收集封面参考、爆款钩子文案、结构模板、GPT Prompt 等素材，生成笔记时随时调用。</div>
      <Btn primary onClick={()=>setShowAdd(true)} style={{marginTop:8}}><I.Plus size={14}/> 添加第一个素材</Btn>
    </Card>}

    {filtered.length>0 && <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
      {filtered.map(m => <Card key={m.id} style={{padding:0,overflow:"hidden"}}>
        <div style={{padding:"10px 14px",background:`var(--${colors[m.type]||"brand"}Soft)`,borderBottom:"1px solid var(--line)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{display:"flex",gap:6,alignItems:"center"}}><span style={{fontSize:16}}>{m.type.slice(0,2)}</span><span style={{fontSize:12,fontWeight:700}}>{m.type.slice(2)}</span></div>
          <Btn sm ghost onClick={()=>deleteItem(m.id)} style={{color:"var(--brand)"}}><I.Close size={12}/></Btn>
        </div>
        <div style={{padding:14}}>
          <div style={{fontSize:14,fontWeight:700,lineHeight:1.4,marginBottom:8}}>{m.title}</div>
          {m.content && <div style={{fontSize:12,lineHeight:1.6,color:"var(--ink2)",marginBottom:8,maxHeight:80,overflow:"hidden",whiteSpace:"pre-wrap"}}>{m.content.slice(0,200)}{m.content.length>200?"…":""}</div>}
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:10}}>{(m.tags||[]).map(t => <Chip key={t} style={{fontSize:9}}>{t}</Chip>)}</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,borderTop:"1px solid var(--line)"}}>
            <span style={{fontSize:10,color:"var(--ink3)"}}>{new Date(m.addedAt).toLocaleDateString()}</span>
            {m.content && <Btn sm primary style={{padding:"3px 10px",fontSize:10}} onClick={()=>copyContent(m.content)}><I.Doc size={10}/> 复制</Btn>}
          </div>
        </div>
      </Card>)}
    </div>}
  </div>);
}

/* ═══════════════ KnowledgeBase (知识库) ═══════════════ */
function KnowledgeBase() {
  const { keys, routes } = useContext(ApiConfigContext);
  const hasAI = isBackendMode() || Object.values(keys).some(k => k?.key);
  const [items, setItems] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState("url"); // url | file | paste
  const [urlInput, setUrlInput] = useState("");
  const [pasteInput, setPasteInput] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [viewItem, setViewItem] = useState(null);
  const fileRef = useRef(null);

  // Load from localStorage
  useEffect(() => {
    try { const raw = localStorage.getItem("kb-items"); if (raw) setItems(JSON.parse(raw)); } catch(e) {}
  }, []);
  const save = (newItems) => { setItems(newItems); try { localStorage.setItem("kb-items", JSON.stringify(newItems)); } catch(e) {} };

  // Add URL - real fetch via CORS proxy + AI summarize
  const addUrl = async () => {
    if (!urlInput.trim()) return;
    setLoading(true); setError(null);
    try {
      let fetched = null;
      try {
        const backend = getBackendBase();
        const customProxy = backend
          ? `${backend}/fetch?url={url}`
          : (localStorage.getItem("kb-cors-proxy") || "");
        fetched = await fetchUrlContent(urlInput.trim(), customProxy);
      } catch (e) {
        setError(`抓取失败：${e.message?.slice(0, 80) || "代理无法访问"}（已只保存链接，可手动改写摘要）`);
      }
      let title = fetched?.title || urlInput;
      let summary = fetched?.text ? fetched.text.slice(0, 100) + "…" : "已添加链接，未抓取到正文";
      let content = fetched?.text || "";
      if (hasAI && content.length > 40) {
        try {
          const result = await callAI({ keys, routes, scene: "选题挖掘", maxTokens: 400,
            systemPrompt: "根据网页正文生成简短标题和一句话摘要。返回JSON：{\"title\":\"xxx\",\"summary\":\"xxx\",\"category\":\"行业报告/平台政策/竞品分析/品牌资料/文案参考\"}。只返回JSON。",
            prompt: `网页URL：${urlInput}\n正文（截取）：${content.slice(0, 4000)}`
          });
          const d = JSON.parse(result.replace(/```json|```/g, "").trim());
          if (d.title) title = d.title;
          if (d.summary) summary = d.summary;
        } catch {}
      }
      const tokens = content ? `${(content.length / 4).toFixed(1)}k` : "—";
      const newItem = { id: Date.now(), type: "url", icon: "🌐", title, url: urlInput, cat: fetched ? "网页正文" : "网页链接", summary, tokens, used: 0, content, addedAt: new Date().toISOString(), status: fetched ? "已索引" : "未抓取" };
      save([newItem, ...items]);
      setUrlInput(""); setShowAdd(false);
    } catch(e) { setError(e.message?.slice(0,120)); }
    setLoading(false);
  };

  // Add file - real PDF/DOCX/XLSX parsing
  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true); setError(null);
    const ext = file.name.split(".").pop().toLowerCase();
    const iconMap = { pptx:"📊", ppt:"📊", docx:"📝", doc:"📝", xlsx:"📗", xls:"📗", txt:"📄", pdf:"📕", csv:"📗", md:"📄", json:"📄" };
    const catMap = { pptx:"PPT文档", ppt:"PPT文档", docx:"Word文档", doc:"Word文档", xlsx:"Excel表格", xls:"Excel表格", txt:"文本文件", pdf:"PDF文档", csv:"CSV数据", md:"Markdown", json:"JSON" };
    try {
      if (!isSupportedFile(file.name)) {
        throw new Error(`暂不支持 .${ext}（已支持：pdf / docx / xlsx / xls / txt / csv / md / json）`);
      }
      const content = await parseFile(file);
      const tokens = content ? `${(content.length/4).toFixed(1)}k` : "—";
      let summary = content
        ? content.replace(/\s+/g, " ").slice(0, 100) + (content.length > 100 ? "…" : "")
        : `${file.name} · ${(file.size/1024).toFixed(1)}KB`;
      if (hasAI && content.length > 40) {
        try {
          const result = await callAI({ keys, routes, scene: "选题挖掘", maxTokens: 300,
            systemPrompt: "用一句话概括以下内容的核心要点。只返回概括文字，不要JSON。",
            prompt: content.slice(0, 4000)
          });
          if (result) summary = result.slice(0, 100);
        } catch {}
      }
      const newItem = { id: Date.now(), type: "file", icon: iconMap[ext] || "📄", title: file.name.replace(/\.[^.]+$/, ""), cat: catMap[ext] || "文件", summary, tokens, used: 0, content, addedAt: new Date().toISOString(), status: "已索引", fileSize: file.size, fileName: file.name };
      save([newItem, ...items]);
      setShowAdd(false);
    } catch(e) { setError("文件读取失败：" + (e.message || "未知错误")); }
    setLoading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  // Add paste
  const addPaste = async () => {
    if (!pasteInput.trim()) return;
    setLoading(true); setError(null);
    const tokens = `${(pasteInput.length/4).toFixed(1)}k`;
    let summary = pasteInput.slice(0, 80) + "…";
    let title = pasteTitle.trim() || "粘贴内容 " + new Date().toLocaleDateString();
    if (hasAI && pasteInput.length > 20) {
      try {
        const result = await callAI({ keys, routes, scene: "选题挖掘", maxTokens: 300,
          systemPrompt: "根据以下内容，生成一个简短标题和一句话摘要。返回JSON：{\"title\":\"xxx\",\"summary\":\"xxx\",\"category\":\"行业报告/平台政策/竞品分析/品牌资料/文案参考\"}。只返回JSON。",
          prompt: pasteInput.slice(0, 3000)
        });
        try { const d = JSON.parse(result.replace(/```json|```/g,"").trim()); if (!pasteTitle.trim()) title = d.title || title; summary = d.summary || summary; } catch {}
      } catch {}
    }
    const newItem = { id: Date.now(), type: "paste", icon: "📋", title, cat: "粘贴内容", summary, tokens, used: 0, content: pasteInput, addedAt: new Date().toISOString(), status: "已索引" };
    save([newItem, ...items]);
    setPasteInput(""); setPasteTitle(""); setShowAdd(false);
    setLoading(false);
  };

  const deleteItem = (id) => save(items.filter(it => it.id !== id));

  const typeIcon = { url: "🌐", file: "📎", paste: "📋" };

  return (<div style={S.page}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:18}}>
      <div><h1 style={S.pageH1}>行业知识库</h1><p style={S.pageSub}>{items.length} 份资料 · 支持网页链接、文件上传、粘贴内容 · 生成时自动参考</p></div>
      <Btn primary onClick={() => setShowAdd(!showAdd)}><I.Plus size={14}/> 添加知识</Btn>
    </div>

    {/* Add panel */}
    {showAdd && <Card style={{marginBottom:14,border:"1.5px solid var(--brand)"}}>
      <div style={S.cardH}><div style={S.cardTitle}>添加知识来源</div><Btn sm ghost onClick={() => setShowAdd(false)}><I.Close size={14}/></Btn></div>
      <div style={{display:"flex",gap:4,marginBottom:14}}>
        {[{id:"url",label:"🌐 网页链接",desc:"输入URL自动抓取"},{id:"file",label:"📎 上传文件",desc:"PPT/Word/Excel/TXT/PDF"},{id:"paste",label:"📋 粘贴内容",desc:"直接粘贴文字"}].map(m =>
          <button key={m.id} onClick={() => setAddMode(m.id)} style={{flex:1,padding:"14px 12px",borderRadius:12,border:`1.5px solid ${addMode===m.id?"var(--brand)":"var(--line)"}`,background:addMode===m.id?"var(--brandTint)":"var(--surface)",cursor:"pointer",textAlign:"left"}}>
            <div style={{fontSize:14,fontWeight:700}}>{m.label}</div>
            <div style={{fontSize:11,color:"var(--ink3)",marginTop:2}}>{m.desc}</div>
          </button>
        )}
      </div>

      {addMode==="url" && <div>
        <span style={S.label}>网页链接</span>
        <div style={{display:"flex",gap:10}}>
          <input style={{...S.input,flex:1}} value={urlInput} onChange={e=>setUrlInput(e.target.value)} placeholder="https://www.xiaohongshu.com/..." />
          <Btn primary disabled={loading||!urlInput.trim()} onClick={addUrl} style={{whiteSpace:"nowrap"}}>
            {loading ? "处理中…" : <><I.Magic size={14}/> 抓取并索引</>}
          </Btn>
        </div>
        <div style={{fontSize:11,color:"var(--ink3)",marginTop:6}}>支持小红书笔记、公众号文章、行业报告网页等。AI 会自动提取标题和摘要。</div>
      </div>}

      {addMode==="file" && <div>
        <input ref={fileRef} type="file" accept=".docx,.xlsx,.xls,.txt,.csv,.pdf,.md,.json" onChange={handleFile} style={{display:"none"}} />
        <button onClick={() => fileRef.current?.click()} style={{width:"100%",padding:32,border:"2px dashed var(--lineStrong)",borderRadius:14,background:"var(--surface2)",cursor:"pointer",textAlign:"center"}}>
          <div style={{fontSize:36,marginBottom:8}}>📎</div>
          <div style={{fontSize:14,fontWeight:700,color:"var(--ink2)"}}>点击选择文件</div>
          <div style={{fontSize:12,color:"var(--ink3)",marginTop:4}}>真解析：.pdf .docx .xlsx .xls .txt .csv .md .json</div>
          <div style={{display:"flex",justifyContent:"center",gap:8,marginTop:10,flexWrap:"wrap"}}>
            {["📕 PDF","📝 Word","📗 Excel","📄 TXT/MD/JSON","📗 CSV"].map(f => <Chip key={f} style={{fontSize:10}}>{f}</Chip>)}
          </div>
          <div style={{fontSize:10,color:"var(--ink4)",marginTop:8}}>暂不支持 .ppt/.pptx/.doc（旧格式），请先另存为 .docx 或 .pdf</div>
        </button>
        {loading && <div style={{textAlign:"center",color:"var(--brand)",fontSize:13,fontWeight:600,marginTop:10}}>⏳ 正在读取并索引…</div>}
      </div>}

      {addMode==="paste" && <div>
        <span style={S.label}>标题（选填，AI 可自动生成）</span>
        <input style={{...S.input,marginBottom:10}} value={pasteTitle} onChange={e=>setPasteTitle(e.target.value)} placeholder="例：品牌话术手册 v2"/>
        <span style={S.label}>内容</span>
        <textarea style={{...S.input,minHeight:160,fontFamily:"var(--mono)",fontSize:12}} value={pasteInput} onChange={e=>setPasteInput(e.target.value)} placeholder="直接粘贴你的品牌话术、竞品分析笔记、行业数据、文案模板等任何文字内容…"/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:10}}>
          <span style={{fontSize:11,color:"var(--ink3)"}}>{pasteInput.length} 字 · 约 {(pasteInput.length/4).toFixed(1)}k tokens</span>
          <Btn primary disabled={loading||!pasteInput.trim()} onClick={addPaste}>
            {loading ? "处理中…" : <><I.Check size={14}/> 保存并索引</>}
          </Btn>
        </div>
      </div>}

      {error && <div style={{marginTop:10,padding:"8px 14px",borderRadius:8,background:"oklch(0.96 0.04 25)",color:"var(--brandDeep)",fontSize:12}}>⚠ {error}</div>}
    </Card>}

    {/* How knowledge is used */}
    <div style={S.banner}><div style={S.icoWrap}><I.Library size={16}/></div><div style={{flex:1}}><div style={{fontWeight:700}}>知识库如何被使用</div><div style={{color:"var(--ink3)",fontSize:12}}>Agent验证参考品牌话术 · 投流笔记参考竞品打法 · 合规检测比对平台规范</div></div><div style={{display:"flex",gap:6}}><Chip variant="brand">素人爆文</Chip><Chip variant="sky">聚光投流</Chip><Chip variant="mint">Agent验证</Chip></div></div>

    {/* Empty state */}
    {items.length === 0 && !showAdd && <Card style={{display:"flex",flexDirection:"column",alignItems:"center",padding:48,gap:12,marginTop:14}}>
      <div style={{fontSize:48}}>📚</div>
      <div style={{fontSize:15,fontWeight:700,color:"var(--ink2)"}}>知识库为空</div>
      <div style={{fontSize:12,color:"var(--ink3)",textAlign:"center",maxWidth:360,lineHeight:1.6}}>添加网页链接、上传文件（PPT/Word/Excel/TXT）或直接粘贴内容。AI 生成笔记时会自动参考这些知识。</div>
      <Btn primary onClick={() => setShowAdd(true)} style={{marginTop:8}}><I.Plus size={14}/> 添加第一份知识</Btn>
    </Card>}

    {/* Item list */}
    {items.length > 0 && <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:14}}>
      {items.map(item => <Card key={item.id} style={{padding:0,overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"52px 1fr auto",gap:0,alignItems:"center"}}>
          <div style={{display:"grid",placeItems:"center",height:"100%",background:"var(--surface2)",fontSize:24}}>{item.icon}</div>
          <div style={{padding:"12px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{fontSize:14,fontWeight:700}}>{item.title}</span>
              <Chip variant="mint" style={{fontSize:9}}>{item.status||"已索引"}</Chip>
              <Chip style={{fontSize:9}}>{item.cat}</Chip>
              {item.type==="url" && <Chip style={{fontSize:9,background:"oklch(0.95 0.04 230)",color:"oklch(0.45 0.13 230)"}}>🌐 网页</Chip>}
              {item.type==="file" && <Chip style={{fontSize:9,background:"oklch(0.95 0.04 290)",color:"oklch(0.45 0.16 290)"}}>📎 文件</Chip>}
              {item.type==="paste" && <Chip style={{fontSize:9,background:"oklch(0.95 0.06 80)",color:"oklch(0.45 0.14 60)"}}>📋 粘贴</Chip>}
            </div>
            <div style={{fontSize:12,color:"var(--ink2)",lineHeight:1.5,marginBottom:4}}>{item.summary}</div>
            <div style={{display:"flex",gap:12,fontSize:10,color:"var(--ink3)"}}>
              <span style={{fontFamily:"var(--mono)"}}>{item.tokens} tokens</span>
              {item.url && <span style={{color:"var(--sky)",cursor:"pointer"}} onClick={()=>window.open(item.url,"_blank")}>{item.url.slice(0,40)}…</span>}
              {item.fileName && <span>{item.fileName} · {(item.fileSize/1024).toFixed(1)}KB</span>}
              <span>{new Date(item.addedAt).toLocaleDateString()}</span>
            </div>
          </div>
          <div style={{padding:"10px 14px",borderLeft:"1px solid var(--line)",display:"flex",gap:4}}>
            {item.content && <Btn sm ghost onClick={() => setViewItem(viewItem===item.id?null:item.id)}><I.Eye size={12}/></Btn>}
            <Btn sm ghost onClick={() => deleteItem(item.id)} style={{color:"var(--brand)"}}><I.Close size={12}/></Btn>
          </div>
        </div>
        {/* Expand to view content */}
        {viewItem===item.id && item.content && <div style={{padding:"12px 14px",borderTop:"1px solid var(--line)",background:"var(--surface2)",maxHeight:300,overflow:"auto"}}>
          <pre style={{fontSize:11,fontFamily:"var(--mono)",lineHeight:1.6,whiteSpace:"pre-wrap",wordBreak:"break-all",color:"var(--ink2)",margin:0}}>{item.content.slice(0,5000)}{item.content.length>5000?"…(内容过长已截断)":""}</pre>
        </div>}
      </Card>)}
    </div>}
  </div>);
}

/* ═══════════════ AccountMatrix (账号矩阵) ═══════════════ */
function AccountMatrix() {
  const [accounts, setAccounts] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({name:"",handle:"",persona:"",topics:""});
  const [sel, setSel] = useState(null);

  useEffect(() => { try { const r=localStorage.getItem("acc-matrix"); if(r) setAccounts(JSON.parse(r)); } catch{} }, []);
  const save = (n) => { setAccounts(n); try { localStorage.setItem("acc-matrix", JSON.stringify(n)); } catch{} };

  const colors = ["var(--brand)","var(--sky)","oklch(0.7 0.16 290)","var(--mint)","var(--amber)","var(--ink2)"];
  const addAccount = () => {
    if(!form.name.trim()||!form.handle.trim()) return;
    const n = { id:Date.now(), ...form, avatar:form.name[0], color:colors[accounts.length%6], topics:form.topics.split(/[,，、\s]+/).filter(Boolean), fans:0, delta:0, posts:0, avgReads:"0", eng:0, health:50, addedAt:new Date().toISOString() };
    save([...accounts, n]); setForm({name:"",handle:"",persona:"",topics:""}); setShowAdd(false);
  };
  const deleteAcc = (id) => save(accounts.filter(a=>a.id!==id));
  const updateStats = (id, field, value) => save(accounts.map(a => a.id===id ? {...a, [field]:value} : a));

  const total = accounts.reduce((s,a)=>s+(parseInt(a.fans)||0),0);

  return (<div style={S.page}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:18}}>
      <div><h1 style={S.pageH1}>账号矩阵 · 数据中心</h1><p style={S.pageSub}>{accounts.length} 个素人账号{total>0?` · 总粉丝${total>10000?`${(total/10000).toFixed(1)}w`:total}`:""}</p></div>
      <Btn primary onClick={()=>setShowAdd(!showAdd)}><I.Plus size={14}/> 添加账号</Btn>
    </div>

    {accounts.length>0 && <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
      {[{l:"总账号",v:accounts.length},{l:"总粉丝",v:total>10000?`${(total/10000).toFixed(1)}w`:total},{l:"本月发文",v:accounts.reduce((s,a)=>s+(parseInt(a.posts)||0),0)},{l:"平均互动率",v:accounts.length>0?`${(accounts.reduce((s,a)=>s+(parseFloat(a.eng)||0),0)/accounts.length).toFixed(1)}%`:"—"}].map(s => <div key={s.l} style={S.stat}><div style={S.statLabel}>{s.l}</div><div style={{...S.statValue,fontSize:24}}>{s.v}</div></div>)}
    </div>}

    {showAdd && <Card style={{marginBottom:14,border:"1.5px solid var(--brand)"}}>
      <div style={S.cardH}><div style={S.cardTitle}>添加素人账号</div><Btn sm ghost onClick={()=>setShowAdd(false)}><I.Close size={14}/></Btn></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div><span style={S.label}>账号名称</span><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="素人小红"/></div>
        <div><span style={S.label}>小红书号</span><input style={S.input} value={form.handle} onChange={e=>setForm(f=>({...f,handle:e.target.value}))} placeholder="@surenxiaohong"/></div>
        <div><span style={S.label}>人设定位</span><input style={S.input} value={form.persona} onChange={e=>setForm(f=>({...f,persona:e.target.value}))} placeholder="母婴·新手妈妈"/></div>
        <div><span style={S.label}>内容标签（逗号分隔）</span><input style={S.input} value={form.topics} onChange={e=>setForm(f=>({...f,topics:e.target.value}))} placeholder="母婴, 睡眠, 辅食"/></div>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}><Btn primary onClick={addAccount} disabled={!form.name.trim()||!form.handle.trim()}><I.Check size={14}/> 添加</Btn></div>
    </Card>}

    {accounts.length===0 && !showAdd && <Card style={{display:"flex",flexDirection:"column",alignItems:"center",padding:48,gap:12}}>
      <div style={{fontSize:48}}>👥</div>
      <div style={{fontSize:15,fontWeight:700,color:"var(--ink2)"}}>暂无账号</div>
      <div style={{fontSize:12,color:"var(--ink3)",textAlign:"center",maxWidth:360}}>添加你的小红书素人账号，记录粉丝、阅读、互动率等数据，管理多账号矩阵。</div>
      <Btn primary onClick={()=>setShowAdd(true)} style={{marginTop:8}}><I.Plus size={14}/> 添加第一个账号</Btn>
    </Card>}

    {accounts.length>0 && <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
      {accounts.map(a => <Card key={a.id} style={{padding:0,overflow:"hidden",border:sel===a.id?"1.5px solid var(--brand)":"1px solid var(--line)"}}>
        <div style={{padding:16}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:12,marginBottom:12}}>
            <div style={{...S.avatar,width:44,height:44,fontSize:16,background:a.color}}>{a.avatar}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700}}>{a.name}</div>
              <div style={{fontSize:11,color:"var(--ink3)"}}>{a.handle} · {a.persona||"未设定人设"}</div>
            </div>
            <Btn sm ghost onClick={()=>deleteAcc(a.id)} style={{color:"var(--brand)"}}><I.Close size={12}/></Btn>
          </div>
          {/* Editable stats */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:10}}>
            {[{l:"粉丝",k:"fans"},{l:"发文数",k:"posts"},{l:"互动率%",k:"eng"}].map(s => <div key={s.k} style={{padding:6,background:"var(--surface2)",borderRadius:8}}>
              <div style={{fontSize:9,color:"var(--ink3)"}}>{s.l}</div>
              <input type="number" style={{border:"none",background:"transparent",fontSize:14,fontWeight:700,width:"100%",outline:"none",padding:0}} value={a[s.k]||""} onChange={e=>updateStats(a.id,s.k,e.target.value)} placeholder="0"/>
            </div>)}
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{(a.topics||[]).map(t => <Chip key={t} style={{fontSize:10}}>{t}</Chip>)}</div>
        </div>
      </Card>)}
    </div>}
  </div>);
}

/* ═══════════════ TrackAnalysis (赛道分析) ═══════════════ */
function TrackAnalysis() {
  const [track,setTrack]=useState("gongkao");
  const [tab,setTab]=useState("overview");
  const tracks=[{id:"gongkao",name:"公考",emoji:"📚",hot:96,growth:"+18%"},{id:"kaoyan",name:"考研",emoji:"🎓",hot:91,growth:"+22%"},{id:"muying",name:"母婴",emoji:"👶",hot:88,growth:"+8%"},{id:"meizhuang",name:"美妆",emoji:"💄",hot:94,growth:"+12%"},{id:"jiaoyu",name:"教育",emoji:"🏫",hot:90,growth:"+24%"},{id:"3c",name:"3C数码",emoji:"📱",hot:87,growth:"+16%"},{id:"jianshen",name:"健身",emoji:"💪",hot:86,growth:"+15%"},{id:"licai",name:"理财",emoji:"💰",hot:82,growth:"+28%"}];
  const personas=[{name:"上岸学姐",pct:32,color:"var(--brand)",hook:"我用X个月上岸"},{name:"二战陪跑",pct:24,color:"oklch(0.7 0.16 290)",hook:"二战的崩溃日记"},{name:"在职宝爸宝妈",pct:18,color:"var(--amber)",hook:"30岁还能上岸吗"},{name:"硬核教研",pct:14,color:"var(--sky)",hook:"申论/行测一篇讲透"},{name:"段子手陪伴",pct:12,color:"var(--mint)",hook:"考公人迷惑行为大赏"}];
  const topics=[{t:"结构化面试模板",hot:96,note:"本周+24%"},{t:"申论范文背诵",hot:92},{t:"国考时政热点",hot:89,note:"竞争↑↑"},{t:"应届vs在职选岗",hot:84,note:"蓝海"},{t:"公考备考时间表",hot:78},{t:"上岸后真实工作",hot:86,note:"蓝海"},{t:"公考心态崩溃日记",hot:72},{t:"应届考公还是考研",hot:81}];
  const T=tracks.find(x=>x.id===track);
  return (<div style={S.page}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:18}}>
      <div><h1 style={S.pageH1}>赛道分析 · 行业雷达</h1><p style={S.pageSub}>人设拆解 · 选题趋势 · 投流策略 · 18,400+ 笔记样本</p></div>
      <Btn primary><I.Magic size={14}/> AI 定制策略</Btn>
    </div>
    <Card style={{marginBottom:14}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
        {tracks.map(t => <button key={t.id} onClick={()=>setTrack(t.id)} style={{padding:14,borderRadius:12,textAlign:"left",cursor:"pointer",border:`1.5px solid ${t.id===track?"var(--brand)":"var(--line)"}`,background:t.id===track?"var(--brandSoft)":"var(--surface)"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}><span style={{fontSize:20}}>{t.emoji}</span><span style={{fontSize:14,fontWeight:700}}>{t.name}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10}}><span style={{color:"var(--mintDeep)",fontWeight:700}}>{t.growth}</span><span style={{fontFamily:"var(--mono)",fontWeight:700}}>{t.hot}</span></div>
          <div style={S.hairline}><span style={{display:"block",height:"100%",width:`${t.hot}%`,background:t.id===track?"var(--brand)":"var(--ink3)",borderRadius:999}}/></div>
        </button>)}
      </div>
    </Card>
    <div style={S.seg}>
      {[{id:"overview",l:"📋 总览"},{id:"persona",l:"🎭 素人人设"},{id:"topic",l:"💡 选题趋势"},{id:"ad",l:"📊 投流策略"}].map(t => <button key={t.id} onClick={()=>setTab(t.id)} style={{...S.segBtn,...(tab===t.id?S.segOn:{})}}>{t.l}</button>)}
    </div>
    <div style={{marginTop:14}}>
      {tab==="overview" && <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <Card><div style={S.cardH}><div style={S.cardTitle}>主流人设占比</div></div>
          {personas.map((p,i)=><div key={i} style={{marginBottom:10}}><div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span style={{fontWeight:600}}>{p.name}</span><span style={{fontFamily:"var(--mono)",fontWeight:700,color:p.color}}>{p.pct}%</span></div><div style={S.hairline}><span style={{display:"block",height:"100%",width:`${p.pct*3}%`,background:p.color,borderRadius:999}}/></div></div>)}
        </Card>
        <Card style={{background:"var(--mintSoft)",borderColor:"transparent"}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--mintDeep)",marginBottom:8}}>💡 本周运营建议</div>
          <div style={{fontSize:12,lineHeight:1.8}}>• 聚焦「结构化面试模板」选题，国考面试季流量爆发<br/>• 新增「上岸后真实工作」蓝海赛道<br/>• 主推时段 21:00-22:30，3 个账号错峰发<br/>• 素人小红/公考新声加大对比测评型笔记</div>
        </Card>
      </div>}
      {tab==="persona" && <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:14}}>
        {personas.map((p,i) => <Card key={i} style={{borderTop:`3px solid ${p.color}`}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}><div style={{fontSize:16,fontWeight:700}}>{p.name}</div><span style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:p.color}}>{p.pct}%</span></div>
          <div style={{padding:10,background:"var(--surface2)",borderRadius:8,marginBottom:10}}><div style={{fontSize:10,color:"var(--ink3)"}}>典型钩子</div><div style={{fontSize:13,fontFamily:"var(--mono)",color:"var(--ink)"}}>{p.hook}</div></div>
          <Btn sm style={{width:"100%",justifyContent:"center"}}><I.Plus size={12}/> 用此人设建号</Btn>
        </Card>)}
      </div>}
      {tab==="topic" && <Card>
        <div style={S.cardH}><div><div style={S.cardTitle}>选题热度排行 · 近 30 天</div></div></div>
        {topics.map((t,i) => <div key={i} style={{display:"grid",gridTemplateColumns:"30px 1fr 80px 120px 100px",gap:12,alignItems:"center",padding:12,border:"1px solid var(--line)",borderRadius:10,marginBottom:8}}>
          <span style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:i<3?"var(--brand)":"var(--ink3)"}}>#{i+1}</span>
          <div style={{fontSize:13,fontWeight:600}}>{t.t}</div>
          <div><span style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700}}>{t.hot}</span><div style={S.hairline}><span style={{display:"block",height:"100%",width:`${t.hot}%`,background:"var(--brand)",borderRadius:999}}/></div></div>
          <div>{t.note && <Chip variant={t.note==="蓝海"?"mint":"brand"} style={{fontSize:10}}>{t.note}</Chip>}</div>
          <Btn sm primary style={{padding:"4px 8px"}}><I.Magic size={11}/> 生成</Btn>
        </div>)}
      </Card>}
      {tab==="ad" && <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {[{l:"建议月预算",v:"2-5w",bg:"var(--brandSoft)"},{l:"目标CPM",v:"¥18-25",bg:"var(--mintSoft)"},{l:"目标CPL",v:"¥8-18",bg:"var(--amberSoft)"}].map(p => <Card key={p.l} style={{padding:16,background:p.bg,borderColor:"transparent"}}><div style={{fontSize:11,fontWeight:700,marginBottom:6}}>{p.l}</div><div style={{fontSize:20,fontWeight:700}}>{p.v}</div></Card>)}
        </div>
        <Card><div style={S.cardTitle}>投流节奏 · 4 个阶段</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginTop:12}}>
            {[{p:"1-3天·测款",a:"5-8条笔记自然观察",c:"var(--sky)"},{p:"4-7天·加热",a:"Top2追加聚光¥200/天",c:"var(--amber)"},{p:"8-14天·放量",a:"加预算到¥500/天",c:"var(--brand)"},{p:"15+天·退量",a:"CTR衰减30%退出",c:"oklch(0.7 0.16 290)"}].map((r,i)=>
              <div key={i} style={{padding:12,borderRadius:10,border:`1.5px solid ${r.c}33`,background:r.c+"0a"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}><span style={{fontFamily:"var(--mono)",width:22,height:22,borderRadius:50,background:r.c,color:"white",display:"grid",placeItems:"center",fontSize:11,fontWeight:700}}>{i+1}</span><span style={{fontSize:12,fontWeight:700,color:r.c}}>{r.p}</span></div>
                <div style={{fontSize:11,color:"var(--ink2)",lineHeight:1.6}}>{r.a}</div>
              </div>
            )}
          </div>
        </Card>
      </div>}
    </div>
  </div>);
}

function TrackAnalysisPage() {
  const { keys, routes } = useContext(ApiConfigContext);
  const [track,setTrack]=useState("gongkao");
  const [tab,setTab]=useState("overview");
  const [keyword, setKeyword] = useState("公考");
  const [kbItems, setKbItems] = useState([]);
  const [selectedKb, setSelectedKb] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const hasAI = isBackendMode() || Object.values(keys).some(k => k?.key);
  const tracks=[{id:"gongkao",name:"公考",emoji:"📎",hot:96,growth:"+18%"},{id:"kaoyan",name:"考研",emoji:"🎗",hot:91,growth:"+22%"},{id:"muying",name:"母婴",emoji:"👚",hot:88,growth:"+8%"},{id:"meizhuang",name:"美妆",emoji:"🫕",hot:94,growth:"+12%"},{id:"jiaoyu",name:"教育",emoji:"🎨",hot:90,growth:"+24%"},{id:"3c",name:"3C数码",emoji:"📫",hot:87,growth:"+16%"},{id:"jianshen",name:"健身",emoji:"💭",hot:86,growth:"+15%"},{id:"licai",name:"理财",emoji:"💵",hot:82,growth:"+28%"}];
  const fallbackAnalysis = {
    summary: "先聚焦高意图人群和更容易转化的细分选题，再决定内容节奏和投流预算。",
    overviewAdvice: [
      "优先做能直接承接需求的选题，不先铺大而泛的行业认知。",
      "账号内容需要同时覆盖高热入口词和低竞争蓝海词。",
      "投流测试建议先拿 3-5 个内容角度做小预算验证，再放大。"
    ],
    personas:[{name:"高意图决策人群",pct:32,color:"var(--brand)",hook:"预算有限但想尽快做出结果"},{name:"比较型人群",pct:24,color:"oklch(0.7 0.16 290)",hook:"同类产品到底怎么选"},{name:"新手入门人群",pct:18,color:"var(--amber)",hook:"完全不懂，从哪里开始"},{name:"经验复盘人群",pct:14,color:"var(--sky)",hook:"踩坑总结和真实反馈"},{name:"轻内容陪伴人群",pct:12,color:"var(--mint)",hook:"愿意持续看系列内容"}],
    topics:[{t:"选购避坑清单",hot:95,note:"高转化"},{t:"适合谁 / 不适合谁",hot:91,note:"蓝海"},{t:"真实使用反馈",hot:88,note:"高互动"},{t:"预算分层推荐",hot:85,note:"本周+18%"},{t:"新手入门指南",hot:82,note:"稳定流量"},{t:"同类产品对比",hot:86,note:"竞争↑"},{t:"场景化解决方案",hot:80,note:"蓝海"},{t:"常见误区盘点",hot:78,note:"可系列化"}],
    adMetrics:[{l:"建议月预算",v:"2-5w",bg:"var(--brandSoft)"},{l:"目标CPM",v:"¥18-25",bg:"var(--mintSoft)"},{l:"目标CPL",v:"¥8-18",bg:"var(--amberSoft)"}],
    adPhases:[{p:"1-3天·测试",a:"用 3-5 个选题角度测点击和停留",c:"var(--sky)"},{p:"4-7天·加热",a:"把前 2 条优质内容加预算验证转化",c:"var(--amber)"},{p:"8-14天·放量",a:"围绕转化最好的人群和选题持续扩素材",c:"var(--brand)"},{p:"15天+·迭代",a:"根据评论、私信和表单反馈继续修正内容",c:"oklch(0.7 0.16 290)"}]
  };
  const [analysis, setAnalysis] = useState(fallbackAnalysis);
  const T=tracks.find(x=>x.id===track);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("kb-items");
      if (raw) setKbItems(JSON.parse(raw));
    } catch {}
    try {
      const rawAnalysis = localStorage.getItem("track-analysis-result");
      if (rawAnalysis) setAnalysis(JSON.parse(rawAnalysis));
    } catch {}
  }, []);

  const selectedKnowledge = kbItems.find(item => String(item.id) === String(selectedKb));
  const knowledgeText = selectedKnowledge ? [selectedKnowledge.title, selectedKnowledge.summary, selectedKnowledge.content].filter(Boolean).join("\n") : "";

  const runAnalysis = async () => {
    if (!keyword.trim() && !selectedKnowledge) return;
    setLoading(true); setError(null);
    if (!hasAI) {
      const next = {
        ...fallbackAnalysis,
        summary: `当前赛道聚焦「${keyword || selectedKnowledge?.title || "目标赛道"}」，已结合知识库生成一版兜底分析。`,
        topics: fallbackAnalysis.topics.map((item, i) => ({ ...item, t: i === 0 ? `${keyword || "目标赛道"} ${item.t}` : item.t })),
      };
      setAnalysis(next);
      try { localStorage.setItem("track-analysis-result", JSON.stringify(next)); } catch {}
      setLoading(false);
      return;
    }
    try {
      const result = await callAI({
        keys, routes, scene: "选题挖掘", maxTokens: 2200,
        systemPrompt: "你是小红书赛道分析专家。根据用户输入的赛道关键词和知识库资料，返回 JSON：{\"summary\":\"一句总结\",\"overviewAdvice\":[\"建议1\",\"建议2\",\"建议3\"],\"personas\":[{\"name\":\"人群\",\"pct\":32,\"color\":\"var(--brand)\",\"hook\":\"典型钩子\"}],\"topics\":[{\"t\":\"选题\",\"hot\":95,\"note\":\"蓝海/高转化/高互动/本周+18%\"}],\"adMetrics\":[{\"l\":\"建议月预算\",\"v\":\"2-5w\",\"bg\":\"var(--brandSoft)\"}],\"adPhases\":[{\"p\":\"1-3天·测试\",\"a\":\"动作建议\",\"c\":\"var(--sky)\"}]}。只返回 JSON。",
        prompt: `赛道关键词：${keyword}\n当前预设赛道：${T?.name || ""}\n知识库资料：\n${knowledgeText.slice(0, 5000)}\n\n请输出可直接用于页面展示的赛道分析结果。`
      });
      const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      setAnalysis(parsed);
      try { localStorage.setItem("track-analysis-result", JSON.stringify(parsed)); } catch {}
    } catch(e) {
      setError(e.message?.slice(0,120) || "AI 分析失败，已保留当前结果");
    }
    setLoading(false);
  };

  const personas = analysis.personas || fallbackAnalysis.personas;
  const topics = analysis.topics || fallbackAnalysis.topics;
  const adMetrics = analysis.adMetrics || fallbackAnalysis.adMetrics;
  const adPhases = analysis.adPhases || fallbackAnalysis.adPhases;

  return (<div style={S.page}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:18}}>
      <div><h1 style={S.pageH1}>赛道分析 · 行业雷达</h1><p style={S.pageSub}>先确定赛道关键词，再结合知识库生成可执行的人群、选题和投流策略。</p></div>
      <Btn primary onClick={runAnalysis} disabled={loading || (!keyword.trim() && !selectedKnowledge)}>{loading ? "分析中…" : <><I.Magic size={14}/> AI 定制策略</>}</Btn>
    </div>
    <Card style={{marginBottom:14,border:"1.5px solid var(--brand)"}}>
      <div style={S.cardH}><div><div style={S.cardTitle}>分析输入</div><div style={S.cardSub}>支持手动输入赛道、行业、产品方向，也可以引用知识库补充上下文。</div></div></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 240px",gap:12}}>
        <div><span style={S.label}>赛道关键词</span><input style={S.input} value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder="例如：公考 / 母婴睡眠 / 千元平板 / 祛黄黑皮口红"/></div>
        <div><span style={S.label}>引用知识库</span><select style={S.input} value={selectedKb} onChange={e=>setSelectedKb(e.target.value)}><option value="">不引用</option>{kbItems.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
      </div>
      {selectedKnowledge && <div style={{marginTop:10,padding:"10px 12px",borderRadius:10,background:"var(--surface2)",fontSize:12,color:"var(--ink2)",lineHeight:1.6}}><b>已引用：</b>{selectedKnowledge.title}<br/>{selectedKnowledge.summary}</div>}
      <div style={{marginTop:12,fontSize:12,color:"var(--ink3)"}}>{analysis.summary || fallbackAnalysis.summary}</div>
      {error && <div style={{marginTop:10,padding:"8px 14px",borderRadius:8,background:"oklch(0.96 0.04 25)",color:"var(--brandDeep)",fontSize:12}}>⚠ {error}</div>}
    </Card>
    <Card style={{marginBottom:14}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
        {tracks.map(t => <button key={t.id} onClick={()=>{setTrack(t.id); setKeyword(t.name);}} style={{padding:14,borderRadius:12,textAlign:"left",cursor:"pointer",border:`1.5px solid ${t.id===track?"var(--brand)":"var(--line)"}`,background:t.id===track?"var(--brandSoft)":"var(--surface)"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}><span style={{fontSize:20}}>{t.emoji}</span><span style={{fontSize:14,fontWeight:700}}>{t.name}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10}}><span style={{color:"var(--mintDeep)",fontWeight:700}}>{t.growth}</span><span style={{fontFamily:"var(--mono)",fontWeight:700}}>{t.hot}</span></div>
          <div style={S.hairline}><span style={{display:"block",height:"100%",width:`${t.hot}%`,background:t.id===track?"var(--brand)":"var(--ink3)",borderRadius:999}}/></div>
        </button>)}
      </div>
    </Card>
    <div style={S.seg}>
      {[{id:"overview",l:"📋 总览"},{id:"persona",l:"🎭 素人人设"},{id:"topic",l:"💡 选题趋势"},{id:"ad",l:"📊 投流策略"}].map(t => <button key={t.id} onClick={()=>setTab(t.id)} style={{...S.segBtn,...(tab===t.id?S.segOn:{})}}>{t.l}</button>)}
    </div>
    <div style={{marginTop:14}}>
      {tab==="overview" && <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        <Card><div style={S.cardH}><div style={S.cardTitle}>主流人设占比</div></div>
          {personas.map((p,i)=><div key={i} style={{marginBottom:10}}><div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span style={{fontWeight:600}}>{p.name}</span><span style={{fontFamily:"var(--mono)",fontWeight:700,color:p.color}}>{p.pct}%</span></div><div style={S.hairline}><span style={{display:"block",height:"100%",width:`${p.pct*3}%`,background:p.color,borderRadius:999}}/></div></div>)}
        </Card>
        <Card style={{background:"var(--mintSoft)",borderColor:"transparent"}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--mintDeep)",marginBottom:8}}>本轮运营建议</div>
          <div style={{fontSize:12,lineHeight:1.8}}>{(analysis.overviewAdvice || fallbackAnalysis.overviewAdvice).map((item, i) => <div key={i}>• {item}</div>)}</div>
        </Card>
      </div>}
      {tab==="persona" && <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:14}}>
        {personas.map((p,i) => <Card key={i} style={{borderTop:`3px solid ${p.color}`}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}><div style={{fontSize:16,fontWeight:700}}>{p.name}</div><span style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:p.color}}>{p.pct}%</span></div>
          <div style={{padding:10,background:"var(--surface2)",borderRadius:8,marginBottom:10}}><div style={{fontSize:10,color:"var(--ink3)"}}>典型钩子</div><div style={{fontSize:13,fontFamily:"var(--mono)",color:"var(--ink)"}}>{p.hook}</div></div>
          <Btn sm style={{width:"100%",justifyContent:"center"}}><I.Plus size={12}/> 用此人设起内容</Btn>
        </Card>)}
      </div>}
      {tab==="topic" && <Card>
        <div style={S.cardH}><div><div style={S.cardTitle}>选题热度排行 · 近 30 天</div></div></div>
        {topics.map((t,i) => <div key={i} style={{display:"grid",gridTemplateColumns:"30px 1fr 80px 120px 100px",gap:12,alignItems:"center",padding:12,border:"1px solid var(--line)",borderRadius:10,marginBottom:8}}>
          <span style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:i<3?"var(--brand)":"var(--ink3)"}}>#{i+1}</span>
          <div style={{fontSize:13,fontWeight:600}}>{t.t}</div>
          <div><span style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700}}>{t.hot}</span><div style={S.hairline}><span style={{display:"block",height:"100%",width:`${t.hot}%`,background:"var(--brand)",borderRadius:999}}/></div></div>
          <div>{t.note && <Chip variant={t.note==="蓝海"?"mint":"brand"} style={{fontSize:10}}>{t.note}</Chip>}</div>
          <Btn sm primary style={{padding:"4px 8px"}}><I.Magic size={11}/> 生成</Btn>
        </div>)}
      </Card>}
      {tab==="ad" && <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
          {adMetrics.map(p => <Card key={p.l} style={{padding:16,background:p.bg,borderColor:"transparent"}}><div style={{fontSize:11,fontWeight:700,marginBottom:6}}>{p.l}</div><div style={{fontSize:20,fontWeight:700}}>{p.v}</div></Card>)}
        </div>
        <Card><div style={S.cardTitle}>投流节奏 · 4 个阶段</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginTop:12}}>
            {adPhases.map((r,i)=>
              <div key={i} style={{padding:12,borderRadius:10,border:`1.5px solid ${r.c}33`,background:r.c+"0a"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}><span style={{fontFamily:"var(--mono)",width:22,height:22,borderRadius:50,background:r.c,color:"white",display:"grid",placeItems:"center",fontSize:11,fontWeight:700}}>{i+1}</span><span style={{fontSize:12,fontWeight:700,color:r.c}}>{r.p}</span></div>
                <div style={{fontSize:11,color:"var(--ink2)",lineHeight:1.6}}>{r.a}</div>
              </div>
            )}
          </div>
        </Card>
      </div>}
    </div>
  </div>);
}


/* ═══════════════ Library ═══════════════ */
function LibraryPage() {
  const [notes, setNotes] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({title:"",content:"",tags:"",status:"草稿",account:""});
  const [filter, setFilter] = useState("全部");
  const [viewNote, setViewNote] = useState(null);

  useEffect(() => { try { const r=localStorage.getItem("note-library"); if(r) setNotes(JSON.parse(r)); } catch{} }, []);
  const save = (n) => { setNotes(n); try { localStorage.setItem("note-library", JSON.stringify(n)); } catch{} };

  const addNote = () => {
    if(!form.title.trim()) return;
    const n = { id:Date.now(), ...form, tags:form.tags.split(/[,，、\s]+/).filter(Boolean), addedAt:new Date().toISOString(), wordCount:form.content.length };
    save([n,...notes]); setForm({title:"",content:"",tags:"",status:"草稿",account:""}); setShowAdd(false);
  };
  const deleteNote = (id) => save(notes.filter(n=>n.id!==id));
  const updateStatus = (id, status) => save(notes.map(n=>n.id===id?{...n,status}:n));

  const statuses = ["全部","草稿","待审核","已通过","已发布","已下线"];
  const filtered = filter==="全部" ? notes : notes.filter(n=>n.status===filter);
  const statusColors = {"草稿":"var(--ink3)","待审核":"var(--amber)","已通过":"var(--mint)","已发布":"var(--sky)","已下线":"var(--brand)"};

  return (
    <div style={S.page}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:18 }}>
        <div><h1 style={S.pageH1}>笔记内容库</h1><p style={S.pageSub}>{notes.length} 篇笔记 · 管理所有生成和手写的笔记内容</p></div>
        <Btn primary onClick={()=>setShowAdd(!showAdd)}><I.Plus size={14}/> 新建笔记</Btn>
      </div>

      {showAdd && <Card style={{marginBottom:14,border:"1.5px solid var(--brand)"}}>
        <div style={S.cardH}><div style={S.cardTitle}>新建笔记</div><Btn sm ghost onClick={()=>setShowAdd(false)}><I.Close size={14}/></Btn></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 150px",gap:12,marginBottom:12}}>
          <div><span style={S.label}>标题</span><input style={S.input} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="笔记标题…"/></div>
          <div><span style={S.label}>发布账号</span><input style={S.input} value={form.account} onChange={e=>setForm(f=>({...f,account:e.target.value}))} placeholder="@xxx"/></div>
        </div>
        <span style={S.label}>正文</span>
        <textarea style={{...S.input,minHeight:160,fontSize:13,lineHeight:1.7}} value={form.content} onChange={e=>setForm(f=>({...f,content:e.target.value}))} placeholder="粘贴或编写笔记正文…支持直接从素人爆文生成流程复制过来"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 150px",gap:12,marginTop:12}}>
          <div><span style={S.label}>标签（逗号分隔）</span><input style={S.input} value={form.tags} onChange={e=>setForm(f=>({...f,tags:e.target.value}))} placeholder="#新手妈妈, #育儿干货"/></div>
          <div><span style={S.label}>状态</span><select style={S.input} value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))}><option>草稿</option><option>待审核</option><option>已通过</option><option>已发布</option></select></div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:12}}>
          <span style={{fontSize:11,color:"var(--ink3)"}}>{form.content.length} 字</span>
          <Btn primary onClick={addNote} disabled={!form.title.trim()}><I.Check size={14}/> 保存</Btn>
        </div>
      </Card>}

      {/* Filter bar */}
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {statuses.map(s => <button key={s} onClick={()=>setFilter(s)} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${filter===s?"var(--brand)":"var(--line)"}`,background:filter===s?"var(--brandTint)":"var(--surface)",fontSize:12,fontWeight:600,cursor:"pointer"}}>{s} {s==="全部"?notes.length:notes.filter(n=>n.status===s).length}</button>)}
      </div>

      {filtered.length===0 && !showAdd && <Card style={{display:"flex",flexDirection:"column",alignItems:"center",padding:48,gap:12}}>
        <div style={{fontSize:48}}>📝</div>
        <div style={{fontSize:15,fontWeight:700,color:"var(--ink2)"}}>{filter==="全部"?"暂无笔记":`没有「${filter}」状态的笔记`}</div>
        <Btn primary onClick={()=>setShowAdd(true)} style={{marginTop:8}}><I.Plus size={14}/> 新建笔记</Btn>
      </Card>}

      {filtered.length>0 && <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {filtered.map(n => <Card key={n.id} style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:0}}>
            <div style={{padding:"14px 16px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <span style={{width:8,height:8,borderRadius:50,background:statusColors[n.status]||"var(--ink3)"}}/>
                <Chip style={{fontSize:9,background:(statusColors[n.status]||"var(--ink3)")+"1a",color:statusColors[n.status]}}>{n.status}</Chip>
                {n.account && <span style={{fontSize:11,color:"var(--ink3)"}}>{n.account}</span>}
                <span style={{fontSize:10,color:"var(--ink4)",marginLeft:"auto"}}>{n.wordCount||0}字 · {new Date(n.addedAt).toLocaleDateString()}</span>
              </div>
              <div style={{fontSize:15,fontWeight:700,lineHeight:1.4,marginBottom:6,cursor:"pointer"}} onClick={()=>setViewNote(viewNote===n.id?null:n.id)}>{n.title}</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{(n.tags||[]).map(t => <Chip key={t} variant="brand" style={{fontSize:9}}>{t}</Chip>)}</div>
            </div>
            <div style={{padding:"14px",borderLeft:"1px solid var(--line)",display:"flex",flexDirection:"column",gap:4,justifyContent:"center"}}>
              <select style={{...S.input,fontSize:10,padding:"4px 6px",width:80}} value={n.status} onChange={e=>updateStatus(n.id,e.target.value)}><option>草稿</option><option>待审核</option><option>已通过</option><option>已发布</option><option>已下线</option></select>
              <Btn sm ghost onClick={()=>deleteNote(n.id)} style={{color:"var(--brand)",justifyContent:"center"}}><I.Close size={11}/></Btn>
            </div>
          </div>
          {viewNote===n.id && n.content && <div style={{padding:"12px 16px",borderTop:"1px solid var(--line)",background:"var(--surface2)",maxHeight:300,overflow:"auto"}}>
            <div style={{fontSize:13,lineHeight:1.8,whiteSpace:"pre-wrap"}}>{n.content}</div>
          </div>}
        </Card>)}
      </div>}
    </div>
  );
}

/* ═══════════════ App ═══════════════ */
export default function App() {
  const [page, setPage] = useState("dash");
  const goto = p => setPage(p);
  const apiConfig = useApiConfig();

  return (
    <ApiConfigContext.Provider value={apiConfig}>
      <style>{CSS_GLOBAL}</style>
      <div style={S.app}>
        <Sidebar page={page} setPage={setPage}/>
        <main style={{ overflow:"auto", minHeight:"100vh" }}>
          <TopBar page={page}/>
          {page==="dash" && <Dashboard goto={goto}/>}
          {page==="feature1" && <Feature1/>}
          {page==="feature3" && <Feature3/>}
          {page==="knowledge" && <KnowledgeBase/>}
          {page==="accounts" && <AccountMatrix/>}
          {page==="track" && <TrackAnalysisPage/>}
          {page==="reviewcenter" && <ReviewCenter/>}
          {page==="library" && <LibraryPage/>}
          {page==="materials" && <MaterialPool/>}
          {page==="settings" && <SettingsPage/>}
        </main>
      </div>
    </ApiConfigContext.Provider>
  );
}

/* ═══════════════ Styles ═══════════════ */
const CSS_GLOBAL = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600;700&display=swap');
  :root {
    --brand: oklch(0.68 0.18 25);
    --brandDeep: oklch(0.58 0.18 25);
    --brandSoft: oklch(0.94 0.05 25);
    --brandTint: oklch(0.97 0.025 25);
    --bg: oklch(0.99 0.005 80);
    --surface: #ffffff;
    --surface2: oklch(0.985 0.006 80);
    --surface3: oklch(0.97 0.008 80);
    --line: oklch(0.92 0.008 80);
    --lineStrong: oklch(0.86 0.01 80);
    --ink: oklch(0.22 0.01 60);
    --ink2: oklch(0.42 0.01 60);
    --ink3: oklch(0.58 0.01 60);
    --ink4: oklch(0.74 0.008 80);
    --mint: oklch(0.78 0.12 165);
    --mintDeep: oklch(0.56 0.13 165);
    --mintSoft: oklch(0.95 0.04 165);
    --amber: oklch(0.82 0.14 75);
    --amberDeep: oklch(0.62 0.14 60);
    --amberSoft: oklch(0.96 0.06 80);
    --sky: oklch(0.74 0.13 230);
    --mono: "JetBrains Mono", ui-monospace, monospace;
    --shadow1: 0 1px 2px oklch(0.2 0.01 60 / 0.05), 0 1px 1px oklch(0.2 0.01 60 / 0.04);
    --shadow2: 0 6px 20px -8px oklch(0.2 0.01 60 / 0.12);
    --shadow3: 0 20px 40px -12px oklch(0.2 0.01 60 / 0.18);
  }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: var(--ink); background: var(--bg); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  button { font: inherit; color: inherit; cursor: pointer; }
  input, textarea, select { font: inherit; color: inherit; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--lineStrong); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

const S = {
  app: { display:"grid", gridTemplateColumns:"232px 1fr", minHeight:"100vh", background:"var(--bg)" },
  sidebar: { background:"var(--surface)", borderRight:"1px solid var(--line)", padding:"18px 14px", display:"flex", flexDirection:"column", gap:4, position:"sticky", top:0, height:"100vh", overflow:"auto" },
  brand: { display:"flex", alignItems:"center", gap:10, padding:"6px 10px 18px" },
  brandMark: { width:32, height:32, borderRadius:9, background:"linear-gradient(135deg, var(--brand) 0%, oklch(0.7 0.2 15) 100%)", display:"grid", placeItems:"center", color:"white", fontWeight:800, fontSize:16, boxShadow:"0 4px 10px -4px oklch(0.68 0.18 25 / 0.6)" },
  navLabel: { fontSize:11, color:"var(--ink3)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", padding:"6px 12px" },
  navItem: { display:"flex", alignItems:"center", gap:10, padding:"8px 12px", borderRadius:9, color:"var(--ink2)", fontWeight:500, border:"none", background:"transparent", width:"100%", textAlign:"left", transition:"background .15s, color .15s" },
  navActive: { background:"var(--brandSoft)", color:"var(--brandDeep)", fontWeight:600 },
  navIco: { width:18, height:18, flex:"0 0 18px", display:"grid", placeItems:"center" },
  navBadge: { marginLeft:"auto", background:"var(--brand)", color:"white", fontSize:10, fontWeight:700, padding:"1px 6px", borderRadius:999, fontFamily:"var(--mono)" },
  sidebarBottom: { marginTop:"auto", borderTop:"1px solid var(--line)", paddingTop:10 },
  teamCard: { padding:10, borderRadius:10, background:"var(--surface3)", display:"flex", alignItems:"center", gap:10 },
  avatar: { width:30, height:30, borderRadius:"50%", background:"linear-gradient(135deg, oklch(0.78 0.12 165), oklch(0.7 0.16 290))", display:"grid", placeItems:"center", color:"white", fontWeight:700, fontSize:12 },
  topbar: { height:56, borderBottom:"1px solid var(--line)", background:"oklch(0.99 0.005 80 / 0.85)", backdropFilter:"blur(10px)", display:"flex", alignItems:"center", padding:"0 24px", gap:16, position:"sticky", top:0, zIndex:30 },
  search: { flex:1, maxWidth:380, display:"flex", alignItems:"center", gap:8, background:"var(--surface3)", border:"1px solid transparent", borderRadius:10, padding:"7px 12px", color:"var(--ink3)", fontSize:13, cursor:"text" },
  kbd: { fontFamily:"var(--mono)", fontSize:11, padding:"2px 5px", background:"var(--surface)", border:"1px solid var(--line)", borderRadius:4, color:"var(--ink3)" },
  iconBtn: { width:34, height:34, borderRadius:9, border:"1px solid transparent", background:"transparent", display:"grid", placeItems:"center", color:"var(--ink2)" },
  dot: { position:"absolute", top:8, right:8, width:7, height:7, borderRadius:"50%", background:"var(--brand)", border:"2px solid var(--surface)" },
  page: { padding:"28px 32px 80px", maxWidth:1280 },
  pageH1: { fontSize:26, fontWeight:700, letterSpacing:"-0.02em", margin:"0 0 4px" },
  pageSub: { color:"var(--ink3)", margin:"0 0 24px", fontSize:14 },
  btn: { display:"inline-flex", alignItems:"center", gap:7, padding:"8px 14px", whiteSpace:"nowrap", borderRadius:10, border:"1px solid var(--line)", background:"var(--surface)", color:"var(--ink)", fontWeight:600, fontSize:13, transition:"all .15s", cursor:"pointer" },
  btnPrimary: { background:"var(--brand)", color:"white", borderColor:"transparent", boxShadow:"0 4px 12px -4px oklch(0.68 0.18 25 / 0.5)" },
  btnSm: { padding:"5px 10px", fontSize:12, borderRadius:8 },
  btnGhost: { borderColor:"transparent" },
  card: { background:"var(--surface)", border:"1px solid var(--line)", borderRadius:18, padding:20 },
  cardH: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 },
  cardTitle: { fontSize:15, fontWeight:700, letterSpacing:"-0.01em" },
  cardSub: { fontSize:12, color:"var(--ink3)", marginTop:2 },
  stat: { background:"var(--surface)", border:"1px solid var(--line)", borderRadius:18, padding:18 },
  statLabel: { fontSize:12, color:"var(--ink3)", fontWeight:600 },
  statValue: { fontSize:28, fontWeight:700, letterSpacing:"-0.02em", fontFamily:"var(--mono)", margin:"6px 0 4px" },
  banner: { display:"flex", alignItems:"center", gap:12, padding:"12px 16px", borderRadius:12, background:"linear-gradient(95deg, var(--brandSoft), oklch(0.96 0.04 50))", border:"1px solid oklch(0.9 0.06 30)", fontSize:13, marginBottom:14 },
  icoWrap: { width:32, height:32, borderRadius:9, background:"var(--brand)", color:"white", display:"grid", placeItems:"center" },
  hairline: { height:4, background:"var(--surface3)", borderRadius:999, overflow:"hidden", flex:1, maxWidth:220 },
  label: { fontSize:12, fontWeight:600, color:"var(--ink2)", display:"block", marginBottom:6 },
  input: { border:"1px solid var(--line)", background:"var(--surface)", borderRadius:10, padding:"10px 12px", fontSize:13, width:"100%", outline:"none" },
  seg: { display:"inline-flex", background:"var(--surface3)", padding:3, borderRadius:10, border:"1px solid var(--line)" },
  segBtn: { padding:"5px 12px", fontSize:12, fontWeight:600, whiteSpace:"nowrap", border:"none", background:"transparent", borderRadius:7, color:"var(--ink3)", cursor:"pointer" },
  segOn: { background:"var(--surface)", color:"var(--ink)", boxShadow:"var(--shadow1)" },
};
