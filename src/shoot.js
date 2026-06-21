import * as THREE from 'three';
import { targetMeshes, removeTarget, removeSpecial } from './targets.js';
import { playHitSound, playMissSound, playSatoshiHitSound } from './audio.js';
import { recordHit, recordMiss } from './score.js';
import { isRapidFire, RAPID_BURST, RAPID_INTERVAL_MS } from './upgrade.js';

/**
 * shoot.js — raycasting, hit detection, and burst particles.
 *
 * Shooting is FREE and unlimited (free-to-play). Each trigger fires one shot,
 * unless the rapid-fire upgrade is active — then each trigger fires a quick
 * burst of RAPID_BURST shots (see upgrade.js).
 *
 * Public API:
 *   setupShooter(camera, scene, onFire) → { onShoot, shootFromRay, updateBursts }
 *   onShoot(ndcX, ndcY)          — call from input.js on every click/tap
 *   shootFromRay(origin, dir)    — call from xr.js for controller / handheld taps
 *   updateBursts(delta)          — call every frame to animate and expire bursts
 */

// How many particles per burst, and how long they live.
const BURST_PARTICLE_COUNT = 30;
const BURST_LIFETIME       = 0.6;  // seconds
const BURST_SPEED          = 2.5;  // outward metres per second

// Satoshi (special) hits get a big, explosive, star-shaped burst for max juice.
const SATOSHI_BURST_COUNT  = 120;
const SATOSHI_BURST_SPEED  = 5.5;

// Points awarded per hit.
const NORMAL_POINTS  = 1;
const SATOSHI_POINTS = 21;

// "+21" floating score popup above a bursted Satoshi star.
const FLOATER_LIFETIME = 1.1; // seconds before it fully fades
const FLOATER_RISE     = 1.1; // metres it drifts upward over its life

// Rapid-fire coin hits get a bigger, faster, multi-colour burst (juice for the
// paid window). Normal (non-rapid) hits are unchanged.
const RAPID_BURST_COUNT = 50;
const RAPID_BURST_SPEED = 4.0;
const BURST_PALETTE = [0xf7931a, 0xb14bff, 0x00e5ff, 0xffd700] // orange, magenta, cyan, gold
  .map((c) => new THREE.Color(c));

// Lightning zap — fires ONLY on a successful hit during the PAID rapid-fire
// window (never on misses, never in free play). A jagged main bolt from the shot
// origin to the hit point plus a few forks, additive electric blue/white, brief.
// One LineSegments draw call per bolt; capped so rapid hits stay cheap on Quest.
const BOLT_LIFETIME = 0.16;  // seconds — flashes and fades fast (crackling zap)
const BOLT_MAX      = 12;    // hard cap on simultaneous bolts
const BOLT_SEGMENTS = 10;    // jaggedness of the main bolt
const BOLT_JITTER   = 0.07;  // sideways jitter as a fraction of bolt length
const BOLT_COLOR    = 0xc4e2ff; // electric blue-white (additive → reads white-hot)
// Flat/mobile gun muzzle in camera space (≈ the on-screen gun barrel tip). Used
// as the lightning origin so the bolt is seen from the side, not end-on.
const MUZZLE_OFFSET = new THREE.Vector3(0.18, -0.16, -0.5);

