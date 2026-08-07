import QRCode from 'qrcode';
import { playReloadSound } from './audio.js';
import { grantRapidFire, isRapidFire, getRemainingSeconds } from './upgrade.js';
import { isLightningEnabled, getSessionCode, getPaidCount, createInvoice, validateCode, createInvoiceForCode } from './lightning.js';
import { getScore } from './score.js';

/**
 * hud.js — all DOM overlays.
 *
 * Free-to-play HUD (no balance / currency):
 *   - RAPID FIRE purchase button (top-right) → one tap buys 60s of rapid-fire
 *   - Rapid-fire countdown (top-left) while active
 *   - On-screen SHOOT button (bottom-right)
 *
 * Shooting is free and unlimited. The upgrade purchase IS the upgrade — there's
 * nothing to deduct from.
 */

const RAPID_FIRE_PRICE = 21; // sats — display + (later) the Lightning invoice amount

let countdownEl;
let scoreEl;        // running SCORE (top-centre)
let lastShownScore = -1;
let codeEl;         // session code (top-left)
let activatePrompt; // "✓ PAID — ACTIVATE RAPID FIRE" button
let upgradeBtn;

// Charge model: payments are banked, not auto-fired.
let activatedCount = 0;   // charges the player has activated (persisted per code)
let activatedFor   = '';  // which code activatedCount belongs to
let shownCode      = '';  // last code rendered in the HUD
let lastPaid       = 0;   // last paidCount seen (to detect a fresh payment)

function activatedStorageKey(code) { return `satsArena_activated_${code}`; }

// Load the persisted activatedCount for a code (so reloads don't re-grant).
function loadActivated(code) {
  activatedFor = code;
  activatedCount = parseInt(localStorage.getItem(activatedStorageKey(code)) || '0', 10);
}
function saveActivated() {
  if (activatedFor) localStorage.setItem(activatedStorageKey(activatedFor), String(activatedCount));
}
let payModal;        // payment QR overlay
let payModalQr;      // <img> for the QR
let payModalCode;    // session code line
let payModalStatus;  // "waiting…" / error line
let payModalOpenLink; // <a href="lightning:..."> open-in-wallet button
let payModalCopyBtn;  // copy-invoice button
let currentInvoice = ''; // the active BOLT11 string
let chooser;          // "pay for this device / a headset" panel
let chooserInput;     // headset session-code input
let chooserStatus;    // chooser status line
let upgradeDefaultHTML = ''; // RAPID FIRE button's normal markup (restored after loading)
let purchasing = false;      // guards against double-taps while creating an invoice

// Toggle the RAPID FIRE button between its normal label and a "creating…" spinner.
function setUpgradeLoading(loading) {
  purchasing = loading;
  if (loading) {
    upgradeBtn.innerHTML = `<div style="font-size:14px; letter-spacing:0.1em;"><span class="mini-spinner"></span>&nbsp; CREATING INVOICE…</div>`;
    upgradeBtn.style.cursor = 'default';
  } else {
    upgradeBtn.innerHTML = upgradeDefaultHTML;
    upgradeBtn.style.cursor = 'pointer';
  }
}
let lastShownSecond = -1; // so the countdown only re-renders when it changes

