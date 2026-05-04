const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const extension = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
};

const webview = {
  ...common,
  entryPoints: ["src/webview/viewer.js"],
  outfile: "out/webview.js",
  format: "esm",
  platform: "browser",
  target: "es2022",
};

(async () => {
  if (watch) {
    const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[esbuild] watching…");
  } else {
    await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
