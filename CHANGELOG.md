# Changelog

## 0.1.0 — initial release

- Custom editor for `.glb` files (single-file mode)
- `Live GLB: Open Viewer` command (workspace-wide mode with scene dropdown)
- Hot-reload via `FileSystemWatcher` (no polling)
- Animated-texture support (reads `gltf.scene.extras.animatedTextures`, blits frames into the live atlas)
- Toggleable grid, axes, wireframe, FPS stats
- Per-file camera persistence
- Screenshot to PNG (saves next to GLB)
- Drag-and-drop a GLB onto the viewer for ad-hoc inspection
- VSCode-theme-matched background, configurable via settings
- Bundled with esbuild — no CDN dependency, fully offline
