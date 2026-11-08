<div align="center">
  <img width="100%" src="https://erika.snowy.moe/v1/banner/Moemu/Erika.webp" alt="Erika Banner" />
  <h1>Erika（絵里香）</h1>
  <i>A banner girl who paints portraits for your repos.</i>
</div>

<p align="center">
  <a href="https://github.com/Moemu/Erika/stargazers"><img src="https://img.shields.io/github/stars/Moemu/Erika" alt="Stars" /></a>
  <a href="https://github.com/Moemu/Erika/actions/workflows/ci.yml"><img src="https://github.com/Moemu/Erika/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://erika.snowy.moe/">🎨 在线预览</a> ·
  <a href="#快速开始">🚀 快速开始</a> ·
  <a href="#部署">📦 部署指南</a> ·
  <a href="#其他-api-端点">📖 API</a>
</p>

## 简介✨

受 [@Multi_Serio_Ai](https://x.com/Multi_Serio_Ai/status/2100800237619347535) 的 [Grokbot Icon Studio 提示词页面](https://grokbot-icon-studio.serio-ai.chatgpt.site/)启发，我们制作了 Erika。

Erika 是一个为 GitHub 仓库生成 Banner 的服务。她把项目插画、名称、描述和星标等信息排成一张图片，让你通过一个 URL 把项目介绍放进 README。

你可以使用自己的插画、GitHub 头像，或直接使用 Erika 的内置插画。在 Playground 中调整样式后，复制 Markdown 即可嵌入。也可以通过 GitHub Actions 定时生成图片，直接保存到仓库。

## 特性🪄

- **仓库信息**：读取公开仓库的名称、描述、星标、Fork 数、开放的 Issue / PR 数和最新 Release。
- **插画与头像**：支持仓库内的图片、GitHub 头像和内置插画，提供两种排版模板。
- **文字排版**：支持中英文、自动换行、字号适配和长文本省略。
- **外观调整**：支持亮暗主题、图标裁切、圆形遮罩，以及 WebP / PNG 输出。
- **在线预览**：通过 URL 分享配置，复制 Markdown、双主题 `<picture>` 或图片链接。
- **部署选择**：支持 Vercel、Docker，以及无需常驻服务的 GitHub Actions。

## 快速开始🚀

首先你需要一张 GrokBot Icon 风格的图片。

<details>
<summary>没有 GrokBot Icon？以下是生成指南</summary>

如果使用 Codex，可以在 Erika 项目中调用内置的 [repo-grokbot-illustration skill](.agents/skills/repo-grokbot-illustration/SKILL.md)。在对话中指定目标仓库，并提供可访问的本地路径或公开仓库地址。例如：

```text
使用 $repo-grokbot-illustration 为 https://github.com/OWNER/REPO 设计项目形象。
先展示几个方案供我选择，再使用上游页面的提示词生成 Grokbot 风格的插画。
```

也可以提供已有角色参考图，或要求生成透明背景版本。选择方案后，说明是否要将图片保存到目标仓库。

也可以手动制作插画：

1. 前往 [由 @Multi_Serio_Ai 制作的 Grokbot Icon Studio 提示词页面](https://grokbot-icon-studio.serio-ai.chatgpt.site/) 生成属于你项目的插画。除了网页自带的提示词，你还可以简单介绍一下你项目的用途，甚至上传与该项目/个人账号相关的动漫角色立绘。

2. （可选的）我们推荐再生成一张不带背景的 GrokBot Icon 用于动态主题切换

3. 将生成好的插画放在项目的 `assets/` 目录中，并命名为 `grokbot-icon.png` (或是压缩后的 `.webp`); 如果有透明版本则命名为 `erika-icon-transparent.png`

</details>

打开 [Playground](https://erika.snowy.moe/)，填写仓库的 Owner 和 Repo，调整图标、文字及主题，然后复制页面生成的 Markdown, URL 或 HTML 代码。

也可以直接把下面的内容放进 README，将 `Moemu/Erika` 替换为你的公开仓库：

```markdown
![项目 Banner](https://erika.snowy.moe/v1/banner/Moemu/Erika.webp)
```

<details>
<summary>跟随 GitHub 的亮暗主题</summary>

使用 `<picture>` 为两种主题分别指定图片：

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://erika.snowy.moe/v1/banner/Moemu/Erika.webp?theme=dark" />
  <img alt="项目 Banner" src="https://erika.snowy.moe/v1/banner/Moemu/Erika.webp?theme=light" />
</picture>
```

</details>

最后启动你的 Markdown 编辑器看看效果吧 Ciallo～(∠・ω< )⌒☆

## 参数说明⚙️

### 项目图标

在未指定图标路径时，Erika 默认会从目标仓库的主分支中，依次查找以下文件。若失败则回退到 Erika 的内置插画：

```text
assets/grokbot-icon.webp
assets/grokbot-icon.png
assets/grokbot-icon.jpg
```

通过查询参数可以更换来源或显示方式：

| 用法 | 效果 |
| --- | --- |
| `?iconPath=assets/my-icon.webp` | 使用目标仓库内的指定图片（主分支，使用相对路径） |
| `?icon=avatar` | 使用仓库所属用户或组织的 GitHub 头像 |
| `?icon=builtin` | 使用 Erika 的内置插画 |
| `?icon=avatar&iconFit=cover&iconRound=1` | 使用填满图标区域的圆形头像 |

建议为亮暗主题共用的插画提供透明 PNG 或 WebP。服务会保留图片像素，不会自动抠图或改变人物颜色。

### 排版模板

| 模板 | 适合的图片 | 排版方式 |
| --- | --- | --- |
| `grokbot` | 带背景留白的项目插画 | 尝试让插画背景与 Banner 底色融合 |
| `avatar` | 普通头像或 Logo | 将图片放入独立区域，与文字保持间距 |

默认使用 `grokbot`；设置 `icon=avatar` 时自动使用 `avatar`。也可以在 URL 中指定模板：

```text
https://erika.snowy.moe/v1/banner/Moemu/Erika/avatar.webp?icon=avatar
```

### 文字与仓库信息

标题和描述默认来自 GitHub，可用 `title`、`description` 覆盖。URL 中的空格、中文及特殊字符需要编码，推荐在 Playground 中填写后复制链接。

`meta` 控制显示哪些仓库信息。例如，只保留星标和最新 Release：

```text
https://erika.snowy.moe/v1/banner/Moemu/Erika.webp?meta=stars,release
```

省略 `meta` 使用模板默认字段；写成 `?meta=` 则隐藏全部仓库信息字段。

Grokbot 和 Avatar 模板还支持 `license`、`language`、`last_updated`，可在 Playground 中勾选，或使用 `?meta=license,language,last_updated`。默认仍显示仓库全名、Star、Fork、Issue 和 Release。

`license` 显示 GitHub 识别的 SPDX 标识；未识别的许可证不显示。`language` 显示主要语言。`last_updated` 使用仓库的 `pushed_at`，按 UTC 显示为 `YYYY-MM-DD`。

描述里可以用 `**…**` 标记一段强调文字，例如 `?description=An **event-loop** chatbot`。

### 其他参数说明

| 参数 | 说明 |
| --- | --- |
| `theme` | `light` / `dark`；省略时根据插画背景自动配色；显式主题决定底色与文字配色，插画按透明度与背景兼容性融合或使用圆角兜底 |
| `accent` | `auto` 从插画取色并调整明度；`#RRGGBB` 指定颜色且保持原值（URL 中 `#` 写作 `%23`）；省略时沿用预设或模板强调色 |
| `icon` | `auto` / `avatar` / `builtin`，默认 `auto` |
| `iconPath` | 仓库内的图片相对路径，最长 128 个字符；仅 `icon=auto`（默认）时有效。下载失败、无法解码或超过图片限制时返回 HTTP 400 JSON，包含失败原因；不回退到内置图 |
| `iconFit` | `contain` 保留完整图片，`cover` 填满区域并裁切 |
| `iconRound` | `1` 启用圆形遮罩，`0` 关闭 |
| `title` | 覆盖标题，最长 25 个字符（版式在该长度下仍完整显示） |
| `description` | 覆盖描述，最长 180 个字符（超出 0.75 倍下限的排版容量会截断） |
| `meta` | 逗号分隔的字段：`full_name`、`stars`、`forks`、`issues`、`release`、`license`、`language`、`last_updated`；需由所选模板支持 |
| `scale` | 缩放比例，范围为 0.1～1；默认 0.5，输出 1500 × 900 图片 |
| `lang` | 错误占位图语言，`en` / `zh`，默认 `en` |
| `fresh` | `fresh=1` 使用 `Cache-Control: no-cache`，让图片代理验证源站；GitHub 数据仍受 Provider 缓存有效期影响。仅接受 `1` |

自动取色会忽略透明像素、识别到的背景色和黑白灰，并按色相、面积与饱和度选色，再调整明度。没有合适颜色时回退到预设或模板强调色。响应头 `X-Banner-Accent` 返回最终色值。CLI 的 `render` 和 `render-live` 同样支持 `--accent auto` 或 `--accent "#8B65B5"`。


## 部署📦

| 方式 | 适合的场景 | 运行方式 |
| --- | --- | --- |
| Vercel | 希望直接获得在线预览和动态 API | 前端静态托管，API 由函数运行 |
| GitHub Actions | 只需要 README 图片，不想维护在线服务 | 定时生成图片并提交到仓库 |
| Docker | 已有容器运行环境，需要自行管理服务 | 同一个容器提供 Playground 和 API |

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMoemu%2FErika&project-name=erika&env=GITHUB_TOKEN)

1. 使用上方按钮部署，或 Fork 后在 Vercel 导入仓库。
2. 将项目根目录设为仓库根目录，保留仓库中的构建配置。
3. 配置 `GITHUB_TOKEN`，使用只读公开仓库的令牌。
4. 部署完成后，打开站点首页预览，或访问 `/v1/banner/:owner/:repo.webp`。

### GitHub Actions

1. 将 [工作流示例](docs/examples/refresh-banner.yml) 复制到你仓库的 `.github/workflows/refresh-banner.yml`。
2. 修改 `BANNER_OWNER`、`BANNER_REPO`、`BANNER_TEMPLATE` 和 `BANNER_OUT`。
3. 在仓库的 Actions 页面启用工作流，并手动运行一次。
4. 在 README 中引用生成的文件，例如 `![项目 Banner](assets/banner.webp)`。

示例每小时运行一次，图片没有变化时不会产生提交。工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`，并需要 `contents: write` 权限来提交图片。

`ERIKA_REF` 默认跟随 `main`。需要固定工具版本时，将其改为已验证的提交 SHA 或发布标签。定时任务可能延迟，图片更新以任务实际完成时间为准。

### Docker

克隆仓库，复制环境变量示例，并在 `.env` 中填写 `GITHUB_TOKEN`：

```bash
git clone https://github.com/Moemu/Erika.git
cd Erika
cp .env.example .env
```

构建并启动服务：

```bash
docker build -t erika:local .
docker run -d --name erika -p 8787:8787 --env-file .env erika:local
```

打开 `http://localhost:8787` 即可使用 Playground，API 使用同一地址。

需要自定义项目预设时，在构建镜像前编辑 [预设配置](apps/api/presets/presets.json)，或将包含 `presets.json` 的目录只读挂载到容器的 `/app/apps/api/presets`。预设在启动时读取，修改挂载文件后需要重启容器。

## 其他 API 端点🧪

| 请求 | 用途 |
| --- | --- |
| `GET /v1/banner/:owner/:repo.webp` | 生成 WebP Banner；扩展名可改为 `.png` |
| `GET /v1/banner/:owner/:repo/:template.webp` | 使用指定模板生成 Banner |
| `GET /v1/meta` | 查询模板、主题、支持的字段和参数限制 |
| `GET /doc` | 获取 OpenAPI 描述 |
| `GET /healthz` | 检查服务状态 |

## 本地开发🛠️

需要 Node.js 22 或更新版本，以及项目 `packageManager` 字段指定的 pnpm。

```bash
git clone https://github.com/Moemu/Erika.git
cd Erika
pnpm install
pnpm build
cp .env.example .env
```

在 `.env` 中填写 `GITHUB_TOKEN`。本项目只读取公开仓库，令牌只需公开信息的读取权限；classic PAT 可不勾选 scope，细粒度令牌可使用公开仓库只读访问。具体权限见 [GitHub 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)。

分别在两个终端启动 API 和 Playground：

```bash
pnpm dev:api
```

```bash
pnpm --filter @erika/playground dev
```

Playground 地址为 `http://localhost:5173`，API 地址为 `http://localhost:8787`。开发预览页会将 API 请求转发到后端。

### CLI 用法

在仓库根目录运行以下命令，读取 GitHub 数据并保存图片：

```bash
node packages/cli/dist/cli.js render-live --owner Moemu --repo Erika --out out/banner.webp
```

也可以直接渲染 Erika 自己的 Banner，输出位于 `out/`：

```bash
pnpm render:erika
```

### 修改与验证

```bash
pnpm build
pnpm test
pnpm typecheck:vercel
```

`pnpm test` 包含单元测试、接口测试和视觉回归。新增模板可从 [模板目录](packages/templates/) 开始；API 位于 `apps/api`，预览页位于 `apps/playground`，渲染器位于 `packages/core`，GitHub 数据访问位于 `packages/providers`。

构建镜像后，可运行容器冒烟测试：

```bash
docker build -t erika:local .
node scripts/smoke-docker.mjs erika:local
```

容器冒烟测试通过真实 HTTP 路由检查页面资源、Banner 渲染、缓存响应和错误占位。测试使用固定上游，不访问真实 GitHub。

如果需要从 PSD 提取图层和文字样式，参考 [PSD 工具说明](packages/psd-toolkit/README.md)。

## 关于🎗️

Erika（絵里香）是一位为仓库绘制肖像的画师少女。项目从手工排版的 PSD 封面图出发，把一张张手工做的介绍图变成可通过 URL 配置、随仓库数据变化的服务。

感谢以下项目与资源：

- [Shields.io](https://shields.io/)：以 URL 配置图片的使用方式。
- [@Multi_Serio_Ai](https://x.com/Multi_Serio_Ai/status/2100800237619347535) 与 [Grokbot Icon Studio](https://grokbot-icon-studio.serio-ai.chatgpt.site/zh-hans)：项目灵感与 Grokbot 风格插画的提示词来源。本项目仅引用链接，不收录提示词。
- [Hono](https://hono.dev/) 与 [Canvas](https://github.com/Brooooooklyn/canvas)：API 服务与图片渲染。

代码、文档及模板配置采用 [MIT](LICENSE) 许可证，再分发时请保留许可声明。

内置插画由 OpenAI GPT-Image-2.5 生成，项目实际持有且有权授权的权利按 MIT 提供。字体遵循各自附带的 OFL 许可；使用自备图片或字体时，请确认相应授权。完整范围及责任说明见 [素材许可说明](ASSET-LICENSE.md)。
