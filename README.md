# NeX Client

NeX Client is a modern Electron-based Minecraft launcher and multi-version client ecosystem.

## Features

- Microsoft account authentication
- Multi-version Minecraft launch command generation
- Mod browsing and installation for Modrinth, CurseForge, and Planet Minecraft links
- Resource pack browsing and installation
- Client module configuration with launcher-side Fullbright and FPS tuning
- Minecraft process console logging
- Static website in `website/`

## Local Setup

```bash
npm install
cp .env.example .env
npm start
```

Add your own CurseForge API key to `.env`:

```env
CURSEFORGE_API_KEY=
```

Never commit `.env`.

## Website

Open `website/index.html` in a browser, or publish the `website/` folder with GitHub Pages.