// ── Styles ─────────────────────────────────────────────────────────────────
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes lightning-pulse {
      0%   { box-shadow: 0 0 12px rgba(247,147,26,0.4), 0 0 24px rgba(247,147,26,0.2); }
      50%  { box-shadow: 0 0 28px rgba(247,147,26,0.9), 0 0 56px rgba(247,147,26,0.5); }
      100% { box-shadow: 0 0 12px rgba(247,147,26,0.4), 0 0 24px rgba(247,147,26,0.2); }
    }
    #upgrade-btn { animation: lightning-pulse 1.4s ease-in-out infinite; }
    #upgrade-btn.active {
      /* While rapid-fire is running, the button glows magenta to show it's live. */
      animation: none;
      border-color: #b14bff;
      color: #b14bff;
      text-shadow: 0 0 10px #b14bff;
      box-shadow: 0 0 24px rgba(177,75,255,0.6);
    }

    /* Loading spinner for the "creating invoice…" button state. */
    @keyframes mini-spin { to { transform: rotate(360deg); } }
    .mini-spinner {
      display: inline-block; width: 12px; height: 12px; vertical-align: middle;
      border: 2px solid rgba(247,147,26,0.3); border-top-color: #f7931a;
      border-radius: 50%; animation: mini-spin 0.7s linear infinite;
    }

    /* Narrow phones: shrink the corner buttons so they don't crowd the top row
       or collide with the bottom controls. */
    @media (max-width: 480px) {
      #upgrade-btn { padding: 9px 12px; top: 12px; right: 12px; }
      #upgrade-btn > div:first-child { font-size: 14px !important; }
      #upgrade-btn > div:last-child  { font-size: 10px !important; }
      #shoot-btn { right: 14px; }
    }

    /* Landscape: drop the corner buttons to the bottom row (≈ the mode-switcher
       level) instead of floating mid-screen. Portrait position is unchanged.
       !important overrides the inline bottom set in JS. */
    @media (orientation: landscape) {
      #shoot-btn, #recenter-btn { bottom: 24px !important; }
    }
  `;
  document.head.appendChild(style);
}

// ── createHUD ─────────────────────────────────────────────────────────────────

export function createHUD(onShoot) {
  injectStyles();

  // ── Rapid-fire countdown (top-left) ─────────────────────────────────────────
  // Hidden unless active. Magenta to match the upgrade.
  const hud = document.createElement('div');
  hud.id = 'hud';
  // Left HUD block (countdown / session code / score). Flex-column, vertically
  // centred; its top+height are matched to the RAPID FIRE panel each layout so
  // the two top corners stay balanced (see alignLeftBlockToPanel below).
  hud.style.cssText = `
    position: fixed;
    top: 16px;
    left: 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    font-family: monospace;
    pointer-events: none;
    user-select: none;
  `;

  countdownEl = document.createElement('div');
  countdownEl.style.cssText = `
    display: none;
    font-size: 15px;
    letter-spacing: 0.12em;
    color: #b14bff;
    text-shadow: 0 0 8px #b14bff;
  `;

  hud.append(countdownEl);
  document.body.appendChild(hud);

  // ── SCORE (top-left, under the session code) ────────────────────────────────
  // Left column avoids the top-centre collision with the payment button on a
  // narrow portrait phone. (In-VR 3D score position is separate, in vrui.js.)
  scoreEl = document.createElement('div');
  scoreEl.id = 'score';
  scoreEl.style.cssText = `
    font-family: monospace;
    font-size: 16px;
    letter-spacing: 0.12em;
    color: #f7931a;
    text-shadow: 0 0 10px #f7931a;
    pointer-events: none;
    user-select: none;
  `;
  scoreEl.textContent = 'SCORE 0';

  // ── Session code (top-left, under the countdown) ────────────────────────────
  // Shown so it can be read and typed into pay.html on another device.
  codeEl = document.createElement('div');
  codeEl.id = 'session-code';
  codeEl.style.cssText = `
    font-family: monospace;
    font-size: 13px;
    letter-spacing: 0.18em;
    color: #00e5ff;
    text-shadow: 0 0 8px #00e5ff;
    pointer-events: none;
    user-select: none;
    display: none;
  `;
  // Order top→bottom inside the left block: countdown, session code, score.
  hud.append(codeEl, scoreEl);

  // ── Activate prompt (centre) — appears when a payment is banked ─────────────
  activatePrompt = document.createElement('button');
  activatePrompt.id = 'activate-prompt';
  activatePrompt.style.cssText = `
    display: none;
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 18px 30px;
    background: rgba(0,0,0,0.85);
    color: #b14bff;
    border: 1px solid #b14bff;
    font-family: monospace;
    font-size: 18px;
    letter-spacing: 0.1em;
    cursor: pointer;
    text-shadow: 0 0 10px #b14bff;
    box-shadow: 0 0 24px rgba(177,75,255,0.5);
    z-index: 250;
  `;
  activatePrompt.addEventListener('click', (e) => {
    e.stopPropagation();
    activateCharge();
    activatePrompt.blur();
  });
  document.body.appendChild(activatePrompt);

  // ── RAPID FIRE purchase button (top-right) ──────────────────────────────────
  // One tap = buy 60s of rapid-fire. Shows the price. Top-right keeps it clear of
  // the countdown (top-left), the mode switcher (bottom-centre) and the crosshair.
  upgradeBtn = document.createElement('button');
  upgradeBtn.id = 'upgrade-btn';
  upgradeBtn.innerHTML = `
    <div style="font-size:18px; letter-spacing:0.12em;">⚡ RAPID FIRE</div>
    <div style="font-size:12px; letter-spacing:0.16em; margin-top:5px; opacity:0.8;">${RAPID_FIRE_PRICE} sats &nbsp;·&nbsp; 60s</div>
  `;
  upgradeDefaultHTML = upgradeBtn.innerHTML; // saved so the loading state can restore it
  upgradeBtn.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    padding: 14px 22px;
    background: rgba(0,0,0,0.8);
    color: #f7931a;
    border: 1px solid #f7931a;
    font-family: monospace;
    text-align: center;
    cursor: pointer;
    text-shadow: 0 0 10px #f7931a;
    z-index: 200;
  `;

  upgradeBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the click reach the canvas shoot handler
    openChooser();       // choose: pay for this device, or for a headset's code
    upgradeBtn.blur();   // drop focus so SPACE shoots instead of re-clicking this
  });

  // No Lightning backend → no purchase path → hide the button (no dead button).
  if (!isLightningEnabled()) upgradeBtn.style.display = 'none';

  document.body.appendChild(upgradeBtn);

  // ── Balance the left HUD block against the RAPID FIRE panel ──────────────────
  // Match the left block's top + height to the panel's, so its vertically-centred
  // contents line up with the panel's centre on every viewport (desktop + mobile,
  // where the panel shifts up). Purely cosmetic positioning. Re-run on resize /
  // orientation change. Falls back to the CSS top:16 when the panel is hidden.
  const alignLeftBlockToPanel = () => {
    const r = upgradeBtn.getBoundingClientRect();
    if (r.height > 0) {                       // panel visible + laid out
      hud.style.top = `${r.top}px`;
      hud.style.height = `${r.height}px`;
    } else {                                  // panel hidden (no Lightning) → default
      hud.style.top = '16px';
      hud.style.height = '';
    }
  };
  // The panel can grow slightly after first paint (emoji/font metrics settle), so
  // trigger the align from several signals to avoid racing that first layout.
  // All are idempotent. A ResizeObserver catches the mobile breakpoint and any
  // later size change; the resize listener catches viewport moves.
  alignLeftBlockToPanel();
  requestAnimationFrame(alignLeftBlockToPanel);
  setTimeout(alignLeftBlockToPanel, 300);
  window.addEventListener('load', alignLeftBlockToPanel);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(alignLeftBlockToPanel);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(alignLeftBlockToPanel).observe(upgradeBtn);
  window.addEventListener('resize', alignLeftBlockToPanel);

  // ── On-screen SHOOT button (bottom-right) ───────────────────────────────────
  // For mouse-less / touch play. Fires through the centre crosshair — NDC (0,0) —
  // reusing the same fire path as click/tap/space, so it respects rapid-fire too.
  const shootBtn = document.createElement('button');
  shootBtn.id = 'shoot-btn';
  // Round primary button: bright cyan circle with a ◎ target icon, "SHOOT" below.
  shootBtn.innerHTML = `
    <div style="
      width: 92px; height: 92px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,229,255,0.18); border: 2px solid #00e5ff;
      box-shadow: 0 0 22px rgba(0,229,255,0.55);
    ">
      <svg width="66" height="66" viewBox="0 0 100 100" fill="none" stroke="#00e5ff"
           stroke-width="5" stroke-linecap="round" style="filter: drop-shadow(0 0 4px #00e5ff);">
        <circle cx="50" cy="50" r="15" />
        <line x1="50" y1="4"  x2="50" y2="30" />
        <line x1="50" y1="70" x2="50" y2="96" />
        <line x1="4"  y1="50" x2="30" y2="50" />
        <line x1="70" y1="50" x2="96" y2="50" />
      </svg>
    </div>
    <div style="margin-top: 6px; font-size: 13px; letter-spacing: 0.18em; color: #00e5ff; text-shadow: 0 0 8px #00e5ff;">SHOOT</div>`;
  // Bottom-right, above the mode switcher. Width = circle so it sits cleanly in
  // the corner in both portrait and landscape.
  shootBtn.style.cssText = `
    position: fixed;
    bottom: 90px;
    right: 20px;
    width: 92px;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: transparent;
    border: none;
    padding: 0;
    font-family: monospace;
    cursor: pointer;
    z-index: 200;
  `;
  shootBtn.addEventListener('click', (e) => {
    e.stopPropagation();   // don't also fire via the window tap handler
    if (onShoot) onShoot(0, 0);
    shootBtn.blur();       // drop focus so SPACE doesn't re-click this button
  });
  document.body.appendChild(shootBtn);

  buildPaymentModal();
  buildChooserPanel();
}

