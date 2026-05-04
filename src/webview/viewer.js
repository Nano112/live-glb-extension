import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import Stats from "three/addons/libs/stats.module.js";

const vscode = acquireVsCodeApi();

// ── Config (pushed by extension) ──────────────────────────────────
let config = {
  backgroundColor: "",
  gridEnabled: true,
  gridSize: 20,
  axesEnabled: false,
  statsEnabled: false,
  tickMs: 50,
  autoFrameOnReload: false,
  excludeGlobs: [],
};

// ── Scene setup ───────────────────────────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(4, 4, 4);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.5, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 10, 5);
scene.add(dir);

let grid = null;
let axes = null;
function rebuildGrid() {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
  if (config.gridEnabled) {
    grid = new THREE.GridHelper(config.gridSize, config.gridSize, 0x444466, 0x333355);
    scene.add(grid);
  }
}
function rebuildAxes() {
  if (axes) { scene.remove(axes); axes.geometry.dispose(); axes.material.dispose(); axes = null; }
  if (config.axesEnabled) {
    axes = new THREE.AxesHelper(2);
    scene.add(axes);
  }
}

// ── Stats ─────────────────────────────────────────────────────────
const stats = new Stats();
stats.dom.style.position = "static";
const statsMount = document.getElementById("stats-mount");
function applyStats() {
  if (config.statsEnabled) statsMount.appendChild(stats.dom);
  else if (stats.dom.parentNode) stats.dom.parentNode.removeChild(stats.dom);
  setActive("btn-stats", config.statsEnabled);
}

// ── Theme bg ──────────────────────────────────────────────────────
function applyBackground() {
  let color = config.backgroundColor;
  if (!color) {
    const cs = getComputedStyle(document.body).backgroundColor;
    color = cs || "#1a1a2e";
  }
  try { scene.background = new THREE.Color(color); } catch { scene.background = new THREE.Color("#1a1a2e"); }
}

// ── State ─────────────────────────────────────────────────────────
let currentModel = null;
let currentUri = null;
let currentFsPath = null;
let resetCameraNext = true;
let animationState = null;
let animationsPaused = false;
let wireframeOn = false;
const sceneMeta = new Map(); // uri -> {fsPath, savedCamera}
const loader = new GLTFLoader();

const $ = (id) => document.getElementById(id);
const status = $("status");
const select = $("scene-select");
const spinner = $("spinner");
const dropOverlay = $("drop-overlay");

function setActive(id, on) { $(id).classList.toggle("active", !!on); }
function flash(text) {
  status.textContent = text;
  status.classList.add("flash");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => status.classList.remove("flash"), 800);
}

// ── Toolbar ───────────────────────────────────────────────────────
select.addEventListener("change", () => {
  resetCameraNext = config.autoFrameOnReload;
  animationState = null;
  loadGLB(select.value);
});
$("btn-reset").onclick = () => { if (currentModel) frameCameraOnModel(currentModel); };
$("btn-grid").onclick = () => { config.gridEnabled = !config.gridEnabled; rebuildGrid(); setActive("btn-grid", config.gridEnabled); };
$("btn-axes").onclick = () => { config.axesEnabled = !config.axesEnabled; rebuildAxes(); setActive("btn-axes", config.axesEnabled); };
$("btn-wire").onclick = () => toggleWireframe();
$("btn-stats").onclick = () => { config.statsEnabled = !config.statsEnabled; applyStats(); };
$("btn-pause").onclick = () => togglePause();
$("btn-shot").onclick = () => takeScreenshot();

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  switch (e.key.toLowerCase()) {
    case "r": $("btn-reset").click(); break;
    case "g": $("btn-grid").click(); break;
    case "x": $("btn-axes").click(); break;
    case "w": $("btn-wire").click(); break;
    case "f": $("btn-stats").click(); break;
    case "a": togglePause(); break;
    case "s": takeScreenshot(); break;
  }
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── Drag-and-drop ─────────────────────────────────────────────────
// Use capture phase + stopPropagation so VSCode's host doesn't steal the drop.
function killEvt(e) { e.preventDefault(); e.stopPropagation(); }
document.addEventListener("dragenter", (e) => { killEvt(e); dropOverlay.classList.add("show"); }, true);
document.addEventListener("dragover", (e) => { killEvt(e); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; }, true);
document.addEventListener("dragleave", (e) => {
  if (e.target === document.documentElement || e.relatedTarget == null) dropOverlay.classList.remove("show");
}, true);
document.addEventListener("drop", async (e) => {
  killEvt(e);
  dropOverlay.classList.remove("show");

  // External file (Finder, etc.) — has a real File
  const file = e.dataTransfer?.files?.[0];
  if (file && file.name.toLowerCase().endsWith(".glb")) {
    spinner.classList.add("show");
    const buf = await file.arrayBuffer();
    loader.parse(buf, "", async (gltf) => {
      spinner.classList.remove("show");
      await applyLoadedGLTF(gltf, true);
      flash(`dropped: ${file.name}`);
      currentUri = null; currentFsPath = null;
    }, (err) => { spinner.classList.remove("show"); status.textContent = "drop error: " + err.message; });
    return;
  }

  // Internal drop from VSCode Explorer — only carries a uri-list
  const list =
    e.dataTransfer?.getData("application/vnd.code.uri-list") ||
    e.dataTransfer?.getData("text/uri-list") || "";
  const uri = list.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#") && l.toLowerCase().endsWith(".glb"));
  if (uri) vscode.postMessage({ type: "dropUri", uri });
}, true);

