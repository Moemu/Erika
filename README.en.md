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
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="https://erika.snowy.moe/?uiLang=en">🎨 Playground</a> ·
  <a href="#quick-start">🚀 Quick start</a> ·
  <a href="#deployment">📦 Deployment</a> ·
  <a href="#other-api-endpoints">📖 API</a>
</p>

## Introduction✨

Inspired by [@Multi_Serio_Ai](https://x.com/Multi_Serio_Ai/status/2100800237619347535)'s [Grokbot Icon Studio prompt page](https://grokbot-icon-studio.serio-ai.chatgpt.site/), we created Erika.

Erika generates banners for GitHub repositories. She combines your project illustration, name, description, and stats into one image. Add a URL to your README to display it.

Use your own illustration, a GitHub avatar, or Erika's built-in illustration. Adjust the style in the Playground, then copy the Markdown. You can also generate images with scheduled GitHub Actions and save them to your repository.

## Features🪄

- **Repository information**: Read the name, description, stars, forks, open issues and pull requests, and latest release from public repositories.
- **Illustrations and avatars**: Use repository images, GitHub avatars, or built-in illustrations with two layout templates.
- **Text layout**: Support Chinese and English, line wrapping, automatic font sizing, and truncation for long text.
- **Appearance**: Choose light or dark themes, image cropping, circular masks, and WebP or PNG output.
- **Live preview**: Share settings through a URL. Copy Markdown, a dual-theme `<picture>`, or an image URL.
- **Deployment**: Use Vercel, Docker, or GitHub Actions without a running server.

## Quick start🚀

Start with a GrokBot Icon style image.

<details>
<summary>No GrokBot Icon yet? Here is how to create one</summary>

1. Visit [Grokbot Icon Studio, created by @Multi_Serio_Ai](https://grokbot-icon-studio.serio-ai.chatgpt.site/en), to create an illustration for your project. Alongside the supplied prompt, describe your project or attach an anime character reference associated with your project or personal account.

2. Optionally, generate a version without a background for switching between light and dark themes.

3. Save the illustration in your project's `assets/` directory as `grokbot-icon.png` (or a compressed `.webp`). Name the transparent version `erika-icon-transparent.png`, if you have one.

</details>

Open the [Playground](https://erika.snowy.moe/?uiLang=en). Enter Owner and Repo, adjust the icon, text, and theme, then copy the generated Markdown, URL, or HTML.

You can also add this to your README. Replace `Moemu/Erika` with your public repository:

```markdown
![Project banner](https://erika.snowy.moe/v1/banner/Moemu/Erika.webp)
```

<details>
<summary>Follow GitHub's light and dark themes</summary>

Use `<picture>` to specify an image for each theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://erika.snowy.moe/v1/banner/Moemu/Erika.webp?theme=dark" />
  <img alt="Project banner" src="https://erika.snowy.moe/v1/banner/Moemu/Erika.webp?theme=light" />
</picture>
```

</details>

Now open your Markdown editor and take a look. Ciallo～(∠・ω< )⌒☆

## Parameters⚙️

### Project icon

Without an explicit icon path, Erika checks these files on the target repository's default branch, in order. If none work, she uses the built-in illustration:

```text
assets/grokbot-icon.webp
assets/grokbot-icon.png
assets/grokbot-icon.jpg
```

Use query parameters to change the source or display:

| Usage | Result |
| --- | --- |
| `?iconPath=assets/my-icon.webp` | Use the specified image from the repository's default branch, with a relative path |
| `?icon=avatar` | Use the repository owner's GitHub user or organization avatar |
| `?icon=builtin` | Use Erika's built-in illustration |
| `?icon=avatar&iconFit=cover&iconRound=1` | Use a circular avatar that fills the icon area |

Use transparent PNG or WebP for illustrations shared across light and dark themes. The service preserves image pixels. It does not remove backgrounds or change character colors.

### Layout templates

| Template | Suitable images | Layout |
| --- | --- | --- |
| `grokbot` | Project illustrations with background space | Try to blend the illustration background with the banner background |
| `avatar` | Avatars or logos | Place the image in a separate area with space between the image and text |

The default template is `grokbot`. Setting `icon=avatar` automatically selects `avatar`. You can also specify the template in the URL:

```text
https://erika.snowy.moe/v1/banner/Moemu/Erika/avatar.webp?icon=avatar
```

### Text and repository information

The title and description come from GitHub by default. Override them with `title` and `description`. Encode spaces, Chinese characters, and special characters in URLs. Use the Playground to enter text and copy an encoded URL.

`meta` controls which repository fields appear. For example, show only stars and the latest release:

```text
https://erika.snowy.moe/v1/banner/Moemu/Erika.webp?meta=stars,release
```

Omit `meta` to use the template's default fields. Set `?meta=` to hide all repository information fields.

Grokbot and Avatar also support `license`, `language`, and `last_updated`. Select them in the Playground or use `?meta=license,language,last_updated`. The defaults remain repository name, Star, Fork, Issue, and Release.

`license` shows the SPDX identifier recognized by GitHub. Unrecognized licenses are omitted. `language` shows the primary language. `last_updated` uses the repository's `pushed_at` and displays the UTC date as `YYYY-MM-DD`.

Use `**…**` to highlight text in descriptions, such as `?description=An **event-loop** chatbot`.

### Other parameters

| Parameter | Description |
| --- | --- |
| `theme` | `light` / `dark`. When omitted, colors follow the illustration background. Explicit themes control the background and text colors. Illustrations blend in or use rounded corners, depending on transparency and background compatibility. |
| `accent` | `auto` detects an artwork color and adjusts it for readability; `#RRGGBB` uses the exact color (encode `#` as `%23` in URLs). Omit to keep the preset or template accent. |
| `icon` | `auto` / `avatar` / `builtin`; default: `auto` |
| `iconPath` | Relative image path within the repository, up to 128 characters; only applies with `icon=auto` (the default) |
| `iconFit` | `contain` keeps the full image; `cover` fills the area and crops the image |
| `iconRound` | `1` enables a circular mask; `0` disables it |
| `title` | Override the title, up to 25 characters. The layout can display this length in full. |
| `description` | Override the description, up to 180 characters. Text that exceeds the layout capacity at the minimum 0.75 font scale is truncated. |
| `meta` | Comma-separated fields: `full_name`, `stars`, `forks`, `issues`, `release`, `license`, `language`, `last_updated`. The selected template must support them. |
| `scale` | Output scale from 0.1 to 1; default: 0.5, producing a 1500 × 900 image |
| `lang` | Error placeholder language: `en` / `zh`; default: `en` |
| `fresh` | `fresh=1` uses `Cache-Control: no-cache` so image proxies validate with the origin. GitHub data still follows the Provider cache lifetime. Only `1` is accepted. |

Automatic detection ignores transparent pixels, detected backdrops, and neutral colors. It selects a hue by area and saturation, then adjusts brightness for readability. If no suitable color exists, it keeps the preset or template accent. The `X-Banner-Accent` response header reports the final color. CLI commands `render` and `render-live` also accept `--accent auto` or `--accent "#8B65B5"`.


## Deployment📦

| Method | Suitable use | How it runs |
| --- | --- | --- |
| Vercel | Live preview and a dynamic API | Static frontend hosting with a function-based API |
| GitHub Actions | README images without maintaining an online service | Generate images on a schedule and commit them to the repository |
| Docker | An existing container environment that you manage | One container serves the Playground and API |

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMoemu%2FErika&project-name=erika&env=GITHUB_TOKEN)

1. Deploy with the button above, or fork the repository and import it into Vercel.
2. Set the project root to the repository root. Keep the repository's build configuration.
3. Set `GITHUB_TOKEN` to a token with read-only access to public repositories.
4. Open the site homepage to preview, or visit `/v1/banner/:owner/:repo.webp`.

### GitHub Actions

1. Copy the [workflow example](docs/examples/refresh-banner.yml) to `.github/workflows/refresh-banner.yml` in your repository.
2. Update `BANNER_OWNER`, `BANNER_REPO`, `BANNER_TEMPLATE`, and `BANNER_OUT`.
3. Enable the workflow on your repository's Actions page, then run it manually once.
4. Reference the generated file in your README, for example: `![Project banner](assets/banner.webp)`.

The example runs hourly. It makes no commit when the image is unchanged. It uses GitHub's automatic `GITHUB_TOKEN` and needs `contents: write` permission to commit images.

`ERIKA_REF` follows `main` by default. Set a verified commit SHA or release tag to pin the tool version. Scheduled runs may be delayed. Images update when the run finishes.

### Docker

Clone the repository, copy the environment example, and set `GITHUB_TOKEN` in `.env`:

```bash
git clone https://github.com/Moemu/Erika.git
cd Erika
cp .env.example .env
```

Build and start the service:

```bash
docker build -t erika:local .
docker run -d --name erika -p 8787:8787 --env-file .env erika:local
```

Open `http://localhost:8787` to use the Playground. The API uses the same address.

To customize project presets, edit the [preset configuration](apps/api/presets/presets.json) before building the image. Alternatively, mount a directory containing `presets.json` read-only at `/app/apps/api/presets`. Presets load at startup. Restart the container after changing mounted files.

## Other API endpoints🧪

| Request | Purpose |
| --- | --- |
| `GET /v1/banner/:owner/:repo.webp` | Generate a WebP banner; change the extension to `.png` for PNG |
| `GET /v1/banner/:owner/:repo/:template.webp` | Generate a banner with a specific template |
| `GET /v1/meta` | List templates, themes, supported fields, and parameter limits |
| `GET /doc` | Get the OpenAPI description |
| `GET /healthz` | Check service health |

## Local development🛠️

Use Node.js 22 or later and the pnpm version specified in the project's `packageManager` field.

```bash
git clone https://github.com/Moemu/Erika.git
cd Erika
pnpm install
pnpm build
cp .env.example .env
```

Set `GITHUB_TOKEN` in `.env`. This project reads only public repositories, so the token needs only public information read access. A classic PAT can have no scopes selected. A fine-grained token can use read-only public repository access. See [GitHub's documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) for permissions.

Start the API and Playground in separate terminals:

```bash
pnpm dev:api
```

```bash
pnpm --filter @erika/playground dev
```

The Playground runs at `http://localhost:5173`, and the API runs at `http://localhost:8787`. The development preview forwards API requests to the backend.

### CLI usage

Run this command from the repository root to read GitHub data and save an image:

```bash
node packages/cli/dist/cli.js render-live --owner Moemu --repo Erika --out out/banner.webp
```

You can also render Erika's own banner. The output is saved in `out/`:

```bash
pnpm render:erika
```

### Changes and validation

```bash
pnpm build
pnpm test
pnpm typecheck:vercel
```

`pnpm test` includes unit tests, API tests, and visual regression. Start in the [template directory](packages/templates/) to add templates. The API is in `apps/api`, the preview is in `apps/playground`, the renderer is in `packages/core`, and GitHub data access is in `packages/providers`.

After building the image, run the container smoke test:

```bash
docker build -t erika:local .
node scripts/smoke-docker.mjs erika:local
```

The container smoke test checks page assets, banner rendering, cache responses, and error placeholders through real HTTP routes. It uses a fixed upstream without accessing real GitHub.

To extract layers and text styles from PSD files, see the [PSD toolkit guide](packages/psd-toolkit/README.md).

## About🎗️

Erika（絵里香）is a banner girl who paints portraits for repositories. The project started with manually arranged PSD covers. It turns those introductions into a URL-configured service that updates with repository data.

Thanks to these projects and resources:

- [Shields.io](https://shields.io/): Configuring images through URLs.
- [@Multi_Serio_Ai](https://x.com/Multi_Serio_Ai/status/2100800237619347535) and [Grokbot Icon Studio](https://grokbot-icon-studio.serio-ai.chatgpt.site/en): Project inspiration and prompts for Grokbot style illustrations. This project links to the prompts without including them.
- [Hono](https://hono.dev/) and [Canvas](https://github.com/Brooooooklyn/canvas): The API service and image rendering.

Code, documentation, and template configurations use the [MIT](LICENSE) license. Keep the license notice when redistributing them.

Built-in illustrations were generated with OpenAI GPT-Image-2.5. Rights that the project holds and can license are provided under MIT. Fonts follow their included OFL licenses. Check the relevant permissions when using your own images or fonts. See the [asset license](ASSET-LICENSE.md) for the full scope and responsibilities.
