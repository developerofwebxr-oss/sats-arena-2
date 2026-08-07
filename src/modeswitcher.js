/**
 * modeswitcher.js — unified SCREEN / VR / AR mode selector.
 *
 * Split into two layers so a future in-world 3D switcher can reuse the logic:
 *
 *   createModeController(renderer)
 *     The brain. Owns capability detection and the actual mode switching as
 *     plain methods — enterVR(), enterAR(), exitToScreen() — plus a subscribe()
 *     for views to react to state changes. NO DOM knowledge. A future set of
 *     3D buttons inside the VR scene can call these same methods.
 *
 *   createDomSwitcher(controller)
 *     The view. Builds the neon DOM buttons and wires them to the controller.
 *
 *   setupModeSwitcher(renderer)
 *     Composes both and returns the controller (so other code / a later 3D
 *     view can drive mode switching too).
 */

// WebXR session init options. AR requests dom-overlay so HTML (crosshair/HUD)
// shows over passthrough on handheld; Quest ignores what it doesn't use.
const VR_INIT = { optionalFeatures: ['local-floor', 'bounded-floor'] };
const AR_INIT = {
  optionalFeatures: ['dom-overlay', 'local-floor'],
  domOverlay: { root: document.body },
};

// ── Mode controller (no DOM) ────────────────────────────────────────────────

export function createModeController(renderer) {
  // capabilities: 'checking' | 'supported' | 'unsupported' (+ a reason string)
  const state = {
    activeMode: 'screen', // 'screen' | 'vr' | 'ar'
    vr: { status: 'checking', reason: '' },
    ar: { status: 'checking', reason: '' },
  };

  const listeners = [];
  const notify = () => listeners.forEach((fn) => fn(state));

  /** Subscribe to state changes. Returns nothing; views re-render in the callback. */
  function subscribe(fn) {
    listeners.push(fn);
    fn(state); // push current state immediately
  }

  // ── Mode switching — the reusable methods (DOM + future 3D both call these) ──

  // End any active immersive session before starting a new one. WebXR won't run
  // two immersive sessions at once, so requesting VR while AR is live (or vice
  // versa) rejected — you had to exit to SCREEN first. Ending and AWAITING the
  // current session lets AR↔VR switch in one step; the sessionend/sessionstart
  // listeners (here + armode) handle each mode's teardown and setup.
  async function endActiveSession() {
    const current = renderer.xr.getSession();
    if (current) {
      try { await current.end(); } catch { /* already ending — ignore */ }
    }
  }

  async function enterVR() {
    if (state.vr.status !== 'supported') return;
    try {
      await endActiveSession(); // leave AR (or any session) before entering VR
      const session = await navigator.xr.requestSession('immersive-vr', VR_INIT);
      await renderer.xr.setSession(session);
      // activeMode is set by the sessionstart listener below.
    } catch (err) {
      console.warn('Failed to enter VR:', err);
    }
  }

  async function enterAR() {
    if (state.ar.status !== 'supported') return;
    try {
      await endActiveSession(); // leave VR (or any session) before entering AR
      const session = await navigator.xr.requestSession('immersive-ar', AR_INIT);
      await renderer.xr.setSession(session);
    } catch (err) {
      console.warn('Failed to enter AR:', err);
    }
  }

  function exitToScreen() {
    // If an immersive session is running, end it — sessionend returns us to screen.
    const session = renderer.xr.getSession();
    if (session) session.end();
    // If already in screen mode, this is a no-op.
  }

  // ── Session lifecycle keeps activeMode honest ───────────────────────────────
  // Fires whether the session was started by us or ended by the headset's
  // native exit, so the active highlight is always correct.
  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    const blend = session && session.environmentBlendMode;
    state.activeMode = blend && blend !== 'opaque' ? 'ar' : 'vr';
    notify();
  });
  renderer.xr.addEventListener('sessionend', () => {
    state.activeMode = 'screen';
    notify();
  });

  // ── Async capability detection ──────────────────────────────────────────────
  // VR/AR start as 'checking' and flip once resolved — never the reverse, so
  // the buttons don't flicker from enabled to disabled.
  function detectCapabilities() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) {
      state.vr = { status: 'unsupported', reason: 'WebXR unavailable' };
      state.ar = { status: 'unsupported', reason: 'WebXR unavailable' };
      notify();
      return;
    }

    navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
      state.vr = ok
        ? { status: 'supported', reason: '' }
        : { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    }).catch(() => {
      state.vr = { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    });

    navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
      state.ar = ok
        ? { status: 'supported', reason: '' }
        : { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    }).catch(() => {
      state.ar = { status: 'unsupported', reason: 'Not supported on this device' };
      notify();
    });
  }

  detectCapabilities();

  return { state, subscribe, enterVR, enterAR, exitToScreen };
}

