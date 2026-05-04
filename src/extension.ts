import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";

const CAM_PREFIX = "liveGlb.cam:";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("liveGlb.open", () => openWorkspaceViewer(context)),
    vscode.window.registerCustomEditorProvider(
      "liveGlb.viewer",
      new GlbEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );
}

export function deactivate() {}

// ── Shared helpers ────────────────────────────────────────────────
function getConfig() {
  const c = vscode.workspace.getConfiguration("liveGlb");
  return {
    backgroundColor: c.get<string>("backgroundColor", ""),
    gridEnabled: c.get<boolean>("gridEnabled", true),
    gridSize: c.get<number>("gridSize", 20),
    axesEnabled: c.get<boolean>("axesEnabled", false),
    statsEnabled: c.get<boolean>("statsEnabled", false),
    tickMs: c.get<number>("tickMs", 50),
    autoFrameOnReload: c.get<boolean>("autoFrameOnReload", false),
    excludeGlobs: c.get<string[]>("excludeGlobs", []),
  };
}

function camKey(fsPath: string) {
  return CAM_PREFIX + fsPath;
}

async function writeScreenshot(glbFsPath: string, dataUrl: string): Promise<string> {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("invalid screenshot payload");
  const bytes = Buffer.from(m[1], "base64");
  const dir = path.dirname(glbFsPath);
  const base = path.basename(glbFsPath, ".glb");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(dir, `${base}.${stamp}.png`);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(out), bytes);
  return out;
}

