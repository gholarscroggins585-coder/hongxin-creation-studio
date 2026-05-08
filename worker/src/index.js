// Hongxin backend Worker
// - Holds provider API keys as Cloudflare secrets (never exposed to client)
// - Proxies model calls + URL fetching with CORS open to allowlisted origins
// - Optional shared-token gate (X-Access-Token) to keep public deployments from being drained

const PROVIDER_HOSTS = {
  openai:    "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  doubao:    "https://ark.cn-beijing.volces.com",
  qwen:      "https://dashscope.aliyuncs.com",
  deepseek:  "https://api.deepseek.com",
  zhipu:     "https://open.bigmodel.cn",
};

const SECRET_NAMES = {
  openai:    "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  doubao:    "DOUBAO_API_KEY",
  qwen:      "QWEN_API_KEY",
  deepseek:  "DEEPSEEK_API_KEY",
  zhipu:     "ZHIPU_API_KEY",
};

function buildAuthHeaders(provider, apiKey) {
  switch (provider) {
    case "anthropic":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    default:
      return { "Authorization": `Bearer ${apiKey}` };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";

    // CORS preflight
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin, env);

    // Origin allowlist (optional, comma-separated). "*" or empty = allow all.
    const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
    if (origin && !allowed.includes("*") && !allowed.includes(origin)) {
      return cors(new Response("origin not allowed", { status: 403 }), origin, env);
    }

    // Optional shared-token gate
    if (env.ACCESS_TOKEN) {
      const token = req.headers.get("X-Access-Token") || url.searchParams.get("token");
      if (token !== env.ACCESS_TOKEN) {
        return cors(new Response("unauthorized", { status: 401 }), origin, env);
      }
    }

    // Health: report which providers are configured (no secret leak)
    if (url.pathname === "/health") {
      const providers = Object.entries(SECRET_NAMES)
        .filter(([, secret]) => env[secret])
        .map(([id]) => id);
      return cors(Response.json({
        ok: true,
        providers,
        accessTokenRequired: !!env.ACCESS_TOKEN,
        version: "1",
      }), origin, env);
    }

    // URL fetching (KB scrape)
    if (url.pathname === "/fetch") {
      const target = url.searchParams.get("url");
      if (!target) return cors(new Response("missing url", { status: 400 }), origin, env);
      try {
        const r = await fetch(target, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; hongxin-backend/1)" },
          redirect: "follow",
          cf: { cacheTtl: 60, cacheEverything: true },
        });
        const body = await r.text();
        return cors(new Response(body, {
          status: r.status,
          headers: { "Content-Type": r.headers.get("Content-Type") || "text/html; charset=utf-8" },
        }), origin, env);
      } catch (e) {
        return cors(new Response(`fetch failed: ${e.message}`, { status: 502 }), origin, env);
      }
    }

    // Provider proxy: /<provider>/<rest>
    const m = url.pathname.match(/^\/([a-z]+)(\/.*)?$/);
    if (!m) return cors(new Response("not found", { status: 404 }), origin, env);
    const [, provider, rest] = m;
    const host = PROVIDER_HOSTS[provider];
    const secretName = SECRET_NAMES[provider];
    if (!host || !secretName) return cors(new Response(`unknown provider: ${provider}`, { status: 400 }), origin, env);
    const apiKey = env[secretName];
    if (!apiKey) return cors(new Response(`provider not configured: ${provider}`, { status: 503 }), origin, env);

    const targetUrl = host + (rest || "") + url.search;
    const headers = new Headers();
    const passthrough = ["content-type", "accept", "user-agent"];
    for (const [k, v] of req.headers) {
      if (passthrough.includes(k.toLowerCase())) headers.set(k, v);
    }
    Object.entries(buildAuthHeaders(provider, apiKey)).forEach(([k, v]) => headers.set(k, v));

    let body = undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      body = await req.arrayBuffer();
    }

    try {
      const r = await fetch(targetUrl, { method: req.method, headers, body });
      const respHeaders = new Headers();
      respHeaders.set("Content-Type", r.headers.get("Content-Type") || "application/json");
      return cors(new Response(r.body, { status: r.status, headers: respHeaders }), origin, env);
    } catch (e) {
      return cors(new Response(`upstream failure: ${e.message}`, { status: 502 }), origin, env);
    }
  },
};

function cors(res, origin, env) {
  const allowed = (env?.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0] || "*");
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", allowOrigin);
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Access-Token, x-api-key, anthropic-version");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
