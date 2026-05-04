# 红芯创作台 · 公考小红书运营中心

AI 驱动的小红书内容批量生产系统，支持素人爆文生成、聚光投流素材、多 Agent 验证、GPT Image 2 批量出图。

## 功能特性

- 🎯 **素人爆文批量生成** — 5 步流程：选题→Agent验证→文案→出图→导出
- 📢 **聚光投流素材** — 6 段式最优文案结构 + 素材矩阵
- 🤖 **多模型接入** — 支持 Claude / OpenAI / 豆包 / 通义千问 / DeepSeek / 智谱
- 🖼️ **GPT Image 2 出图** — 3:4 小红书比例，统一风格批量生成
- 📊 **数据中心** — 账号矩阵、赛道分析、数据复盘
- ✅ **审批流** — 运营→主编→合规→发布

## 快速部署到 GitHub Pages

### 方式一：GitHub Actions 自动部署（推荐）

1. **创建 GitHub 仓库**
   ```bash
   # 在 GitHub 上创建新仓库，例如 hongxin-studio
   ```

2. **推送代码**
   ```bash
   cd hongxin-app
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/你的用户名/hongxin-studio.git
   git push -u origin main
   ```

3. **开启 GitHub Pages**
   - 进入仓库 → Settings → Pages
   - Source 选择 **GitHub Actions**
   - 等待 Actions 自动构建部署

4. **访问网站**
   ```
   https://你的用户名.github.io/hongxin-studio/
   ```

### 方式二：手动构建部署

```bash
npm install
npm run build
npm run deploy  # 使用 gh-pages 部署到 gh-pages 分支
```

## 配置 API Key

部署完成后，在网站内进入 **设置中心 → 模型接入**：

1. 填入对应厂商的 API Key
2. 点击「测试连接」验证
3. 保存后即可在生成流程中调用真实 AI

> API Key 仅保存在浏览器 localStorage 中，不会上传到任何服务器。

## 技术栈

- React 18 + Vite
- 纯 CSS-in-JS（无依赖）
- Anthropic / OpenAI API 直连
- GitHub Pages 静态托管
