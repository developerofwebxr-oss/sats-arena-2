import * as THREE from 'three';
import { isRapidFire } from './upgrade.js';

/**
 * targets.js — spawns and animates Bitcoin coin targets + the rare Satoshi target.
 *
 * Public API:
 *   spawnTargets(scene)          — call once at startup
 *   updateTargets(time)          — call every frame, pass elapsed seconds
 *   removeTarget(index)          — hide a hit coin, schedule respawn
 *   removeSpecial()              — hide a hit Satoshi target, schedule the next
 *   setSpawnMode(mode)           — switch spawn geometry (vr/quest-ar/handheld-ar)
 *   targetMeshes                 — array for raycasting in shoot.js (coins + special)
 *
 * The Satoshi target (userData.special) ONLY appears during the paid rapid-fire
 * window, intermittently and one at a time — the reason to pay.
 */

const MAX_TARGETS      = 12;
const RESPAWN_DELAY_MS = 800;

// ── Spawn modes ────────────────────────────────────────────────────────────────
// Distance (rMin/rMax) and height (hMin/hMax) are the SAME across every mode, so
// coins feel equally far in flat/SCREEN, VR, and AR. Modes differ ONLY in the
// horizontal ARC: VR and Quest-AR use the full 360°; handheld phone AR uses a
// forward-facing arc because you can't comfortably spin a phone around.
// angleCenter/angleSpread define the horizontal arc; angle 0 = straight ahead (−Z).
const SPAWN_MODES = {
  'vr':          { rMin: 3, rMax: 7, hMin: 1.0, hMax: 3.0, angleCenter: 0, angleSpread: Math.PI * 2 },
  'quest-ar':    { rMin: 3, rMax: 7, hMin: 1.0, hMax: 3.0, angleCenter: 0, angleSpread: Math.PI * 2 },
  'handheld-ar': { rMin: 3, rMax: 7, hMin: 1.0, hMax: 3.0, angleCenter: 0, angleSpread: (120 * Math.PI) / 180 },
};

// Active spawn config — defaults to VR. Switched at runtime by setSpawnMode().
let spawnCfg = SPAWN_MODES['vr'];

// All coins + the Satoshi target live under this group. In AR we move the group
// to follow the player each frame, so the swarm stays centred on them and doesn't
// recede as the AR reference-space origin drifts. In VR/flat the group stays at
// world origin (unchanged arena behaviour).
const targetGroup = new THREE.Group();
let arAnchored = false; // true in AR modes → group follows the player

// ── Coin geometry ──────────────────────────────────────────────────────────────
// CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)
// 0.28m radius, 0.06m thick — a chunky coin. 32 segments = smooth edge.
const COIN_GEO = new THREE.CylinderGeometry(0.28, 0.28, 0.06, 32);

