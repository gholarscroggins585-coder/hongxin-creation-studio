# 红芯创作台 · 公考小红书运营中心

AI 驱动的小红书内容批量生产系统：素人爆文、聚光投流素材、多 Agent 验证、GPT Image 真出图。两种部署模式：

- 🅰️ **BYO-Key 模式（默认）**：纯前端，访客自己配 API Key，本地浏览器存储。零运维。
- 🅱️ **托管后端模式**：管理员部署 Cloudflare Worker（含密钥），访客零配置打开即用。两种模式共用一份代码。

## 功能特性

- 🎯 **素人爆文批量生成** — 5 步流程：选题 → 5 Agent 联合验证 → 文案 → 出图 → 导出
- 📢 **聚光投流素材** — 6 段式投流文案结构 + 素材矩阵 + 合规检测
- 🤖 **多模型路由** — Claude / OpenAI / 豆包 / 通义千问 / DeepSeek / 智谱，每个场景可独立配主备
- 🖼️ **GPT Image 出图** — 3:4 小红书比例 · 单图重绘 / 参考图编辑 / 批量
- 📚 **行业知识库 · 真解析** — PDF / DOCX / XLSX / CSV / TXT / MD / JSON 全部抽取正文，URL 自动抓取
- 📊 **数据中心** — 账号矩阵、赛道分析、数据复盘
- 🛡️ **CORS 代理一键模板** — 内置 Cloudflare Worker 代码，国产模型/图像生成 CORS 秒解

## 🅰️ BYO-Key 模式 · 30 秒上手

```bash
npm install
npm run dev      # 本地起 http://localhost:5173
```

打开后进入 **设置中心**，按页面顶部的「30 秒接入指南」操作：

1. **Anthropic Key**（文本，CORS 已开放）→ 注册 https://console.anthropic.com/settings/keys → 填进 Claude 卡片 → 测试连接
2. **OpenAI Key**（图片必需）→ 注册 https://platform.openai.com/api-keys → 填进 OpenAI 卡片
3. 直接进「素人爆文生成」开始用

> 只要这两把 Key，整个素人爆文+投流素材+知识库摘要+出图全流程立刻真 AI 跑通。Key 仅存在你自己的浏览器 localStorage。

## 🅱️ 托管后端模式 · 让访客零配置使用

适合：给团队 / 客户 / 公开 demo 用，不想让每个访客都自己申请 Key。

### 部署 Worker（一次性 5 分钟）

```bash
cd worker
npm install
npx wrangler login                          # 登录 Cloudflare 账号
npx wrangler secret put ANTHROPIC_API_KEY   # 输入你的 Anthropic Key
npx wrangler secret put OPENAI_API_KEY      # 输入你的 OpenAI Key
# （可选）其他厂商：DOUBAO_API_KEY / QWEN_API_KEY / DEEPSEEK_API_KEY / ZHIPU_API_KEY
# （可选）公网部署强烈推荐设个共享密钥防止 Token 被白嫖：
npx wrangler secret put ACCESS_TOKEN        # 输入一段长随机字符串

npm run deploy                              # 部署
# 完成后会输出 https://hongxin-backend.<你的子域>.workers.dev
```

### 收紧 Worker 的访问范围（推荐）

编辑 `worker/wrangler.toml` 把 `ALLOWED_ORIGINS` 改成你的前端域名，避免被陌生站点白嫖：

```toml
[vars]
ALLOWED_ORIGINS = "https://你的部署域名.com,http://localhost:5173"
```

然后再 `npm run deploy`。

### 让前端连上 Worker

在 `hongxin-app/` 下创建 `.env.local`：

```bash
VITE_BACKEND_URL=https://hongxin-backend.<你的子域>.workers.dev
# 如果 Worker 设了 ACCESS_TOKEN，这里也要填同一个值：
VITE_BACKEND_TOKEN=<同样的随机字符串>
```

然后 `npm run build && npm run deploy`（或重新部署到 Vercel/Netlify）。

✓ 部署完，访客打开网站直接看到「✓ 已接入托管后端 · 开箱即用」绿色横幅，无需任何配置即可使用所有 AI 能力。访客可选择填入个人 Key 覆盖托管后端（仅他自己浏览器生效）。

详细 Worker 文档见 [`worker/`](./worker/) 目录。

## 解决 CORS（国产模型 / 图像 / URL 抓取）

浏览器直连 OpenAI/豆包/通义/DeepSeek/智谱 多数会撞 CORS。**设置中心 → 网络/代理** 标签页里附了完整的 Cloudflare Worker 代码，免费 5 分钟搞定：

1. 注册 https://dash.cloudflare.com → Workers & Pages → Create
2. 选 Hello World 模板 → Edit Code → 粘代码 → Save and Deploy
3. 拿到 `https://xxx.workers.dev`
4. 回设置中心，每个模型卡的「自定义 BaseURL」按对应路径填：
   - OpenAI → `https://xxx.workers.dev/openai`
   - Anthropic → `https://xxx.workers.dev/anthropic`
   - 豆包/通义/DeepSeek/智谱 同理
5. 知识库 URL 抓取代理填 `https://xxx.workers.dev/fetch?url={url}`

## 知识库支持的格式

| 格式 | 解析方式 | 备注 |
|---|---|---|
| `.pdf` | pdfjs-dist 抽文本 | 自动按页面拼接，最多 80k 字符 |
| `.docx` | mammoth.extractRawText | 纯文本，丢样式 |
| `.xlsx` / `.xls` | SheetJS sheet_to_csv | 每个 sheet 转 CSV 拼接 |
| `.txt` / `.csv` / `.md` / `.json` | 直接读取 | 原样保留 |
| URL | 公共/自定义 CORS 代理 + DOMParser | 剥 nav/script/footer 后抽正文 |
| ❌ `.ppt` / `.pptx` / `.doc` | 不支持 | 请另存为 `.pdf` 或 `.docx` |

解析依赖懒加载 —— 不上传文件时主包仅 ~97 KB gzip。

## 部署到 GitHub Pages（静态托管）

### 自动部署

```bash
git init && git add . && git commit -m "initial"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

进仓库 → Settings → Pages → Source 选 **GitHub Actions**，等构建完成后访问 `https://<user>.github.io/<repo>/`。

### 手动部署

```bash
npm run build          # 产物在 dist/
npm run deploy         # gh-pages 推到 gh-pages 分支
```

也可直接把 `dist/` 丢到 Vercel / Netlify / Cloudflare Pages，无任何后端依赖。

## 数据存储

所有用户数据（API Key、知识库、笔记、素材、账号矩阵、复盘记录、赛道分析结果）只存浏览器 localStorage，**不上传任何服务器**。换设备需重新配置或导出迁移。

## 技术栈

- React 18 + Vite 6
- 纯 CSS-in-JS（无 UI 库依赖）
- 各家 AI API 直连（支持自定义 BaseURL 代理）
- 文件解析：pdfjs-dist / mammoth / xlsx（懒加载分包）

## 已知约束

- `xlsx` 上游有 ReDoS 警告（无补丁版本）；纯前端处理自有文件影响低，敏感场景可换 SheetJS CDN 安装
- 公共 CORS 代理（corsproxy.io、allorigins.win）有速率限制；高频使用请部署自己的 Worker
- localStorage 上限 ~5MB，知识库存大量大文件时建议清理或定期导出

## License

MIT
