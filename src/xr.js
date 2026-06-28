import * as THREE from 'three';

/**
 * xr.js — Quest controller + handheld-tap input for WebXR sessions.
 *
 * Session entry/exit (Enter VR / Enter AR / Exit to SCREEN) lives in
 * modeswitcher.js. This module only handles input once a session is running:
 *
 *   1. Create controller objects for both hands and add them to the scene.
 *   2. Draw a pointing ray line from each active tracked controller.
 *   3. On trigger pull (controller) or screen tap (handheld), call shootFromRay()
 *      with the right world-space origin + direction.
 *   4. Provide updateControllers() to be called every XR frame.
 *
 * Public API:
 *   setupXR(renderer, scene, shootFromRay) — call once at startup
 *   Returns { updateControllers }          — call in the animation loop
 */

// How long the visual ray line extends from the controller tip (metres).
const RAY_LENGTH = 5;

// onControllerSelect(origin, direction) → bool: an optional in-world UI handler.
// If it returns true, it consumed the trigger (e.g. pressed the ACTIVATE panel)
// and the shot is suppressed.
export function setupXR(renderer, scene, shootFromRay, onControllerSelect, flashController) {

  // ── Build both controllers ─────────────────────────────────────────────────
  // getController(0/1) returns a Group whose world matrix Three.js updates
  // automatically each XR frame to match the physical controller pose.
  // Index 0 = first controller to connect, 1 = second. We treat both identically.
  // flashController(index) fires THAT controller's own gun muzzle flash (dual wield).
  const controllers = [
    buildController(0, renderer, scene, shootFromRay, onControllerSelect, flashController),
    buildController(1, renderer, scene, shootFromRay, onControllerSelect, flashController),
  ];

  // ── updateControllers ─────────────────────────────────────────────────────
  // Called every frame from main.js. Refreshes ray lines and polls the LEFT
  // controller's face buttons for the EXIT action (face buttons aren't events in
  // WebXR — they live on inputSource.gamepad.buttons, so we poll with edge detect).
  function updateControllers() {
    controllers.forEach((state) => {
      const { rayLine, connected } = state;
      if (connected.value && rayLine) {
        rayLine.geometry.attributes.position.needsUpdate = true;
      }

      // EXIT immersive session on a deliberate lower face-button press, on EITHER
      // controller. xr-standard mapping on Quest Touch: buttons[4] = X (left hand)
      // and A (right hand). So X or A exits. Edge-detected so holding doesn't
      // repeat; ignores trigger (buttons[0]) and grip (buttons[1]).
      const src = state.inputSource;
      if (src && src.gamepad && src.gamepad.buttons) {
        const b = src.gamepad.buttons;
        const pressed = !!(b[4] && b[4].pressed); // X on left, A on right
        if (pressed && !state.exitPrev) {
          const session = renderer.xr.getSession();
          if (session) session.end();
        }
        state.exitPrev = pressed;
      }
    });
  }

  return { updateControllers };
}

