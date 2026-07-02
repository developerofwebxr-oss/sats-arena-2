import * as THREE from 'three';
import { isRapidFire, getRemainingSeconds } from './upgrade.js';
import { getAvailableCharges, activateCharge } from './hud.js';
import { getScore } from './score.js';

/**
 * vrui.js — in-world HUD for immersive VR/AR (where DOM isn't visible):
 *   - ACTIVATE panel (point a controller + trigger to spend a banked charge)
 *   - SCORE (always shown in-session)
 *   - COUNTDOWN (shown during rapid-fire)
 *
 * Performance: text is canvas-texture, repainted ONLY when its value changes
 * (redraw-on-change) — never per frame. Per-frame work is just head-lock matrix
 * math. Each element is one draw call. Flat/handheld keep the DOM HUD; these gate
 * on renderer.xr.isPresenting.
 */

// ── Tunable HUD placement (metres from the head; -Z is forward) ───────────────
// Adjust these on-device. Keep SCORE/COUNTDOWN clear of the centre aim zone and
// the lower-front ACTIVATE panel.
const PANEL_OFFSET = new THREE.Vector3(0,  -0.50, -2.0); // ACTIVATE panel (lower-front)
const SCORE_OFFSET = new THREE.Vector3(0,   0.55, -2.0); // SCORE (upper-front)
const TIMER_OFFSET = new THREE.Vector3(0,   0.38, -2.0); // COUNTDOWN (just below score)
const SCORE_WIDTH  = 0.60; // metres wide
const TIMER_WIDTH  = 0.46;

// Gaze crosshair for WebXR VR (phone/Cardboard). Attached as a CAMERA CHILD (like
// the gun, which is confirmed to render in both eyes) so it reliably appears in
// the stereo view, dead-centre, aiming with head/device movement.
const RETICLE_POS   = new THREE.Vector3(0, 0, -2.0); // centre of view, 2m ahead
const RETICLE_WIDTH = 0.16; // metres at that distance