// ── Chooser panel: pay for THIS device, or for a VR/AR headset's code ─────────
function buildChooserPanel() {
  chooser = document.createElement('div');
  chooser.id = 'pay-chooser';
  chooser.style.cssText = `
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.9);
    z-index: 300;
    flex-direction: column; align-items: center; justify-content: center; gap: 18px;
    font-family: monospace; color: #f7931a; text-align: center; padding: 24px;
  `;

  const title = document.createElement('div');
  title.textContent = '⚡ RAPID FIRE — 21 sats';
  title.style.cssText = 'font-size: 20px; letter-spacing: 0.12em; text-shadow: 0 0 8px #f7931a;';

  // ── Choice 1: this device ──
  const thisBtn = document.createElement('button');
  thisBtn.innerHTML = `<div style="font-size:17px; letter-spacing:0.1em;">▶ PAY FOR THIS DEVICE</div>
    <div style="font-size:12px; opacity:0.75; margin-top:5px; letter-spacing:0.12em;">play right here</div>`;
  thisBtn.style.cssText = chooserBtnCss('#f7931a') + 'min-width:280px;';
  thisBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeChooser();
    purchaseRapidFire(); // existing same-device flow
  });

  // ── Divider ──
  const orLine = document.createElement('div');
  orLine.textContent = '— or —';
  orLine.style.cssText = 'font-size: 12px; opacity: 0.5; letter-spacing: 0.2em;';

  // ── Choice 2: a VR/AR headset's code ──
  const headsetLabel = document.createElement('div');
  headsetLabel.innerHTML = `Paying for a <b>VR/AR headset?</b><br>Enter the session code it's showing:`;
  headsetLabel.style.cssText = 'font-size: 14px; letter-spacing: 0.06em; line-height: 1.5; color: #00e5ff; text-shadow: 0 0 8px #00e5ff;';

  chooserInput = document.createElement('input');
  chooserInput.maxLength = 4;
  chooserInput.autocomplete = 'off';
  chooserInput.setAttribute('autocapitalize', 'characters');
  chooserInput.placeholder = 'CODE';
  chooserInput.style.cssText = `
    font-family: monospace; font-size: 24px; letter-spacing: 0.3em; text-align: center;
    text-transform: uppercase; width: 170px; padding: 10px; background: #111;
    color: #00e5ff; border: 1px solid #00e5ff; border-radius: 4px;
  `;
  chooserInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleHeadsetPay(); });

  const getInvoiceBtn = document.createElement('button');
  getInvoiceBtn.textContent = 'GET INVOICE';
  getInvoiceBtn.style.cssText = chooserBtnCss('#00e5ff');
  getInvoiceBtn.addEventListener('click', (e) => { e.stopPropagation(); handleHeadsetPay(); });

  chooserStatus = document.createElement('div');
  chooserStatus.style.cssText = 'font-size: 13px; min-height: 18px; letter-spacing: 0.06em;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'CANCEL';
  cancelBtn.style.cssText = 'margin-top:4px; padding:10px 20px; background:transparent; color:#888; border:1px solid #555; font-family:monospace; letter-spacing:0.1em; cursor:pointer;';
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closeChooser(); });

  chooser.append(title, thisBtn, orLine, headsetLabel, chooserInput, getInvoiceBtn, chooserStatus, cancelBtn);
  document.body.appendChild(chooser);
}

