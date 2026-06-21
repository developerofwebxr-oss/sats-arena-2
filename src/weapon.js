import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import gunModelUrl from './assets/sats-arena-better-gun.glb?url';

/**
 * weapon.js — the Bitcoin-themed first-person blaster(s), loaded from a GLB.
 *
 * Flat / mobile : ONE gun, child of the camera, parked bottom-center-right.
 * VR / AR headset: DUAL WIELD — one gun on EACH tracked controller, so both hands
 *                  can shoot. Each gun has its own muzzle flash + lights and fires
 *                  independently (left trigger → left gun, right trigger → right).
 * Handheld phone AR: no gun (no hand to hold it), unchanged.
 *
 * The GLB is loaded ONCE and cloned into each gun. All shoot/hit/scoring logic is
 * untouched — this module only owns the gun visuals + per-gun muzzle flash.
 *
 * Public API:
 *   setupWeapon(camera, renderer) →
 *     { updateWeapon(delta), flashMuzzle(), flashController(index), setHidden() }
 *   - flashMuzzle()        flashes the camera gun (onFire for flat/mobile shots)
 *   - flashController(i)   flashes controller i's gun (called by xr.js per trigger)
 */

// Muzzle flash fades from full to zero over this many seconds.
const FLASH_DURATION = 0.12;

// ── Whole-weapon placement ───────────────────────────────────────────────────
// These position/scale each gun's GROUP; the model sits inside it at MODEL_POS.

// Camera gun (flat view). Mobile uses a SMALLER x offset: a narrow portrait aspect
// has a tight horizontal FOV, so the desktop x (0.22) shoves the gun against the
// right edge. Pulling x in brings it more into view on phones.
const CAMERA_POS        = new THREE.Vector3(0.22, -0.20, -0.55);
const CAMERA_POS_MOBILE = new THREE.Vector3(0.10, -0.20, -0.55); // pulled left for phones
const CAMERA_EULER = new THREE.Euler(0.05, -0.08, 0); // slight inward tilt
const CAMERA_SCALE = 1.0;

// Coarse pointer or a small min-dimension → treat as a phone for gun placement.
// TEMP debug override (?gunmobile=1 / ?gundesktop=1) lets us verify each
// placement on desktop; removed with the [gun] diagnostics before promotion.
function isMobileView() {
  const q = new URLSearchParams(window.location.search);
  if (q.get('gunmobile') === '1') return true;
  if (q.get('gundesktop') === '1') return false;
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
         Math.min(window.innerWidth, window.innerHeight) < 600;
}

// Controller guns (VR / AR headset). Centred on the controller, pointing −Z.
const VR_POS   = new THREE.Vector3(0, -0.02, -0.05);
const VR_EULER = new THREE.Euler(0, 0, 0);
const VR_SCALE = 0.7;

// Mirror the LEFT-hand gun (negative model X) so it isn't a "backwards" copy of
// the right-hand gun. Flip this if the left gun looks wrong on-device. Three
// handles the negative-determinant winding/normals, so lighting stays correct.
const MIRROR_LEFT = true;

// ── GLB model fit (TUNE THESE on-device) ─────────────────────────────────────
// Correct the imported model's own size / origin / orientation so it sits like a
// held gun (barrel pointing forward along −Z). Raw model is 1.152 × 0.571 × 0.204 m;
// long axis is X, so rotate 90° about Y to face −Z; vertical center ≈ 0.285 so it
// sits LOW within the group (rising from the bottom edge).
const MODEL_SCALE = 0.50;
const MODEL_POS   = new THREE.Vector3(0, -0.26, 0);
const MODEL_EULER = new THREE.Euler(0, Math.PI / 2, 0);

// Muzzle-flash placement at the barrel tip + its size. Tune to the model's muzzle.
const FLASH_POS  = new THREE.Vector3(0, -0.10, -0.36);
const FLASH_SIZE = 0.62;

// Per-gun lighting (rides with each gun; lights it in flat/VR/AR). Warm key + cool
// fill so the Bitcoin gold/details read crisply against the near-black scene.
const KEY_INTENSITY  = 8;
const FILL_INTENSITY = 4;
const LIGHT_DISTANCE = 2; // metres — kept local so it doesn't wash the scene

// One shared loader for the whole app. The GLB is Draco-compressed, so a
// DRACOLoader is required to decode its geometry. The decoder is self-hosted in
// public/draco/ (no CDN dependency); served at the build's base path via BASE_URL.
const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
gltfLoader.setDRACOLoader(dracoLoader);