// ── Coin texture — drawn once, shared across all coins ────────────────────────
// Using a plain <canvas> for maximum browser compatibility.
// OffscreenCanvas works too but isn't supported in all WebXR browsers (e.g. Wolvic).
function createCoinTexture() {
  const SIZE = 256; // texture resolution in pixels — enough for a crisp ₿
  const canvas = document.createElement('canvas');
  canvas.width  = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r  = SIZE / 2;

  // ── Background circle — Bitcoin orange ──────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f7931a';
  ctx.fill();

  // ── Inner accent ring — slightly lighter, gives coin depth ──────────────
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.88, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 6;
  ctx.stroke();

  // ── ₿ symbol — white, centred ───────────────────────────────────────────
  // Font size tuned so the symbol fills the coin face without clipping.
  ctx.fillStyle = 'white';
  ctx.font      = `bold ${Math.floor(SIZE * 0.58)}px serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  // The ₿ glyph has optical weight that sits slightly above centre — nudge down.
  ctx.fillText('₿', cx, cy + SIZE * 0.04);

  // Wrap in a Three.js texture. needsUpdate = true uploads the pixels to GPU.
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const COIN_TEXTURE = createCoinTexture();

// ── Materials ──────────────────────────────────────────────────────────────────
// CylinderGeometry has three material group indices:
//   0 = curved side (the rim/edge)
//   1 = top cap (front face)
//   2 = bottom cap (back face)
// We pass an array of three — same faceMat instance for both caps (zero extra memory).
const RIM_MAT  = new THREE.MeshBasicMaterial({ color: 0xc4660a }); // darker orange rim
const FACE_MAT = new THREE.MeshBasicMaterial({ map: COIN_TEXTURE, side: THREE.FrontSide });
const COIN_MATS = [RIM_MAT, FACE_MAT, FACE_MAT];

// ── Satoshi (special) texture + materials ──────────────────────────────────────
// Same canvas-texture technique as the coin, but a gold face, a thick magenta
// glow ring and a ★ — clearly distinct from the ₿, on-brand with the rapid-fire
// magenta. Drawn once, shared.
function createSatoshiTexture() {
  const SIZE = 256;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const cx = SIZE / 2, cy = SIZE / 2, r = SIZE / 2;

  // Gold radial face.
  const grad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
  grad.addColorStop(0, '#ffe680');
  grad.addColorStop(1, '#f7b500');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Thick magenta glow ring.
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
  ctx.strokeStyle = '#b14bff';
  ctx.lineWidth = 14;
  ctx.stroke();

  // ★ — white, centred.
  ctx.fillStyle = 'white';
  ctx.font = `bold ${Math.floor(SIZE * 0.55)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('★', cx, cy + SIZE * 0.02);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

const SATOSHI_TEXTURE = createSatoshiTexture();
const SPECIAL_RIM  = new THREE.MeshBasicMaterial({ color: 0xb14bff }); // magenta rim
const SPECIAL_FACE = new THREE.MeshBasicMaterial({ map: SATOSHI_TEXTURE, side: THREE.FrontSide });
const SPECIAL_MATS = [SPECIAL_RIM, SPECIAL_FACE, SPECIAL_FACE];

// ── Satoshi target lifecycle state ──────────────────────────────────────────────
const SPECIAL_LIFETIME = 3.5; // seconds visible before it flees
const SPECIAL_GAP      = 1.2; // seconds between appearances
let specialMesh    = null;    // the one special target (also pushed to targetMeshes)
let specialAnim    = null;    // bob params while visible
let specialNextAt  = 0;       // earliest time the next one may appear
let specialUntil   = 0;       // time the current one hides on its own
let lastTime       = 0;       // latest updateTargets time (used by removeSpecial)

// ── Target array (exported for raycasting in shoot.js) ────────────────────────
export const targetMeshes = [];

// Animation state — kept parallel to targetMeshes (same index).
const targetData = [];

// ── Helpers ────────────────────────────────────────────────────────────────────

function randomTargetPosition() {
  const cfg = spawnCfg;
  // angle 0 points straight ahead (−Z). Spread is centred on angleCenter.
  const angle  = cfg.angleCenter + (Math.random() - 0.5) * cfg.angleSpread;
  const radius = cfg.rMin + Math.random() * (cfg.rMax - cfg.rMin);
  return new THREE.Vector3(
    Math.sin(angle) * radius,                       // x
    cfg.hMin + Math.random() * (cfg.hMax - cfg.hMin), // y
    -Math.cos(angle) * radius,                      // z (negative = in front)
  );
}

function makeTargetData(mesh) {
  return {
    bobSpeed:  0.5 + Math.random() * 0.8,
    bobAmp:    0.15 + Math.random() * 0.2,
    bobOffset: Math.random() * Math.PI * 2,
    driftX:    (Math.random() - 0.5) * 0.004,
    driftZ:    (Math.random() - 0.5) * 0.004,
    baseY:     mesh.position.y,
    spinY:     (Math.random() - 0.5) * 0.02,   // slow wobble left or right
    spinZ:     0.006 + Math.random() * 0.016,   // forward spin, always positive, varied speed
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * spawnTargets(scene) — create all coin targets and add them to the scene.
 */
export function spawnTargets(scene) {
  scene.add(targetGroup); // coins live under this group so AR can follow the player

  for (let i = 0; i < MAX_TARGETS; i++) {
    const mesh = new THREE.Mesh(COIN_GEO, COIN_MATS);

    // Rotate so the flat coin face points forward (world -Z) instead of up.
    // CylinderGeometry's caps face ±Y by default; rotating 90° on X makes them face ±Z.
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.y = Math.random() * Math.PI * 2; // random initial facing
    mesh.rotation.z = Math.random() * Math.PI * 2; // random initial tilt

    mesh.position.copy(randomTargetPosition());
    targetGroup.add(mesh);
    targetMeshes.push(mesh);
    targetData.push(makeTargetData(mesh));
  }

  // The Satoshi target — last entry in targetMeshes (so raycasting includes it),
  // hidden by default, driven only by updateSpecial(). The normal loops below stay
  // bounded to MAX_TARGETS, so they never touch it.
  specialMesh = new THREE.Mesh(COIN_GEO, SPECIAL_MATS);
  specialMesh.rotation.x = Math.PI / 2;
  specialMesh.visible = false;
  specialMesh.userData.special = true;
  targetGroup.add(specialMesh);
  targetMeshes.push(specialMesh);
}

/**
 * setSpawnMode(mode) — switch spawn geometry ('vr' | 'quest-ar' | 'handheld-ar')
 * and immediately reposition all coins to fit the new mode.
 * Called by armode.js on AR session start/end.
 */
export function setSpawnMode(mode) {
  spawnCfg = SPAWN_MODES[mode] || SPAWN_MODES['vr'];
  // AR modes follow the player (drift-proof); VR/flat stay at world origin.
  arAnchored = (mode === 'quest-ar' || mode === 'handheld-ar');
  // Reposition every COIN (not the special — it's managed separately and stays
  // hidden outside rapid-fire) so none are stranded in the old layout.
  for (let i = 0; i < MAX_TARGETS; i++) {
    const mesh = targetMeshes[i];
    mesh.position.copy(randomTargetPosition());
    targetData[i] = makeTargetData(mesh);
    mesh.visible = true;
  }
}

/**
 * removeTarget(index) — hide a hit coin and respawn at a new position.
 */
export function removeTarget(index) {
  const mesh = targetMeshes[index];
  mesh.visible = false;

  setTimeout(() => {
    mesh.position.copy(randomTargetPosition());
    targetData[index] = makeTargetData(mesh);
    mesh.visible = true;
  }, RESPAWN_DELAY_MS);
}

/**
 * removeSpecial() — hide a hit Satoshi target and schedule the next one (still
 * gated by rapid-fire in updateSpecial). Called by shoot.js on a special hit.
 */
export function removeSpecial() {
  if (specialMesh) specialMesh.visible = false;
  specialNextAt = lastTime + SPECIAL_GAP;
}

// Drive the Satoshi target: only during rapid-fire, intermittently, one at a time.
function updateSpecial(time) {
  lastTime = time;
  if (!specialMesh) return;

  if (!isRapidFire()) {
    if (specialMesh.visible) specialMesh.visible = false;
    return;
  }

  if (specialMesh.visible) {
    // Animate while up; retire it after its lifetime so it feels fleeting.
    const a = specialAnim;
    specialMesh.position.y = a.baseY + Math.sin(time * a.bobSpeed + a.bobOffset) * a.bobAmp;
    specialMesh.rotation.z += 0.02; // a touch faster than coins, to stand out
    specialMesh.rotation.y += 0.01;
    if (time > specialUntil) {
      specialMesh.visible = false;
      specialNextAt = time + SPECIAL_GAP;
    }
  } else if (time >= specialNextAt) {
    // Pop it up at a fresh position for a short window.
    specialMesh.position.copy(randomTargetPosition());
    specialAnim = makeTargetData(specialMesh);
    specialMesh.rotation.z = Math.random() * Math.PI * 2;
    specialMesh.visible = true;
    specialUntil = time + SPECIAL_LIFETIME;
  }
}

/**
 * updateTargets(time, playerPos) — animate visible coins (and the Satoshi target).
 * time = elapsed seconds. playerPos = the player's world position (THREE.Vector3);
 * in AR the coin group follows it (XZ) so the swarm stays centred on the player
 * and immune to AR origin drift. In VR/flat the group stays at world origin.
 */
export function updateTargets(time, playerPos) {
  if (arAnchored && playerPos) {
    targetGroup.position.set(playerPos.x, 0, playerPos.z);
  } else if (targetGroup.position.lengthSq() !== 0) {
    targetGroup.position.set(0, 0, 0); // reset for VR/flat (e.g. after leaving AR)
  }

  // Coins only — the special is index MAX_TARGETS, handled by updateSpecial().
  for (let i = 0; i < MAX_TARGETS; i++) {
    const mesh = targetMeshes[i];
    if (!mesh.visible) continue;

    const data = targetData[i];

    // Vertical bob.
    mesh.position.y = data.baseY + Math.sin(time * data.bobSpeed + data.bobOffset) * data.bobAmp;

    // Slow horizontal drift with arena boundary bounce.
    mesh.position.x += data.driftX;
    mesh.position.z += data.driftZ;
    const dist = Math.sqrt(mesh.position.x ** 2 + mesh.position.z ** 2);
    if (dist > spawnCfg.rMax) {
      data.driftX *= -1;
      data.driftZ *= -1;
    }

    // Each coin has its own spin speeds so they all look distinct.
    mesh.rotation.z += data.spinZ;
    mesh.rotation.y += data.spinY;
  }

  updateSpecial(time);
}