function chooserBtnCss(color) {
  return `padding:14px 24px; background:rgba(0,0,0,0.6); color:${color}; border:1px solid ${color};
    font-family:monospace; text-align:center; cursor:pointer; text-shadow:0 0 8px ${color};`;
}

function openChooser() {
  chooserInput.value = '';
  chooserStatus.textContent = '';
  chooser.style.display = 'flex';
}
function closeChooser() {
  chooser.style.display = 'none';
}

// Validate the entered headset code, create an invoice for IT, show the modal.
// The payer does not poll the code — the headset (which owns it) does.
async function handleHeadsetPay() {
  const code = (chooserInput.value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    chooserStatus.textContent = 'enter the 4-character code';
    chooserStatus.style.color = '#ffaa00';
    return;
  }
  chooserStatus.textContent = 'checking session…';
  chooserStatus.style.color = '#f7931a';

  if (!await validateCode(code)) {
    chooserStatus.textContent = 'session not found or expired — check the code';
    chooserStatus.style.color = '#ff4444';
    return;
  }

  chooserStatus.textContent = 'creating invoice…';
  try {
    const { payment_request } = await createInvoiceForCode(code);
    closeChooser();
    showPaymentModal(payment_request, code);
  } catch {
    chooserStatus.textContent = 'could not reach payment server — try again';
    chooserStatus.style.color = '#ff4444';
  }
}