export function setupWeapon(camera, renderer) {
  // One muzzle-flash texture, shared by every gun's sprite.
  const muzzleTexture = createMuzzleTexture();

  // ── A self-contained gun: group + muzzle flash + lights + (async) model ──────
  function buildGunUnit() {
    const group = new THREE.Group();

    // Muzzle flash — OWN SpriteMaterial so each gun flashes independently
    // (opacity/rotation live on the material). A Sprite always faces the camera,
    // so the bang reads identically in flat, mobile, VR, and AR.
    const flashMat = new THREE.SpriteMaterial({
      map: muzzleTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false, // always draw on top of the barrel
    });
    const flash = new THREE.Sprite(flashMat);
    flash.position.copy(FLASH_POS);
    flash.scale.set(FLASH_SIZE, FLASH_SIZE, 1);
    flash.frustumCulled = false;
    flash.visible = false;
    group.add(flash);

    // Dedicated lights.
    const gunKey = new THREE.PointLight(0xfff2dd, KEY_INTENSITY, LIGHT_DISTANCE, 2);
    gunKey.position.set(0.25, 0.35, 0.2);
    const gunFill = new THREE.PointLight(0x9fd8ff, FILL_INTENSITY, LIGHT_DISTANCE, 2);
    gunFill.position.set(-0.3, 0.0, 0.3);
    group.add(gunKey, gunFill);

    let model = null;
    let mirror = false;
    let flashAge = FLASH_DURATION;

    function applyTransform() {
      if (!model) return;
      model.position.copy(MODEL_POS);
      model.rotation.copy(MODEL_EULER);
      // Negative X mirrors the gun left↔right for the left hand.
      model.scale.set(mirror ? -MODEL_SCALE : MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    }
    function setModel(m) {
      model = m;
      model.traverse((o) => {
        if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; }
      });
      applyTransform();
      group.add(model);
    }
    function setMirror(b) { mirror = b; applyTransform(); }

    /** Fire this gun's muzzle flash (with rotation + size jitter). */
    function flashMuzzle() {
      flashAge = 0;
      flash.visible = true;
      flashMat.opacity = 1;
      flashMat.rotation = Math.random() * Math.PI * 2;
      const j = FLASH_SIZE * (0.85 + Math.random() * 0.4);
      flash.scale.set(j, j, 1);
    }
    /** Fade this gun's flash out. */
    function updateFlash(delta) {
      if (!flash.visible) return;
      flashAge += delta;
      if (flashAge >= FLASH_DURATION) { flash.visible = false; flashMat.opacity = 0; }
      else flashMat.opacity = 1 - flashAge / FLASH_DURATION;
    }

    return { group, setModel, setMirror, flashMuzzle, updateFlash };
  }

  // One camera gun (flat/mobile) + two controller guns (VR/AR headset).
  const cameraGun = buildGunUnit();
  const controllerGuns = [buildGunUnit(), buildGunUnit()];

  // ── Load the GLB once, clone into every gun ──────────────────────────────────
  console.log('[gun] loading GLB from', gunModelUrl);
  gltfLoader.load(
    gunModelUrl,
    (gltf) => {
      // Diagnostics on the original (pre-scale) model.
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      let meshCount = 0; const mats = new Set();
      gltf.scene.traverse((o) => {
        if (o.isMesh) { meshCount++; const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => x && mats.add(x.type)); }
      });
      console.log('[gun] LOADED ✓ ' + JSON.stringify({
        rawSize: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
        center: [+center.x.toFixed(3), +center.y.toFixed(3), +center.z.toFixed(3)],
        meshCount, materials: [...mats], willScaleBy: MODEL_SCALE,
      }));

      // Camera gun gets the original; each controller gun gets a clone (clones
      // share geometry/materials by reference — cheap, and we never mutate them).
      cameraGun.setModel(gltf.scene);
      controllerGuns.forEach((g) => g.setModel(gltf.scene.clone(true)));
      console.log('[gun] models attached: camera + 2 controllers');
    },
    (p) => { if (p.total) console.log(`[gun] loading ${Math.round((p.loaded / p.total) * 100)}%`); },
    (err) => console.error('[gun] LOAD FAILED ✗', err),
  );

  // ── Camera gun: child of the camera (flat/mobile) ─────────────────────────────
  camera.add(cameraGun.group);
  cameraGun.group.position.copy(isMobileView() ? CAMERA_POS_MOBILE : CAMERA_POS);
  cameraGun.group.rotation.copy(CAMERA_EULER);
  cameraGun.group.scale.setScalar(CAMERA_SCALE);

  // ── Controller guns: child of each controller, hidden until it connects ───────
  controllerGuns.forEach((g, i) => {
    const c = renderer.xr.getController(i);
    c.add(g.group);
    g.group.position.copy(VR_POS);
    g.group.rotation.copy(VR_EULER);
    g.group.scale.setScalar(VR_SCALE);
    g.group.visible = false;
  });

  // ── Visibility state ─────────────────────────────────────────────────────────
  // Camera gun shows only when NOT in an immersive session AND not explicitly
  // hidden. (armode calls setHidden(false) on VR start, so we can't let that
  // re-show the camera gun — the inImmersive flag gates it.)
  let inImmersive = false;
  let cameraHidden = false;
  function refreshCameraGun() { cameraGun.group.visible = !inImmersive && !cameraHidden; }

  renderer.xr.addEventListener('sessionstart', () => { inImmersive = true; refreshCameraGun(); });
  renderer.xr.addEventListener('sessionend', () => {
    inImmersive = false;
    cameraHidden = false;
    controllerGuns.forEach((g) => { g.group.visible = false; });
    refreshCameraGun();
  });

  // Show a controller gun only for a TRACKED controller (not a phone 'screen'
  // source), and mirror it if it's the left hand.
  [0, 1].forEach((i) => {
    const c = renderer.xr.getController(i);
    c.addEventListener('connected', (e) => {
      const src = e.data;
      if (!src || src.targetRayMode !== 'tracked-pointer') return; // phone AR → no controller gun
      controllerGuns[i].setMirror(MIRROR_LEFT && src.handedness === 'left');
      controllerGuns[i].group.visible = true;
    });
    c.addEventListener('disconnected', () => { controllerGuns[i].group.visible = false; });
  });

  // ── Public API ────────────────────────────────────────────────────────────────
  function updateWeapon(delta) {
    cameraGun.updateFlash(delta);
    controllerGuns.forEach((g) => g.updateFlash(delta));
  }
  /** Flash the camera gun — the onFire callback for flat/mobile shots. */
  function flashMuzzle() { cameraGun.flashMuzzle(); }
  /** Flash controller i's gun — called by xr.js when that trigger fires. */
  function flashController(i) { if (controllerGuns[i]) controllerGuns[i].flashMuzzle(); }
  /** Hide/show the camera gun (phone AR). VR hiding is handled by the session flag. */
  function setHidden(hidden) { cameraHidden = hidden; refreshCameraGun(); }

  return { updateWeapon, flashMuzzle, flashController, setHidden };
}

