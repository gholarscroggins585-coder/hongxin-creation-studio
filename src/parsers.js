// Lazy-loaded parsers. The heavy libs (pdfjs, mammoth, xlsx) only load
// when the user actually parses a file — keeps the initial bundle small.

const MAX_TEXT = 80000;

export async function parsePdf(file) {
  const [pdfjsLib, workerMod] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerMod.default;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out.push(tc.items.map(it => it.str).join(" "));
    if (out.join("\n").length > MAX_TEXT) break;
  }
  return out.join("\n\n").slice(0, MAX_TEXT);
}

export async function parseDocx(file) {
  const mammoth = await import("mammoth");
  const buf = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  return (value || "").slice(0, MAX_TEXT);
}

export async function parseXlsx(file) {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sections = wb.SheetNames.map(name => {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return `# ${name}\n${csv}`;
  });
  return sections.join("\n\n").slice(0, MAX_TEXT);
}

const SUPPORTED = ["txt", "csv", "md", "json", "pdf", "docx", "xlsx", "xls"];

export function isSupportedFile(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return SUPPORTED.includes(ext);
}

export async function parseFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["txt", "csv", "md", "json"].includes(ext)) return (await file.text()).slice(0, MAX_TEXT);
  if (ext === "pdf") return await parsePdf(file);
  if (ext === "docx") return await parseDocx(file);
  if (ext === "xlsx" || ext === "xls") return await parseXlsx(file);
  throw new Error(`暂不支持 .${ext}（已支持：pdf / docx / xlsx / xls / txt / csv / md / json）`);
}

const PUBLIC_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

function applyCustomProxy(template, target) {
  if (template.includes("{url}")) return template.replace("{url}", encodeURIComponent(target));
  const sep = template.includes("?") ? "&" : "?";
  return `${template}${sep}url=${encodeURIComponent(target)}`;
}

function htmlToReadable(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,nav,footer,iframe,svg,img").forEach(el => el.remove());
  const title = (doc.querySelector("title")?.textContent || doc.querySelector("h1")?.textContent || "").trim();
  const main = doc.querySelector("article, main, [role='main']") || doc.body || doc.documentElement;
  const text = (main.textContent || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return { title, text };
}

export async function fetchUrlContent(url, customProxyTemplate) {
  const candidates = [];
  if (customProxyTemplate?.trim()) {
    const tpl = customProxyTemplate.trim();
    candidates.push(target => applyCustomProxy(tpl, target));
  }
  candidates.push(...PUBLIC_PROXIES);

  let lastError = null;
  for (const buildUrl of candidates) {
    try {
      const res = await fetch(buildUrl(url), { redirect: "follow" });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const html = await res.text();
      if (!html) { lastError = new Error("响应为空"); continue; }
      return htmlToReadable(html);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("所有代理抓取均失败");
}