// ── Messages from extension ───────────────────────────────────────
addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "config") {
    config = { ...config, ...msg.config };
    applyBackground(); rebuildGrid(); rebuildAxes(); applyStats();
    setActive("btn-grid", config.gridEnabled);
    setActive("btn-axes", config.axesEnabled);
  } else if (msg.type === "scenes") {
    populateScenes(msg.scenes, msg.active);
  } else if (msg.type === "changed") {
    if (msg.uri === currentUri) loadGLB(currentUri);
  } else if (msg.type === "theme") {
    applyBackground();
  } else if (msg.type === "screenshotResult") {
    if (msg.success) flash(`saved ${msg.path}`);
    else status.textContent = "screenshot error: " + msg.error;
  }
});

function populateScenes(scenes, active) {
  sceneMeta.clear();
  for (const s of scenes) sceneMeta.set(s.uri, { fsPath: s.fsPath, savedCamera: s.savedCamera });

  const prev = select.value;
  select.innerHTML = "";
  for (const s of scenes) {
    const opt = document.createElement("option");
    opt.value = s.uri;
    opt.textContent = s.name.replace(/\.glb$/i, "");
    select.appendChild(opt);
  }

  const target = active ?? (scenes.find((s) => s.uri === prev)?.uri) ?? scenes[0]?.uri;
  if (target) {
    select.value = target;
    if (target !== currentUri) {
      resetCameraNext = config.autoFrameOnReload;
      loadGLB(target);
    }
  } else {
    status.textContent = "no .glb files in workspace";
  }
}

// ── Camera framing & persistence ──────────────────────────────────
function frameCameraOnModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  controls.target.copy(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  camera.position.copy(center).add(new THREE.Vector3(maxDim, maxDim, maxDim));
  controls.update();
}

function restoreCamera(state) {
  if (!state || !state.position || !state.target) return false;
  camera.position.fromArray(state.position);
  controls.target.fromArray(state.target);
  controls.update();
  return true;
}

let camSaveTimer = null;
controls.addEventListener("change", () => {
  if (!currentFsPath) return;
  clearTimeout(camSaveTimer);
  camSaveTimer = setTimeout(() => {
    vscode.postMessage({
      type: "camera",
      fsPath: currentFsPath,
      state: {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
      },
    });
  }, 400);
});

// ── Wireframe ─────────────────────────────────────────────────────
function toggleWireframe() {
  wireframeOn = !wireframeOn;
  setActive("btn-wire", wireframeOn);
  if (!currentModel) return;
  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) if (m) m.wireframe = wireframeOn;
  });
}

// ── Animations toggle ─────────────────────────────────────────────
function togglePause() {
  animationsPaused = !animationsPaused;
  $("btn-pause").textContent = animationsPaused ? "⏸ anim" : "▶ anim";
  setActive("btn-pause", animationsPaused);
  flash(animationsPaused ? "animations paused" : "animations resumed");
}

// ── Screenshot ────────────────────────────────────────────────────
function takeScreenshot() {
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  if (currentFsPath) {
    vscode.postMessage({ type: "screenshot", fsPath: currentFsPath, dataUrl });
  } else {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "screenshot.png";
    a.click();
    flash("downloaded screenshot");
  }
}

// ── Animated textures ─────────────────────────────────────────────
async function setupAnimations(gltf) {
  const sceneExtras = gltf.scene.userData?.animatedTextures
    ? gltf.scene.userData
    : gltf.parser?.json?.scenes?.[0]?.extras;
  if (!sceneExtras?.animatedTextures?.length) { animationState = null; return; }

  let atlasTexture = null;
  gltf.scene.traverse((child) => {
    if (child.isMesh && child.material && !atlasTexture) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) if (mat.map) { atlasTexture = mat.map; break; }
    }
  });
  if (!atlasTexture?.image) { animationState = null; return; }

  const animEntries = [];
  for (const entry of sceneExtras.animatedTextures) {
    try {
      const imageDef = gltf.parser.json.images[entry.imageIndex];
      const bufferView = await gltf.parser.getDependency("bufferView", imageDef.bufferView);
      const blob = new Blob([bufferView], { type: imageDef.mimeType });
      const url = URL.createObjectURL(blob);
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });
      URL.revokeObjectURL(url);

      const fw = entry.frameWidth, fh = entry.frameHeight;
      const fc = document.createElement("canvas");
      fc.width = fw; fc.height = fh;
      const fctx = fc.getContext("2d", { willReadFrequently: true });
      const frameTex = new THREE.DataTexture(
        new Uint8Array(fw * fh * 4), fw, fh, THREE.RGBAFormat, THREE.UnsignedByteType
      );
      frameTex.flipY = atlasTexture.flipY;
      frameTex.colorSpace = atlasTexture.colorSpace;
      frameTex.generateMipmaps = false;

      animEntries.push({
        ...entry, spriteSheet: img, frameCanvas: fc, frameCtx: fctx, frameTex,
        currentFrame: 0, tickCounter: 0, orderIndex: 0,
      });
    } catch (e) { console.warn("[anim] sprite sheet load failed", entry.imageIndex, e); }
  }
  if (animEntries.length === 0) { animationState = null; return; }

  animationState = { atlasTexture, entries: animEntries, lastTime: performance.now(), tickAccum: 0 };
}