export function setupVrUI(scene, camera, renderer) {
  // ── ACTIVATE panel ──────────────────────────────────────────────────────
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.45),
    new THREE.MeshBasicMaterial({ map: makePanelTexture(), transparent: true, side: THREE.DoubleSide }),
  );
  panel.visible = false;
  scene.add(panel);

  // ── SCORE + COUNTDOWN text sprites (repaint-on-change) ──────────────────────
  const scoreSprite = createTextSprite(SCORE_WIDTH, '#f7931a'); // orange
  const timerSprite = createTextSprite(TIMER_WIDTH, '#b14bff'); // magenta
  scoreSprite.mesh.visible = false;
  timerSprite.mesh.visible = false;
  scene.add(scoreSprite.mesh, timerSprite.mesh);

  // ── Gaze crosshair — CAMERA CHILD so it renders in both stereo eyes ──────────
  // Additive cyan reticle, drawn on top (depthTest off) so it's always visible.
  const reticle = new THREE.Mesh(
    new THREE.PlaneGeometry(RETICLE_WIDTH, RETICLE_WIDTH),
    new THREE.MeshBasicMaterial({
      map: makeReticleTexture(),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  reticle.position.copy(RETICLE_POS);
  reticle.renderOrder = 999; // draw last so it sits over coins
  reticle.visible = false;
  camera.add(reticle);

  const raycaster = new THREE.Raycaster();
  const _camPos  = new THREE.Vector3();
  const _camQuat = new THREE.Quaternion();
  const _offset  = new THREE.Vector3();

  // Place a mesh in front of the current head pose, facing the player.
  function headLock(mesh, offset) {
    _offset.copy(offset).applyQuaternion(_camQuat);
    mesh.position.copy(_camPos).add(_offset);
    mesh.quaternion.copy(_camQuat);
  }

  function updateVrUI() {
    const presenting = renderer.xr.isPresenting;

    // Flat/handheld → DOM HUD handles it; hide all in-world UI.
    if (!presenting) {
      panel.visible = false;
      scoreSprite.mesh.visible = false;
      timerSprite.mesh.visible = false;
      reticle.visible = false;
      return;
    }

    const rapid = isRapidFire();

    // Visibility.
    panel.visible = !rapid && getAvailableCharges() > 0;
    scoreSprite.mesh.visible = true;     // always in-session
    timerSprite.mesh.visible = rapid;    // only during rapid-fire

    // ── Gaze crosshair (WebXR VR only; hidden in AR passthrough) ────────────────
    // Shown in any immersive VR (opaque) session — covers the Android phone/
    // Cardboard stereo view. (Quest is opaque too, so it shows there as well.)
    const session = renderer.xr.getSession();
    const blend   = session && session.environmentBlendMode;
    const isAR    = !!(blend && blend !== 'opaque');
    reticle.visible = !isAR;

    // Text — repaint only when the value changes (cheap; protects 72fps).
    scoreSprite.setText(`SCORE ${getScore()}`);
    if (rapid) {
      const secs = getRemainingSeconds();
      timerSprite.setText(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    }

    // Head-lock whatever's visible (one cam-pose read per frame).
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(_camPos);
    cam.getWorldQuaternion(_camQuat);
    // Reticle + debug are CAMERA CHILDREN — they track the head automatically, no
    // head-lock math needed. (panel/score/timer remain scene objects, head-locked.)
    if (panel.visible)            headLock(panel, PANEL_OFFSET);
    headLock(scoreSprite.mesh, SCORE_OFFSET);
    if (timerSprite.mesh.visible) headLock(timerSprite.mesh, TIMER_OFFSET);
  }

  function handleControllerSelect(origin, direction) {
    if (!panel.visible) return false;
    raycaster.set(origin, direction);
    if (raycaster.intersectObject(panel, false).length > 0) {
      activateCharge();
      return true; // consumed the trigger → no shot
    }
    return false;
  }

  return { updateVrUI, handleControllerSelect };
}

// ── Text sprite: a small head-lockable plane whose canvas is repainted only when
// its text changes. setText() is a no-op when the string is unchanged. ──────────
function createTextSprite(worldWidth, color) {
  // 512×256 keeps the same 2:1 aspect (plane size unchanged) but gives more pixels.
  const W = 512, H = 256;
  const BASE_FONT = 120; // px; shrunk per-draw if the text is too wide to fit
  const MAX_W = W * 0.9; // leave a small margin so glyphs never touch the edge

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldWidth, worldWidth * (H / W)),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );

  let last = null;
  function setText(str) {
    if (str === last) return; // redraw-on-change only
    last = str;
    ctx.clearRect(0, 0, W, H);

    // Auto-fit: start at BASE_FONT, shrink if the text would overflow the width
    // (so long scores like "SCORE 9999" stay fully visible and centred).
    let fontPx = BASE_FONT;
    ctx.font = `bold ${fontPx}px monospace`;
    const measured = ctx.measureText(str).width;
    if (measured > MAX_W) {
      fontPx = Math.floor(fontPx * (MAX_W / measured));
      ctx.font = `bold ${fontPx}px monospace`;
    }

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillText(str, W / 2, H / 2);
    tex.needsUpdate = true; // upload only on change
  }

  return { mesh, setText };
}

// Gaze reticle texture: a glowing cyan ring with a centre dot and four tick
// marks, on transparent. Additive on the mesh → reads as a bright crosshair.
function makeReticleTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const c = S / 2;
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#00e5ff';
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 10;

  // Ring.
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(c, c, S * 0.30, 0, Math.PI * 2);
  ctx.stroke();

  // Centre dot.
  ctx.beginPath();
  ctx.arc(c, c, S * 0.05, 0, Math.PI * 2);
  ctx.fill();

  // Four tick marks (up/down/left/right).
  ctx.lineWidth = 5;
  const inner = S * 0.34, outer = S * 0.46;
  const ticks = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  for (const [dx, dy] of ticks) {
    ctx.beginPath();
    ctx.moveTo(c + dx * inner, c + dy * inner);
    ctx.lineTo(c + dx * outer, c + dy * outer);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// Canvas-texture label for the ACTIVATE panel. Magenta on dark, on-brand.
function makePanelTexture() {
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(8,8,14,0.92)';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#b14bff';
  ctx.lineWidth = 8;
  ctx.shadowColor = '#b14bff';
  ctx.shadowBlur = 24;
  ctx.strokeRect(10, 10, W - 20, H - 20);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#b14bff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 56px monospace';
  ctx.fillText('✓ PAID', W / 2, H * 0.36);
  ctx.font = 'bold 40px monospace';
  ctx.fillText('ACTIVATE RAPID FIRE', W / 2, H * 0.68);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
