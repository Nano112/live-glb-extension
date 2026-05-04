<p align="center">
  <img src="media/icon.png" width="96" height="96" alt="Live GLB Viewer icon">
</p>

<h1 align="center">Live GLB Viewer</h1>

<p align="center">
  A hot-reloading GLB viewer for VSCode. No webserver, no polling — uses the workspace <code>FileSystemWatcher</code> and posts changes straight to a webview.
</p>

## Features

- **Custom editor for `.glb`** — click any `.glb` in the explorer to open it
- **Workspace viewer** — `Live GLB: Open Viewer` from the Command Palette, scene dropdown across the whole workspace
- **Hot-reload** — re-saves the GLB while you work, the viewer updates in place (no setInterval, no fetch loop)
- **Animated textures** — reads `gltf.scene.extras.animatedTextures`, advances frames on a configurable tick, blits frames into the live atlas via `copyTextureToTexture` (no material swap)
- **Per-file camera persistence** — your view angle survives reloads
- **Drag-and-drop** a `.glb` onto the viewer for ad-hoc inspection
- **Screenshot to PNG** (saved next to the GLB)
- Toggleable grid / axes / wireframe / FPS stats
- VSCode-theme-matched UI

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| R | Reset camera |
| G | Toggle grid |
| X | Toggle axes |
| W | Toggle wireframe |
| F | Toggle FPS stats |
| A | Pause / resume animated textures |
| S | Save screenshot |

## Settings

| Setting | Default | Notes |
|---------|---------|-------|
| `liveGlb.backgroundColor` | `""` | Empty = match VSCode editor background |
| `liveGlb.gridEnabled` | `true` |  |
| `liveGlb.gridSize` | `20` |  |
| `liveGlb.axesEnabled` | `false` |  |
| `liveGlb.statsEnabled` | `false` |  |
| `liveGlb.tickMs` | `50` | Animated-texture tick (Minecraft = 50) |
| `liveGlb.autoFrameOnReload` | `false` | If true, re-frame camera on every reload |
| `liveGlb.excludeGlobs` | `node_modules`, `.git`, `dist`, `out` | Workspace scan excludes |

## Development

```sh
npm install
npm run build       # bundles extension + webview with esbuild
npm run watch       # incremental rebuilds
npm run typecheck   # tsc --noEmit
```

Press **F5** in the extension folder to launch an Extension Development Host with the extension loaded.

## Publishing

Before `vsce publish`:

1. Set a real `publisher` in `package.json` (and `vsce login <publisher>`)
2. Update `repository.url`
3. Add a 128×128 `media/icon.png` and an `"icon": "media/icon.png"` field to `package.json`
4. `npm run package` produces a `.vsix`; `vsce publish` uploads to the Marketplace