function updateAnimations(now) {
  if (!animationState || animationsPaused) return;
  const tickMs = config.tickMs || 50;
  const { atlasTexture, entries } = animationState;
  const dt = now - animationState.lastTime;
  animationState.lastTime = now;
  animationState.tickAccum += dt;
  if (animationState.tickAccum < tickMs) return;
  const ticksElapsed = Math.floor(animationState.tickAccum / tickMs);
  animationState.tickAccum %= tickMs;

  for (const entry of entries) {
    const frameTicks = entry.frametime || 1;
    entry.tickCounter += ticksElapsed;
    if (entry.tickCounter < frameTicks) continue;
    const framesAdvanced = Math.floor(entry.tickCounter / frameTicks);
    entry.tickCounter %= frameTicks;
    const oldFrame = entry.currentFrame;
    let newFrame;
    if (entry.frames) {
      entry.orderIndex = (entry.orderIndex + framesAdvanced) % entry.frames.length;
      newFrame = entry.frames[entry.orderIndex];
    } else {
      newFrame = (oldFrame + framesAdvanced) % entry.frameCount;
    }
    if (newFrame === oldFrame) continue;
    entry.currentFrame = newFrame;
    const fw = entry.frameWidth, fh = entry.frameHeight;
    entry.frameCtx.clearRect(0, 0, fw, fh);
    entry.frameCtx.drawImage(entry.spriteSheet, 0, newFrame * fh, fw, fh, 0, 0, fw, fh);
    const pixels = entry.frameCtx.getImageData(0, 0, fw, fh).data;
    entry.frameTex.image.data.set(new Uint8Array(pixels.buffer));
    entry.frameTex.needsUpdate = true;
    renderer.copyTextureToTexture(entry.frameTex, atlasTexture, null, new THREE.Vector2(entry.atlasX, entry.atlasY));
  }
}

// ── Loading ───────────────────────────────────────────────────────
async function applyLoadedGLTF(gltf, doFrame) {
  if (currentModel) scene.remove(currentModel);
  currentModel = gltf.scene;
  scene.add(currentModel);
  if (wireframeOn) {
    currentModel.traverse((c) => {
      if (!c.isMesh) return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) if (m) m.wireframe = true;
    });
  }
  if (doFrame) frameCameraOnModel(currentModel);
  await setupAnimations(gltf);
  const animCount = animationState?.entries.length || 0;
  const animLabel = animCount > 0 ? ` (${animCount} animated)` : "";
  flash("loaded " + new Date().toLocaleTimeString() + animLabel);
}

function loadGLB(uri) {
  currentUri = uri;
  const meta = sceneMeta.get(uri);
  currentFsPath = meta?.fsPath ?? null;
  const cacheBust = uri + (uri.includes("?") ? "&" : "?") + "t=" + Date.now();
  spinner.classList.add("show");
  loader.load(
    cacheBust,
    async (gltf) => {
      spinner.classList.remove("show");
      let framed = false;
      if (resetCameraNext) {
        await applyLoadedGLTF(gltf, true);
        resetCameraNext = false;
        framed = true;
      } else if (meta?.savedCamera) {
        await applyLoadedGLTF(gltf, false);
        framed = restoreCamera(meta.savedCamera);
        if (!framed) frameCameraOnModel(currentModel);
      } else {
        await applyLoadedGLTF(gltf, true);
      }
    },
    undefined,
    (err) => {
      spinner.classList.remove("show");
      status.textContent = "error: " + err.message;
    }
  );
}

// ── Render loop ───────────────────────────────────────────────────
function animate(now) {
  requestAnimationFrame(animate);
  if (config.statsEnabled) stats.begin();
  updateAnimations(now || performance.now());
  controls.update();
  renderer.render(scene, camera);
  if (config.statsEnabled) stats.end();
}
applyBackground();
rebuildGrid();
rebuildAxes();
animate();
vscode.postMessage({ type: "ready" });