// ── Muzzle-flash burst texture (drawn once, shared) ──────────────────────────────
// A jagged, irregular star-burst on a transparent background: a soft radial glow,
// an uneven multi-spike polygon (random spike lengths → not a clean star), and a
// hot white core. Gold/orange to match the neon/Bitcoin look. Additive blending
// on the sprite turns this into a glowing "bang".
function createMuzzleTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S / 2, cy = S / 2;
  ctx.clearRect(0, 0, S, S);

  // Soft outer glow.
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, S / 2);
  glow.addColorStop(0, 'rgba(255,240,200,0.9)');
  glow.addColorStop(0.3, 'rgba(247,147,26,0.7)');
  glow.addColorStop(0.7, 'rgba(247,147,26,0.18)');
  glow.addColorStop(1, 'rgba(247,147,26,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, S / 2, 0, Math.PI * 2);
  ctx.fill();

  // Irregular spiky burst — alternating long/short points with random jitter.
  const spikes = 13;
  const outer = S * 0.48;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (i / (spikes * 2)) * Math.PI * 2;
    const isOuter = i % 2 === 0;
    const r = isOuter
      ? outer * (0.6 + Math.random() * 0.4)   // long spikes, uneven
      : S * (0.1 + Math.random() * 0.08);      // short inner notches
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  fill.addColorStop(0, 'rgba(255,255,255,1)');
  fill.addColorStop(0.35, 'rgba(255,205,100,0.98)');
  fill.addColorStop(1, 'rgba(247,147,26,0.6)'); // brighter tips so spikes read
  ctx.fillStyle = fill;
  ctx.fill();

  // Hot white core — kept small so the spiky shape dominates, not a white blob.
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