// ── Payment modal (QR) ──────────────────────────────────────────────────────
// Shown when paying with real Lightning: QR + copyable invoice + waiting state.
function buildPaymentModal() {
  payModal = document.createElement('div');
  payModal.id = 'pay-modal';
  payModal.style.cssText = `
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.88);
    z-index: 300;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    font-family: monospace;
    color: #f7931a;
    text-align: center;
    padding: 24px;
  `;

  const title = document.createElement('div');
  title.textContent = '⚡ PAY 21 SATS';
  title.style.cssText = 'font-size: 20px; letter-spacing: 0.12em; text-shadow: 0 0 8px #f7931a;';

  payModalCode = document.createElement('div');
  payModalCode.style.cssText = 'font-size: 12px; letter-spacing: 0.18em; opacity: 0.7;';

  // White card behind the QR so it scans reliably.
  const qrCard = document.createElement('div');
  qrCard.style.cssText = 'background:#fff; padding:12px; border-radius:6px; line-height:0;';
  payModalQr = document.createElement('img');
  payModalQr.width = 240;
  payModalQr.height = 240;
  payModalQr.alt = 'Lightning invoice QR';
  qrCard.appendChild(payModalQr);

  // Open in Wallet — a lightning: link so a phone opens its wallet directly
  // (attendees on a single phone can't scan their own screen).
  payModalOpenLink = document.createElement('a');
  payModalOpenLink.textContent = '⚡ OPEN IN WALLET';
  payModalOpenLink.style.cssText = `
    display: inline-block; padding: 14px 26px; background: #f7931a; color: #000;
    font-family: monospace; font-size: 16px; font-weight: bold; letter-spacing: 0.08em;
    text-decoration: none; border-radius: 4px; cursor: pointer;
  `;
  payModalOpenLink.addEventListener('click', (e) => e.stopPropagation());

  // Copy invoice — fallback for pasting into a wallet manually.
  payModalCopyBtn = document.createElement('button');
  payModalCopyBtn.textContent = 'COPY INVOICE';
  payModalCopyBtn.style.cssText = `
    padding: 10px 20px; background: transparent; color: #f7931a;
    border: 1px solid #f7931a; font-family: monospace; letter-spacing: 0.1em; cursor: pointer;
  `;
  payModalCopyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(currentInvoice);
      payModalCopyBtn.textContent = '✓ COPIED';
      setTimeout(() => { payModalCopyBtn.textContent = 'COPY INVOICE'; }, 1500);
    } catch {
      payModalCopyBtn.textContent = 'COPY FAILED';
    }
    payModalCopyBtn.blur();
  });

  payModalStatus = document.createElement('div');
  payModalStatus.textContent = '⏳ waiting for payment…';
  payModalStatus.style.cssText = 'font-size: 14px; letter-spacing: 0.08em;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'CANCEL';
  cancelBtn.style.cssText = `
    margin-top: 6px; padding: 10px 20px; background: transparent;
    color: #888; border: 1px solid #555; font-family: monospace;
    letter-spacing: 0.1em; cursor: pointer;
  `;
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closePaymentModal(); cancelBtn.blur(); });

  payModal.append(title, payModalCode, qrCard, payModalOpenLink, payModalCopyBtn, payModalStatus, cancelBtn);
  document.body.appendChild(payModal);
}

async function showPaymentModal(invoice, code = getSessionCode()) {
  currentInvoice = invoice;
  payModalCode.textContent = code ? `session ${code}` : '';
  payModalStatus.textContent = '⏳ waiting for payment…';
  payModalStatus.style.color = '#f7931a';
  // lightning: URI uses the canonical lowercase invoice; tapping opens the wallet.
  payModalOpenLink.href = `lightning:${invoice}`;
  payModalCopyBtn.textContent = 'COPY INVOICE';
  payModal.style.display = 'flex';

  try {
    // Uppercase the bech32 invoice for QR alphanumeric mode → less dense, easier scan.
    payModalQr.src = await QRCode.toDataURL(invoice.toUpperCase(), { margin: 1, width: 240 });
  } catch {
    payModalStatus.textContent = 'could not render QR — use Open in Wallet or Copy';
  }
}