function setupPanel(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  opts: {
    initialScenes: () => Promise<{ name: string; uri: string; fsPath: string; savedCamera?: any }[]>;
    activeUri?: () => string | undefined;
    watcher: vscode.FileSystemWatcher;
    onWatcherChange?: (changedUri: vscode.Uri) => void;
  }
) {
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);

  const sendConfig = () => panel.webview.postMessage({ type: "config", config: getConfig() });
  const sendScenes = async () =>
    panel.webview.postMessage({
      type: "scenes",
      scenes: await opts.initialScenes(),
      active: opts.activeUri?.(),
    });

  const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("liveGlb")) sendConfig();
  });

  const themeListener = vscode.window.onDidChangeActiveColorTheme(() =>
    panel.webview.postMessage({ type: "theme" })
  );

  opts.watcher.onDidChange((uri) => {
    opts.onWatcherChange?.(uri);
    panel.webview.postMessage({
      type: "changed",
      uri: panel.webview.asWebviewUri(uri).toString(),
      fsPath: uri.fsPath,
    });
  });
  opts.watcher.onDidCreate(() => sendScenes());
  opts.watcher.onDidDelete(() => sendScenes());

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg) return;
    if (msg.type === "ready") {
      sendConfig();
      sendScenes();
    } else if (msg.type === "camera" && typeof msg.fsPath === "string") {
      await context.workspaceState.update(camKey(msg.fsPath), msg.state);
    } else if (msg.type === "dropUri" && typeof msg.uri === "string") {
      try {
        const dropped = vscode.Uri.parse(msg.uri);
        const fsPath = dropped.fsPath;
        const name = path.basename(fsPath);
        panel.webview.postMessage({
          type: "scenes",
          scenes: [
            ...(await opts.initialScenes()),
            {
              name,
              uri: panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString(),
              fsPath,
              savedCamera: context.workspaceState.get(camKey(fsPath)),
            },
          ],
          active: panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString(),
        });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not open dropped file: ${e.message}`);
      }
    } else if (msg.type === "screenshot" && typeof msg.fsPath === "string") {
      try {
        const out = await writeScreenshot(msg.fsPath, msg.dataUrl);
        panel.webview.postMessage({ type: "screenshotResult", success: true, path: path.basename(out) });
        vscode.window.showInformationMessage(`Saved screenshot: ${path.basename(out)}`);
      } catch (e: any) {
        panel.webview.postMessage({ type: "screenshotResult", success: false, error: e.message });
      }
    }
  });

  panel.onDidDispose(() => {
    opts.watcher.dispose();
    cfgListener.dispose();
    themeListener.dispose();
  });
}

// ── Custom editor (single file) ───────────────────────────────────
class GlbEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel) {
    const fileUri = document.uri;
    const folderUri = vscode.Uri.file(path.dirname(fileUri.fsPath));

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        folderUri,
      ],
    };

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folderUri, path.basename(fileUri.fsPath))
    );

    setupPanel(this.context, panel, {
      initialScenes: async () => [
        {
          name: path.basename(fileUri.fsPath),
          uri: panel.webview.asWebviewUri(fileUri).toString(),
          fsPath: fileUri.fsPath,
          savedCamera: this.context.workspaceState.get(camKey(fileUri.fsPath)),
        },
      ],
      activeUri: () => panel.webview.asWebviewUri(fileUri).toString(),
      watcher,
    });
  }
}

// ── Workspace viewer ──────────────────────────────────────────────
function openWorkspaceViewer(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showWarningMessage("Open a folder first.");
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "liveGlb.workspaceViewer",
    "Live GLB Viewer",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "out"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
        ...folders.map((f) => f.uri),
      ],
    }
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.glb");

  setupPanel(context, panel, {
    initialScenes: async () => {
      const cfg = getConfig();
      const exclude = cfg.excludeGlobs.length ? `{${cfg.excludeGlobs.join(",")}}` : undefined;
      const found = await vscode.workspace.findFiles("**/*.glb", exclude);
      return found
        .map((uri) => ({
          name: vscode.workspace.asRelativePath(uri),
          uri: panel.webview.asWebviewUri(uri).toString(),
          fsPath: uri.fsPath,
          savedCamera: context.workspaceState.get(camKey(uri.fsPath)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    watcher,
  });
}

// ── Webview HTML shell ────────────────────────────────────────────
function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const webviewJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "webview.js"));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${webview.cspSource} blob: data:`,
    `worker-src blob:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Live GLB Viewer</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1a1a2e);
    --fg: var(--vscode-foreground, #ccc);
    --panel: var(--vscode-editorWidget-background, rgba(0,0,0,0.6));
    --border: var(--vscode-widget-border, #555);
    --accent: var(--vscode-textLink-foreground, #4ec9b0);
  }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg); }
  canvas { display: block; }
  #toolbar {
    position: fixed; top: 8px; left: 8px; right: 8px;
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    font: 12px var(--vscode-font-family, monospace);
    pointer-events: none;
    z-index: 10;
  }
  #toolbar > * { pointer-events: auto; }
  #scene-select, button.tb {
    background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    padding: 4px 8px; border-radius: 4px; font: inherit;
    cursor: pointer;
  }
  button.tb:hover, #scene-select:hover { border-color: var(--accent); }
  button.tb.active { color: var(--accent); border-color: var(--accent); }
  #status {
    background: var(--panel); padding: 4px 8px; border-radius: 4px;
    margin-left: auto;
  }
  #status.flash { color: var(--accent); }
  #spinner {
    position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.3); z-index: 5;
  }
  #spinner.show { display: flex; }
  #spinner div {
    width: 36px; height: 36px;
    border: 3px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #stats-mount { position: fixed; top: 40px; right: 8px; z-index: 10; }
  #stats-mount canvas { display: block; }
  #drop-overlay {
    position: fixed; inset: 0; display: none; pointer-events: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,0.5); z-index: 20;
    font: 14px var(--vscode-font-family, monospace); color: var(--fg);
  }
  #drop-overlay.show { display: flex; }
</style>
</head>
<body>
<div id="toolbar">
  <select id="scene-select" title="Active scene"></select>
  <button class="tb" id="btn-reset" title="Reset camera (R)">⟲</button>
  <button class="tb" id="btn-grid" title="Toggle grid (G)">grid</button>
  <button class="tb" id="btn-axes" title="Toggle axes (X)">axes</button>
  <button class="tb" id="btn-wire" title="Toggle wireframe (W)">wire</button>
  <button class="tb" id="btn-stats" title="Toggle stats (F)">stats</button>
  <button class="tb" id="btn-pause" title="Pause animations (A)">▶ anim</button>
  <button class="tb" id="btn-shot" title="Save screenshot (S)">📸</button>
  <div id="status">waiting…</div>
</div>
<div id="spinner"><div></div></div>
<div id="stats-mount"></div>
<div id="drop-overlay">drop .glb to load</div>
<script type="module" nonce="${nonce}" src="${webviewJs}"></script>
</body>
</html>`;
}