// ── DOM view ─────────────────────────────────────────────────────────────────

export function createDomSwitcher(controller) {
  injectStyles();

  const bar = document.createElement('div');
  bar.id = 'mode-switcher';

  // Each entry: mode key, label, accent color, and the action it triggers.
  const defs = [
    { mode: 'screen', label: 'SCREEN', color: '#00e5ff', action: controller.exitToScreen },
    { mode: 'vr',     label: 'VR',     color: '#b14bff', action: controller.enterVR },
    { mode: 'ar',     label: 'AR',     color: '#f7931a', action: controller.enterAR },
  ];

  const buttons = defs.map((def) => {
    const btn = document.createElement('button');
    btn.className = 'mode-btn';
    btn.style.setProperty('--accent', def.color);

    const main = document.createElement('div');
    main.className = 'mode-main';
    main.textContent = def.label;

    const sub = document.createElement('div');
    sub.className = 'mode-sub';

    btn.append(main, sub);
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the click reach the canvas shoot handler
      def.action();
      btn.blur();          // drop focus so SPACE shoots instead of re-triggering this
    });

    bar.appendChild(btn);
    return { def, btn, sub };
  });

  document.body.appendChild(bar);

  // Re-render button states whenever the controller's state changes.
  controller.subscribe((state) => {
    buttons.forEach(({ def, btn, sub }) => {
      const isActive = state.activeMode === def.mode;
      btn.classList.toggle('active', isActive);

      if (def.mode === 'screen') {
        // SCREEN is always available on every device.
        btn.classList.remove('checking', 'disabled');
        sub.textContent = '';
        return;
      }

      const cap = state[def.mode]; // vr or ar
      btn.classList.toggle('checking', cap.status === 'checking');
      btn.classList.toggle('disabled', cap.status === 'unsupported');
      btn.disabled = cap.status !== 'supported';

      sub.textContent =
        cap.status === 'checking'    ? 'checking…' :
        cap.status === 'unsupported' ? cap.reason  : '';
    });
  });
}

// ── Compose ──────────────────────────────────────────────────────────────────

export function setupModeSwitcher(renderer) {
  const controller = createModeController(renderer);
  createDomSwitcher(controller);
  return controller; // exposed so a future in-world 3D switcher can reuse it
}

// ── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    #mode-switcher {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 10px;
      z-index: 200;
      font-family: monospace;
    }
    .mode-btn {
      min-width: 96px;
      padding: 10px 14px;
      background: rgba(0,0,0,0.78);
      color: var(--accent);
      border: 1px solid var(--accent);
      cursor: pointer;
      text-align: center;
      letter-spacing: 0.1em;
      transition: background 0.15s, box-shadow 0.15s, opacity 0.15s;
    }
    .mode-btn .mode-main { font-size: 16px; }
    .mode-btn .mode-sub  { font-size: 10px; opacity: 0.7; min-height: 12px; margin-top: 3px; letter-spacing: 0.06em; }
    /* Narrow phones: tighten so all three fit within ~390px with margins. */
    @media (max-width: 480px) {
      #mode-switcher { gap: 6px; width: calc(100vw - 28px); max-width: 360px; }
      .mode-btn { min-width: 0; flex: 1; padding: 9px 6px; }
      .mode-btn .mode-main { font-size: 14px; }
      .mode-btn .mode-sub  { font-size: 9px; }
    }
    .mode-btn:hover:not(.disabled):not(.checking) {
      background: color-mix(in srgb, var(--accent) 15%, rgba(0,0,0,0.78));
    }
    /* Active mode — filled glow in its accent color. */
    .mode-btn.active {
      background: color-mix(in srgb, var(--accent) 22%, rgba(0,0,0,0.78));
      box-shadow: 0 0 16px var(--accent), inset 0 0 8px color-mix(in srgb, var(--accent) 40%, transparent);
      text-shadow: 0 0 8px var(--accent);
    }
    /* Checking… — neutral, not yet clickable. */
    .mode-btn.checking {
      opacity: 0.5;
      cursor: default;
      color: #888;
      border-color: #555;
    }
    /* Unsupported — greyed with reason sublabel. */
    .mode-btn.disabled {
      opacity: 0.35;
      cursor: not-allowed;
      color: #888;
      border-color: #555;
      box-shadow: none;
    }
  `;
  document.head.appendChild(style);
}