function closePaymentModal() {
  payModal.style.display = 'none';
}

// ── purchaseRapidFire ───────────────────────────────────────────────────────
// One path everywhere: create a 21-sat invoice → show the QR → wait. The poll
// detects payment, closes the modal, and banks a charge to ACTIVATE. There is no
// auto-fire — paying never starts rapid-fire directly; activation does.
async function purchaseRapidFire() {
  if (purchasing) return; // already creating an invoice — ignore repeat taps

  setUpgradeLoading(true); // immediate feedback while the invoice is created (~2-3s)
  try {
    const { payment_request } = await createInvoice();
    setUpgradeLoading(false);
    showPaymentModal(payment_request);
  } catch (err) {
    console.warn('purchase failed', err);
    setUpgradeLoading(false);
    payModal.style.display = 'flex';
    payModalStatus.textContent = 'could not reach payment server — try again';
    payModalStatus.style.color = '#ff4444';
  }
}

// ── charge API (used by the DOM prompt and the in-world VR panel) ────────────
/** Banked, not-yet-activated charges. */
export function getAvailableCharges() {
  return Math.max(0, getPaidCount() - activatedCount);
}

// Consume one banked charge → start rapid-fire. grantRapidFire() stays the single
// entry point. activatedCount is persisted so a reload can't re-grant the same charge.
export function activateCharge() {
  if (getAvailableCharges() <= 0) return;
  activatedCount += 1;
  saveActivated();
  grantRapidFire();
  playReloadSound();
}

// Show/hide the flat DOM score. vrui.js drives this so exactly ONE score shows
// per device: the DOM score for flat + handheld-phone AR, or the in-world 3D
// score for headset VR/AR (never both). The score keeps updating while hidden.
export function setHudScoreVisible(visible) {
  if (scoreEl) scoreEl.style.display = visible ? '' : 'none';
}

// ── updateRapidFireHUD ──────────────────────────────────────────────────────
// Called every frame from main.js. Shows/hides the countdown and toggles the
// upgrade button's active glow. Only re-renders text when the second changes.
export function updateRapidFireHUD() {
  const active = isRapidFire();

  // SCORE — only re-render the text when it actually changes.
  const score = getScore();
  if (score !== lastShownScore) {
    lastShownScore = score;
    scoreEl.textContent = `SCORE ${score}`;
  }

  upgradeBtn.classList.toggle('active', active);

  if (active) {
    const secs = getRemainingSeconds();
    if (secs !== lastShownSecond) {
      lastShownSecond = secs;
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, '0');
      countdownEl.textContent = `▶ RAPID FIRE ${m}:${s}`;
    }
    countdownEl.style.display = 'block';
  } else if (lastShownSecond !== -1) {
    // Just expired — hide once.
    lastShownSecond = -1;
    countdownEl.style.display = 'none';
  }

  // ── Session code + charge model (Lightning only) ───────────────────────────
  if (!isLightningEnabled()) return;

  const code = getSessionCode();
  if (code && code !== shownCode) {
    shownCode = code;
    loadActivated(code);          // restore banked-vs-activated for this code
    lastPaid = getPaidCount();    // baseline so we don't flash "paid" for old payments
    codeEl.textContent = `SESSION ${code}`;
    codeEl.style.display = 'block';
  }
  if (!code) return;

  // A fresh payment arrived → close the pay-QR modal (if the player paid here).
  const paid = getPaidCount();
  if (paid > lastPaid) {
    lastPaid = paid;
    closePaymentModal();
  }

  // Banked, unactivated charges → show the ACTIVATE prompt (unless already firing).
  const available = paid - activatedCount;
  if (available > 0 && !active) {
    activatePrompt.textContent = available > 1
      ? `✓ PAID ×${available} — ACTIVATE RAPID FIRE`
      : '✓ PAID — ACTIVATE RAPID FIRE';
    activatePrompt.style.display = 'block';
  } else {
    activatePrompt.style.display = 'none';
  }
}