// onFire — optional callback invoked on every shot fired (hit or miss),
// e.g. to trigger the weapon muzzle flash.
export function setupShooter(camera, scene, onFire) {
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2(); // reused for camera-space aiming
  const _camPos = new THREE.Vector3(); // reused: camera world position for the muzzle

  // Active burst objects — each has { points, velocities, age }.
  // Kept small; bursts expire in ~0.35s so rarely more than 2–3 alive at once.
  const bursts = [];

  // Active "+21" floating-score sprites — each has { sprite, age }.
  const floaters = [];

  // Active lightning bolts — each has { line, age }.
  const bolts = [];

  // ── Shared burst material ──────────────────────────────────────────────────
  // One material instance reused by all bursts — no extra GPU state changes.
  const burstMat = new THREE.PointsMaterial({
    color: 0xf7931a,
    size: 0.12,
    sizeAttenuation: true, // particles shrink with distance (perspective)
  });

  // Satoshi hits — big MULTI-COLOURED STAR confetti. The star shape comes from a
  // point-sprite texture (white canvas ★ on transparent bg); vertexColors tints
  // each star a random palette colour (white base map × per-particle colour).
  // alphaTest keeps the star edges crisp and cheap (cut-out, not heavy blending).
  const satoshiStarMat = new THREE.PointsMaterial({
    map: createStarTexture(),
    size: 0.28,
    sizeAttenuation: true,
    alphaTest: 0.5,
    transparent: true,    // lets the existing opacity fade-out work
    depthWrite: false,
    vertexColors: true,   // per-particle confetti colours from the palette
  });

  // Rapid-fire coin-hit burst — bigger particles, per-particle colours (palette).
  const rapidBurstMat = new THREE.PointsMaterial({
    size: 0.22,
    sizeAttenuation: true,
    vertexColors: true, // colour comes from the geometry's 'color' attribute
    transparent: true,
  });

  // ── onShoot ────────────────────────────────────────────────────────────────
  // Called by input.js for mouse click and touch tap.
  // ndcX/ndcY are Normalised Device Coordinates [-1, +1].
  function onShoot(ndcX, ndcY) {
    // setupRay aims the raycaster from the camera through the NDC point.
    // Captured in a closure so rapid-fire bursts re-aim the same way each shot.
    // muzzleOrigin = null → doShot derives the flat/mobile gun muzzle from the camera.
    triggerFire(() => raycaster.setFromCamera(_ndc.set(ndcX, ndcY), camera), null);
  }

  // ── shootFromRay ───────────────────────────────────────────────────────────
  // Called by xr.js for Quest controller triggers and handheld screen taps.
  // origin/direction are world-space, captured at trigger time. The controller
  // origin IS the gun muzzle, so pass it through as the lightning bolt's start.
  function shootFromRay(origin, direction) {
    const muzzle = origin.clone();
    triggerFire(() => raycaster.set(origin, direction), muzzle);
  }

  // ── triggerFire ──────────────────────────────────────────────────────────
  // One trigger event → one shot, OR a quick burst when rapid-fire is active.
  // setupRay() configures the raycaster for this trigger's aim; it's reused for
  // every shot in the burst so they all follow the same line. muzzleOrigin (or
  // null for flat) is the lightning bolt's start point.
  function triggerFire(setupRay, muzzleOrigin) {
    doShot(setupRay, muzzleOrigin); // first shot fires immediately

    if (isRapidFire()) {
      // Schedule the remaining burst shots a few ms apart for a rifle feel.
      for (let i = 1; i < RAPID_BURST; i++) {
        setTimeout(() => doShot(setupRay, muzzleOrigin), i * RAPID_INTERVAL_MS);
      }
    }
  }

  // ── doShot ───────────────────────────────────────────────────────────────
  // Fire a single shot: aim, flash, raycast, resolve hit/miss. Free — no cost.
  function doShot(setupRay, muzzleOrigin) {
    setupRay();

    // Lightning bolt start = the GUN MUZZLE (not the eye). For controller shots
    // muzzleOrigin is the controller pose. For flat/mobile it's null, so derive
    // the on-screen gun's muzzle as a down-right offset from the camera — this
    // keeps the bolt off the view axis so it isn't foreshortened to nothing.
    const boltStart = muzzleOrigin
      ? muzzleOrigin
      : MUZZLE_OFFSET.clone().applyQuaternion(camera.quaternion).add(camera.getWorldPosition(_camPos));

    // Announce the shot (muzzle flash etc.) — fires for both hits and misses.
    if (onFire) onFire();

    // Three's raycaster doesn't skip invisible objects, so a just-hit coin
    // (hidden during its respawn delay) could otherwise intercept the ray in
    // front of a visible one — swallowing the shot. Take the closest VISIBLE hit.
    const hits = raycaster.intersectObjects(targetMeshes);
    const hit = hits.find((h) => h.object.visible);

    if (hit) {
      if (hit.object.userData.special) {
        // Satoshi target — big points, explosive multi-colour star burst, a
        // floating "+21" popup, and a distinct sound.
        spawnBurst(hit.point, SATOSHI_BURST_COUNT, SATOSHI_BURST_SPEED, satoshiStarMat);
        spawnFloater(`+${SATOSHI_POINTS}`, hit.point);
        removeSpecial();
        recordHit(SATOSHI_POINTS);
        playSatoshiHitSound();
      } else {
        // Normal coin. During rapid-fire, give it the spectacular multi-colour
        // burst; otherwise the standard orange one (unchanged).
        const hitIndex = targetMeshes.indexOf(hit.object);
        if (isRapidFire()) {
          spawnBurst(hit.point, RAPID_BURST_COUNT, RAPID_BURST_SPEED, rapidBurstMat);
        } else {
          spawnBurst(hit.point, BURST_PARTICLE_COUNT, BURST_SPEED, burstMat);
        }
        removeTarget(hitIndex);
        recordHit(NORMAL_POINTS);
        playHitSound();
      }
      // PAID rapid-fire only: a lightning zap along the shot path to the coin.
      // Hits only (we're inside `if (hit)`), so misses never spawn a bolt.
      if (isRapidFire()) spawnLightning(boltStart, hit.point);
    } else {
      recordMiss();
      playMissSound();
    }
  }

  // ── spawnBurst ─────────────────────────────────────────────────────────────
  // count/speed/material let normal and Satoshi hits use different juice.
  function spawnBurst(origin, count, speed, material) {
    const positions  = new Float32Array(count * 3);
    const velocities = []; // plain JS array of THREE.Vector3

    for (let i = 0; i < count; i++) {
      // All particles start at the origin.
      positions[i * 3]     = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;

      // Random direction on the unit sphere, scaled by burst speed.
      const dir = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5,
      ).normalize().multiplyScalar(speed);
      velocities.push(dir);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // For multi-colour bursts, give each particle a random palette colour.
    if (material.vertexColors) {
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const c = BURST_PALETTE[(Math.random() * BURST_PALETTE.length) | 0];
        colors[i * 3]     = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    const points = new THREE.Points(geo, material);
    scene.add(points);

    bursts.push({ points, velocities, age: 0, count });
  }

  // ── spawnLightning ───────────────────────────────────────────────────────────
  // A jagged additive bolt from the shot origin to the hit point, plus forks.
  // One LineSegments draw call; capped at BOLT_MAX (drop oldest) to stay cheap.
  function spawnLightning(start, end) {
    if (bolts.length >= BOLT_MAX) {
      const old = bolts.shift();
      scene.remove(old.line);
      old.line.geometry.dispose();
      old.line.material.dispose();
    }
    const verts = buildBoltSegments(start, end);
    if (verts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: BOLT_COLOR,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    scene.add(line);
    bolts.push({ line, age: 0 });
  }

  // ── spawnFloater ─────────────────────────────────────────────────────────────
  // A camera-facing "+21" sprite that pops above the hit point, drifts up, and
  // fades. Sprites always billboard the camera, so it reads in flat, AR, and VR.
  function spawnFloater(text, origin) {
    const mat = new THREE.SpriteMaterial({
      map: createTextTexture(text),
      transparent: true,
      depthWrite: false,
      depthTest: false, // always draw on top of coins/bursts
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(origin);
    sprite.position.y += 0.35;        // start just above the star
    sprite.scale.set(0.7, 0.35, 1);   // world-space size (w, h)
    scene.add(sprite);
    floaters.push({ sprite, age: 0 });
  }

  // ── updateBursts ──────────────────────────────────────────────────────────
  // Called every frame. delta = seconds since last frame.
  function updateBursts(delta) {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const burst = bursts[i];
      burst.age += delta;

      if (burst.age >= BURST_LIFETIME) {
        // Burst has expired — remove from scene and free GPU memory.
        scene.remove(burst.points);
        burst.points.geometry.dispose();
        bursts.splice(i, 1);
        continue;
      }

      // Move each particle outward along its velocity.
      const posAttr = burst.points.geometry.attributes.position;
      for (let p = 0; p < burst.count; p++) {
        posAttr.setXYZ(
          p,
          posAttr.getX(p) + burst.velocities[p].x * delta,
          posAttr.getY(p) + burst.velocities[p].y * delta,
          posAttr.getZ(p) + burst.velocities[p].z * delta,
        );
      }
      // Tell Three.js the positions changed this frame.
      posAttr.needsUpdate = true;

      // Fade out as the burst ages (0 → full opacity, 1 → gone).
      burst.points.material.opacity = 1 - burst.age / BURST_LIFETIME;
      burst.points.material.transparent = true;
    }

    // Animate "+21" floaters — drift up and fade, then dispose.
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.age += delta;
      if (f.age >= FLOATER_LIFETIME) {
        scene.remove(f.sprite);
        f.sprite.material.map.dispose();
        f.sprite.material.dispose();
        floaters.splice(i, 1);
        continue;
      }
      f.sprite.position.y += FLOATER_RISE * delta;
      // Hold full opacity briefly, then fade over the back half of the life.
      const t = f.age / FLOATER_LIFETIME;
      f.sprite.material.opacity = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
    }

    // Animate lightning bolts — flicker-fade fast, then dispose.
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.age += delta;
      if (b.age >= BOLT_LIFETIME) {
        scene.remove(b.line);
        b.line.geometry.dispose();
        b.line.material.dispose();
        bolts.splice(i, 1);
        continue;
      }
      // Fade out with a slight random flicker so it crackles rather than dimming smoothly.
      const t = b.age / BOLT_LIFETIME;
      b.line.material.opacity = (1 - t) * (0.65 + Math.random() * 0.35);
    }
  }

  return { onShoot, shootFromRay, updateBursts };
}

// ── buildBoltSegments ────────────────────────────────────────────────────────
// Builds a Float32Array of LineSegments vertex pairs for one lightning bolt:
// a jagged main path from start→end (perpendicular jitter, zeroed at the ends)
// plus a few organic forking branches. Returns flat [ax,ay,az, bx,by,bz, …].
function buildBoltSegments(start, end) {
  const dir = end.clone().sub(start);
  const len = dir.length();
  if (len < 1e-3) return new Float32Array(0);
  dir.normalize();

  // Two axes perpendicular to the shot direction, for sideways jitter.
  let u = new THREE.Vector3(0, 1, 0).cross(dir);
  if (u.lengthSq() < 1e-4) u = new THREE.Vector3(1, 0, 0);
  u.normalize();
  const w = new THREE.Vector3().crossVectors(dir, u).normalize();

  const amp = len * BOLT_JITTER;
  const lerp = new THREE.Vector3();

  // Main jagged path: jitter peaks mid-bolt (sin), so the ends stay anchored.
  const main = [start.clone()];
  for (let i = 1; i < BOLT_SEGMENTS; i++) {
    const t = i / BOLT_SEGMENTS;
    const s = Math.sin(Math.PI * t);
    const p = lerp.copy(start).addScaledVector(dir, len * t).clone();
    p.addScaledVector(u, (Math.random() - 0.5) * amp * 2 * s);
    p.addScaledVector(w, (Math.random() - 0.5) * amp * 2 * s);
    main.push(p);
  }
  main.push(end.clone());

  const segs = [];
  const push = (a, b) => segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (let i = 0; i < main.length - 1; i++) push(main[i], main[i + 1]);

  // A few forking branches off interior points, angling away then jittering.
  const forks = 2 + (Math.random() * 2 | 0); // 2–3
  for (let f = 0; f < forks; f++) {
    const idx = 2 + (Math.random() * (main.length - 4) | 0);
    let p = main[idx].clone();
    const bdir = dir.clone().multiplyScalar(0.4)
      .addScaledVector(u, (Math.random() - 0.5) * 1.6)
      .addScaledVector(w, (Math.random() - 0.5) * 1.6)
      .normalize();
    const blen = len * (0.12 + Math.random() * 0.18);
    const steps = 3;
    for (let s = 0; s < steps; s++) {
      const next = p.clone().addScaledVector(bdir, blen / steps);
      next.addScaledVector(u, (Math.random() - 0.5) * amp);
      next.addScaledVector(w, (Math.random() - 0.5) * amp);
      push(p, next);
      p = next;
    }
  }

  return new Float32Array(segs);
}

// ── Star point-sprite texture (drawn once, shared) ──────────────────────────────
// A white ★ on a transparent background. Tinted gold by the material's color.
function createStarTexture() {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, S, S); // transparent background
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.floor(S * 0.9)}px serif`;
  ctx.fillText('★', S / 2, S / 2 + S * 0.04);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ── "+21" floating-score texture (drawn per popup) ───────────────────────────────
// Bold gold text with a dark outline so it stays legible against any background.
function createTextTexture(text) {
  const W = 256, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 84px sans-serif';

  // Dark outline for contrast, then gold fill.
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, W / 2, H / 2);
  ctx.fillStyle = '#ffd700';
  ctx.fillText(text, W / 2, H / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