// ── buildController ──────────────────────────────────────────────────────────
// Creates one controller group, its ray line, and wires events.
function buildController(index, renderer, scene, shootFromRay, onControllerSelect, flashController) {
  // getController returns a Group that Three.js XR manager updates each frame.
  const group = renderer.xr.getController(index);

  // Add to the scene so Three.js includes it in the scene graph and updates its pose.
  scene.add(group);

  // `connected` is a plain object so event callbacks and updateControllers
  // can both read/write it without complex closure wiring.
  const state = { group, rayLine: null, connected: { value: false }, inputSource: null, exitPrev: false };

  // ── Ray line ──────────────────────────────────────────────────────────────
  // Two points in controller local space: tip (0,0,0) → forward (0,0,-RAY_LENGTH).
  // Because the line is a child of `group`, it automatically follows the controller.
  const points = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -RAY_LENGTH),
  ];
  const rayGeo  = new THREE.BufferGeometry().setFromPoints(points);
  const rayMat  = new THREE.LineBasicMaterial({
    color: 0xf7931a,
    transparent: true,
    opacity: 0.5, // matches camera laser opacity in scene.js
  });
  const rayLine = new THREE.Line(rayGeo, rayMat);
  rayLine.visible = false; // hidden until the controller physically connects
  group.add(rayLine);
  state.rayLine = rayLine;

  // Reusable vectors — allocated once here, not inside the event callback,
  // to avoid GC churn on every trigger pull.
  const _origin    = new THREE.Vector3();
  const _direction = new THREE.Vector3();

  // ── connected ─────────────────────────────────────────────────────────────
  // Fired when an input source appears. event.data is the XRInputSource.
  // On a Quest controller this is a 'tracked-pointer'. On a handheld phone tap
  // it's a transient 'screen' input source (appears on touch, gone on release).
  group.addEventListener('connected', (event) => {
    state.connected.value = true;
    state.inputSource = event.data || null;

    // Show the aim ray only for tracked controllers, not for a phone screen tap
    // (a floating ray from a tap point would look wrong). UNTESTED — verify the
    // handheld tap does NOT draw a stray ray on Android tomorrow.
    const isScreen = state.inputSource && state.inputSource.targetRayMode === 'screen';
    rayLine.visible = !isScreen;
  });

  // ── disconnected ──────────────────────────────────────────────────────────
  group.addEventListener('disconnected', () => {
    state.connected.value = false;
    rayLine.visible = false;
  });


  // ── selectstart ───────────────────────────────────────────────────────────
  // Fired on trigger press (Quest controller) OR screen tap (handheld AR).
  // Both reuse shootFromRay — only the ray source differs:
  //   tracked-pointer → ray from the controller pose.
  //   screen (phone)  → ray from the XR camera centre, so the phone aims like a
  //                     gun and a centre crosshair is the aim point.
  group.addEventListener('selectstart', (event) => {
    // Read the input source from the EVENT itself (Three passes it as event.data),
    // not from the separate 'connected' handler. For handheld AR each tap is a
    // transient 'screen' source created/destroyed per tap, and 'connected' vs
    // 'selectstart' can race — depending on state.inputSource/connected.value
    // there intermittently dropped taps. event.data is always present here.
    const src = event.data || state.inputSource;
    const mode = src && src.targetRayMode;
    console.log('[xr] select targetRayMode =', mode); // debug: identify Cardboard/Quest/phone input

    // Head-aimed input: handheld phone AR ('screen' tap) OR Cardboard ('gaze'
    // button). Both fire straight out of the XR camera = the centre crosshair,
    // aimed by head direction. (Quest uses the tracked-controller branch below.)
    const headAimed = mode === 'screen' || mode === 'gaze';

    if (headAimed) {
      // Fire from the XR camera forward (crosshair). No connected/inputSource gate,
      // so a tap/gaze-press is never swallowed by a connect race.
      const xrCam = renderer.xr.getCamera();
      _origin.setFromMatrixPosition(xrCam.matrixWorld);
      _direction.set(0, 0, -1).transformDirection(xrCam.matrixWorld).normalize();

      // Cardboard only: let the head-aim ray operate the in-world ACTIVATE panel
      // too (gaze at it + press fires the panel instead of a shot). Phone AR keeps
      // its DOM ACTIVATE button, so we don't add the panel check for 'screen'.
      if (mode === 'gaze' && onControllerSelect && onControllerSelect(_origin, _direction)) return;
    } else {
      // Tracked controller: fire from the controller pose (guard is correct here —
      // a controller connects once and stays connected).
      if (!state.connected.value) return;
      _origin.setFromMatrixPosition(group.matrixWorld);
      _direction.set(0, 0, -1).transformDirection(group.matrixWorld).normalize();

      // In-world UI (the ACTIVATE panel) takes precedence: if the controller is
      // pointing at it, activate and DON'T fire a shot.
      if (onControllerSelect && onControllerSelect(_origin, _direction)) return;

      // Dual wield: fire THIS controller's own gun muzzle flash. (Screen/handheld
      // taps skip this — there's no controller-mounted gun on a phone.)
      if (flashController) flashController(index);
    }

    // Clone so shootFromRay doesn't hold a reference to our reused vectors.
    shootFromRay(_origin.clone(), _direction.clone());
  });

  return state;
}
