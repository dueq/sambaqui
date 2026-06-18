/**
 * Sambaqui – Online Multiplayer Module v1.0
 *
 * Architecture
 * ────────────
 * • Supabase Realtime Broadcast channel — no DB writes needed for live play.
 * • Room codes: 6-char alphanumeric, used as the channel name suffix.
 * • Player 1 (room creator) plays light pieces; Player 2 (joiner) plays dark.
 * • Move authority: the player whose turn it is executes locally, then
 *   broadcasts (from, to). The opponent receives and replays identically.
 * • Chain moves, passes, and game-over are handled by the shared game logic
 *   running on both clients — they stay in sync because they start from the
 *   same initial state and apply identical deterministic moves.
 *
 * Integration points (must exist on window, set by the game's MP bridge)
 * ────────────────────────────────────────────────────────────────────────
 *   window.state            — live game state object
 *   window.vsAI             — getter/setter into closed-over let vsAI
 *   window.humanPlayerColor — getter/setter into closed-over let
 *   window.executeMove(from, moveObj)
 *   window.computeAllSlides(from, pieces)
 *   window.setStatus(msg, variant)
 *   window.restartGame(forceResetColor)
 *   window.mpActivate(myColor) — sets vsAI=false, humanPlayerColor=myColor, restarts
 */

'use strict';

// ─── Supabase config ─────────────────────────────────────────────────────────
// IMPORTANT: Replace SUPABASE_ANON_KEY with your project's real anon/public key.
// Find it at: Supabase Dashboard → Project Settings → API → Project API keys → anon public

const SUPABASE_URL      = 'https://qasopfvcdyikqxbniyqn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhc29wZnZjZHlpa3F4Ym5peXFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MzUwMDAsImV4cCI6MjA5NzMxMTAwMH0.MIiyCiRC09kC2hFA-h5-HoNJZGBAhHxoHUPchUB2VKE';

// ─── Module state ─────────────────────────────────────────────────────────────

const mp = {
  active:          false,
  isHost:          false,
  roomCode:        null,
  channel:         null,
  client:          null,
  opponentPresent: false,
  myColor:         null,   // 1 = light, 2 = dark
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function channelName(code) {
  return `sambaqui-room-${code}`;
}

function log(...args) { console.log('[MP]', ...args); }

// ─── Status helpers ───────────────────────────────────────────────────────────

/** Update whichever #mp-status-line is currently in the DOM */
function setMpStatus(msg, color) {
  const el = document.getElementById('mp-status-line');
  if (!el) return;
  el.textContent = msg;
  if (color) el.style.color = color;
}

function setMpError(msg) {
  setMpStatus(msg, '#c0704a');
  log('ERROR:', msg);
}

// ─── Supabase init ────────────────────────────────────────────────────────────

async function initSupabase() {
  if (mp.client) return mp.client;

  if (!window.supabase) {
    throw new Error(
      'Supabase JS not loaded. Check that the CDN <script> tag in sambaqui.html is reachable.'
    );
  }

  if (SUPABASE_ANON_KEY === 'REPLACE_WITH_YOUR_ANON_KEY') {
    throw new Error(
      'Anon key not set. Open multiplayer.js and replace SUPABASE_ANON_KEY ' +
      'with the value from your Supabase dashboard → Project Settings → API.'
    );
  }

  mp.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: {
      params: { eventsPerSecond: 20 },
    },
  });
  return mp.client;
}

// ─── Panel HTML ───────────────────────────────────────────────────────────────

function buildPanelHTML() {
  return `
<div id="mp-panel" style="
  position:fixed; inset:0; z-index:200;
  background:rgba(10,6,3,0.92);
  display:flex; align-items:center; justify-content:center;
  font-family:'Lato',serif; animation:fade-in .3s ease;
">
  <div style="
    background:#241a12; border:2px solid var(--accent); border-radius:10px;
    width:90%; max-width:360px; padding:1.8rem 2rem;
    box-shadow:0 10px 40px rgba(0,0,0,.85);
    display:flex; flex-direction:column; gap:1.2rem;
  ">

    <!-- Header -->
    <div style="display:flex; justify-content:space-between; align-items:center;
                border-bottom:1px solid rgba(122,79,46,.35); padding-bottom:.6rem;">
      <span style="color:var(--gold); font-size:1.3rem; font-weight:700; letter-spacing:.06em;">Online</span>
      <button id="mp-close-btn" style="background:none; border:none; color:var(--sand3);
        font-size:1.3rem; cursor:pointer; line-height:1; padding:.2rem .4rem;"
        title="Fechar / Close">✕</button>
    </div>

    <!-- Lobby screen (shown first) -->
    <div id="mp-lobby" style="display:flex; flex-direction:column; gap:.9rem;">
      <button id="mp-create-btn" class="generic-btn"
        style="width:100%; font-size:1rem; padding:.7rem 1rem;">
        Criar Sala
      </button>
      <div style="display:flex; gap:.5rem; align-items:stretch;">
        <input id="mp-code-input" maxlength="6"
          placeholder="CÓDIGO"
          style="
            flex:1; background:rgba(72,49,2,.5); border:1px solid var(--accent);
            border-radius:6px; color:var(--sand); padding:.55rem .75rem;
            font-family:'Lato',serif; font-size:.9rem; letter-spacing:.2em;
            text-transform:uppercase; outline:none; min-width:0;
          "
        />
        <button id="mp-join-btn" class="generic-btn"
          style="white-space:nowrap; padding:.55rem 1rem; flex-shrink:0;">
          Entrar
        </button>
      </div>
      <!-- Single status line for lobby screen -->
      <p id="mp-status-line"
        style="font-size:.75rem; letter-spacing:.1em; color:var(--sand3);
               min-height:1.1em; text-align:center; margin:0;"></p>
    </div>

    <!-- Waiting screen (hidden until room created) -->
    <div id="mp-waiting" style="display:none; flex-direction:column; gap:1rem; align-items:center;">
      <p style="color:var(--sand); font-size:.9rem; letter-spacing:.06em;
                text-align:center; margin:0; line-height:1.5;">
        Compartilhe com seu oponente<br>
        <span style="font-size:.75rem; color:var(--sand3);"></span>
      </p>
      <div id="mp-code-display" style="
        font-size:2.4rem; letter-spacing:.35em; color:var(--gold);
        font-family:'Molle',cursive; text-align:center;
        background:rgba(196,154,68,.07); border:1px solid rgba(196,154,68,.3);
        border-radius:8px; padding:.5rem 1.4rem; cursor:pointer; user-select:all;
      " title="Clique para copiar"></div>
      <p style="font-size:.68rem; color:var(--sand3); letter-spacing:.1em;
                text-align:center; margin:0;">clique para copiar</p>
      <!-- Separate status line for waiting screen — different ID to avoid clash -->
      <p id="mp-wait-status-line"
        style="font-size:.78rem; letter-spacing:.1em; color:var(--sand3);
               min-height:1.2em; text-align:center; margin:0;">
        Aguardando oponente…
      </p>
      <button id="mp-cancel-btn" class="generic-btn danger"
        style="font-size:.78rem; padding:.4rem 1.1rem;">
        Cancelar · Cancel
      </button>
    </div>

  </div>
</div>`;
}

// ─── Status helpers (screen-aware) ───────────────────────────────────────────

/** Update the visible status line regardless of which screen is showing */
function setAnyStatus(msg, color) {
  // Try both status line IDs — only one will be visible at a time
  ['mp-status-line', 'mp-wait-status-line'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; if (color) el.style.color = color; }
  });
}

function setAnyError(msg) {
  setAnyStatus(msg, '#c0704a');
  log('ERROR:', msg);
}

// ─── Panel lifecycle ──────────────────────────────────────────────────────────

function showPanel() {
  if (document.getElementById('mp-panel')) return;
  document.body.insertAdjacentHTML('beforeend', buildPanelHTML());
  bindPanelEvents();
}

function hidePanel() {
  document.getElementById('mp-panel')?.remove();
}

function switchToWaitingScreen(code) {
  const lobby   = document.getElementById('mp-lobby');
  const waiting = document.getElementById('mp-waiting');
  if (lobby)   lobby.style.display   = 'none';
  if (waiting) waiting.style.display = 'flex';
  const display = document.getElementById('mp-code-display');
  if (display) display.textContent   = code;
}

function bindPanelEvents() {
  document.getElementById('mp-close-btn')
    ?.addEventListener('click', onClosePanelBtn);
  document.getElementById('mp-create-btn')
    ?.addEventListener('click', onCreateRoom);
  document.getElementById('mp-join-btn')
    ?.addEventListener('click', onJoinRoom);
  document.getElementById('mp-cancel-btn')
    ?.addEventListener('click', onCancelWait);
  document.getElementById('mp-code-input')
    ?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('mp-join-btn')?.click();
    });
  document.getElementById('mp-code-display')
    ?.addEventListener('click', () => {
      const txt = document.getElementById('mp-code-display')?.textContent;
      if (txt) navigator.clipboard.writeText(txt).catch(() => {});
    });
}

// ─── Online button ────────────────────────────────────────────────────────────

function injectOnlineButton() {
  if (document.getElementById('mp-online-btn')) return;
  const modeBar = document.querySelector('.mode-bar');
  if (!modeBar) { log('WARNING: .mode-bar not found'); return; }

  const btn       = document.createElement('button');
  btn.id          = 'mp-online-btn';
  btn.className   = 'mode-btn';
  btn.textContent = 'Online';
  btn.addEventListener('click', onOnlineBtnClick);
  modeBar.appendChild(btn);
}

function onOnlineBtnClick() {
  if (mp.active) {
    if (confirm('Sair do jogo online?\nLeave the online game?')) fullDisconnect();
  } else {
    showPanel();
  }
}

function setOnlineBtnActive(code) {
  const btn = document.getElementById('mp-online-btn');
  if (btn) { btn.classList.add('active'); btn.textContent = `Online · ${code}`; }
}

function resetOnlineBtn() {
  const btn = document.getElementById('mp-online-btn');
  if (btn) { btn.classList.remove('active'); btn.textContent = 'Online'; }
}

// ─── Panel button handlers ────────────────────────────────────────────────────

function onClosePanelBtn() {
  hidePanel();
  if (mp.channel && !mp.opponentPresent) {
    mp.channel.unsubscribe();
    mp.channel  = null;
    mp.active   = false;
    mp.roomCode = null;
    resetOnlineBtn();
  }
}

function onCancelWait() {
  hidePanel();
  if (mp.channel) { mp.channel.unsubscribe(); mp.channel = null; }
  mp.active   = false;
  mp.roomCode = null;
  resetOnlineBtn();
}

async function onCreateRoom() {
  setAnyStatus('Criando sala… / Creating room…');
  try { await initSupabase(); }
  catch (err) { setAnyError(err.message); return; }

  const code   = randomCode();
  mp.isHost    = true;
  mp.roomCode  = code;
  mp.myColor   = 1;
  mp.active    = true;

  switchToWaitingScreen(code);
  subscribeChannel(code, () => log(`Room ${code} ready, waiting for opponent`));
}

async function onJoinRoom() {
  const code = (document.getElementById('mp-code-input')?.value || '')
    .trim().toUpperCase();

  if (code.length < 4) {
    setAnyError('Digite um código válido · Enter a valid code');
    return;
  }

  setAnyStatus('Conectando… / Connecting…');
  try { await initSupabase(); }
  catch (err) { setAnyError(err.message); return; }

  mp.isHost   = false;
  mp.roomCode = code;
  mp.myColor  = 2;
  mp.active   = true;

  subscribeChannel(code, () => {
    log(`Joined room ${code}, announcing presence`);
    mp.channel.send({
      type: 'broadcast', event: 'player_joined', payload: { color: 2 },
    });
  });
}

// ─── Supabase Realtime channel ────────────────────────────────────────────────

function subscribeChannel(code, onSubscribed) {
  const ch = mp.client.channel(channelName(code), {
    config: { broadcast: { self: false, ack: false } },
  });

  ch.on('broadcast', { event: 'player_joined' }, ({ payload }) => {
    log('player_joined', payload);
    // Only the host handles this — it sends back game_start with color assignments
    if (!mp.isHost) return;
    mp.opponentPresent = true;
    // Tell Player 2 their assigned color and that we're ready
    ch.send({
      type: 'broadcast', event: 'game_start',
      payload: { hostColor: 1, joinerColor: 2 },
    });
    // Host starts immediately
    onBothPlayersReady();
  });

  ch.on('broadcast', { event: 'game_start' }, ({ payload }) => {
    log('game_start received', payload);
    // Host sent this — should not receive it back (self:false), but guard anyway
    if (mp.isHost) return;
    // Use the server-assigned color rather than what we set locally
    mp.myColor = payload.joinerColor ?? 2;
    mp.opponentPresent = true;
    onBothPlayersReady();
  });

  ch.on('broadcast', { event: 'move' }, ({ payload }) => {
    applyRemoteMove(payload);
  });

  ch.on('broadcast', { event: 'restart' }, () => {
    log('Remote restart');
    window.restartGame(true);
  });

  ch.subscribe((status, err) => {
    log('Channel status:', status, err || '');

    if (status === 'SUBSCRIBED') {
      mp.channel = ch;
      if (onSubscribed) onSubscribed();

    } else if (status === 'CHANNEL_ERROR') {
      const detail = err?.message || 'unknown error';
      setAnyError(`Erro de canal: ${detail}`);
      log('Channel error detail:', err);

    } else if (status === 'TIMED_OUT') {
      setAnyError('Tempo esgotado. Verifique sua conexão · Timed out');

    } else if (status === 'CLOSED') {
      if (mp.active) setAnyError('Conexão encerrada · Connection closed');
    }
  });
}

// ─── Game start ───────────────────────────────────────────────────────────────

function onBothPlayersReady() {
  hidePanel();
  setOnlineBtnActive(mp.roomCode);
  window.mpOnline  = true;
  window.mpMyColor = mp.myColor;
  window.mpActivate(mp.myColor);
  log(`Game started as player ${mp.myColor}`);
}

// ─── Broadcast outgoing move ──────────────────────────────────────────────────

function broadcastMove(fromLabel, landingLabel) {
  if (!mp.active || !mp.channel) return;
  log(`→ move ${fromLabel}→${landingLabel}`);
  mp.channel.send({
    type: 'broadcast', event: 'move',
    payload: { from: fromLabel, to: landingLabel, color: mp.myColor },
  });
}

function broadcastRestart() {
  if (!mp.active || !mp.channel) return;
  mp.channel.send({ type: 'broadcast', event: 'restart', payload: {} });
}

// ─── Apply remote move ────────────────────────────────────────────────────────

function applyRemoteMove({ from, to, color }) {
  if (color === mp.myColor) return;
  log(`← move ${from}→${to} from player ${color}`);

  const slides = window.computeAllSlides(from, window.state.pieces);
  const match  = slides.find(s => s.landing === to);

  if (!match) {
    log('WARNING: no matching slide for received move — possible desync');
    return;
  }

  window.executeMove(from, match);
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

function fullDisconnect() {
  if (mp.channel) { mp.channel.unsubscribe(); mp.channel = null; }
  mp.active          = false;
  mp.opponentPresent = false;
  mp.roomCode        = null;
  mp.myColor         = null;

  window.mpOnline  = false;
  window.mpMyColor = null;
  resetOnlineBtn();

  window.vsAI             = true;
  window.humanPlayerColor = 1;
  window.restartGame(true);
  log('Disconnected');
}

// ─── Patch game functions ─────────────────────────────────────────────────────

function patchGameFunctions() {
  // 1. Wrap executeMove to broadcast our moves
  const origExecuteMove = window.executeMove;
  if (!origExecuteMove) {
    console.error('[MP] window.executeMove not found on window — bridge missing?');
    return;
  }
  window.executeMove = function(fromLabel, move) {
    const myTurn = mp.active && window.state.currentPlayer === mp.myColor;
    if (myTurn) broadcastMove(fromLabel, move.landing);
    origExecuteMove.call(this, fromLabel, move);
  };

  // 2. Wrap restartGame to broadcast restarts in online mode
  const origRestart = window.restartGame;
  window.restartGame = function(forceResetColor) {
    origRestart.call(this, forceResetColor);
    // Only broadcast deliberate restarts (forceResetColor=true) and not the
    // internal restart triggered by mpActivate itself
    if (mp.active && forceResetColor && mp.opponentPresent) broadcastRestart();
  };

  log('Game functions patched');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  injectOnlineButton();
  patchGameFunctions();
  log('Multiplayer module ready — open console for [MP] logs');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  setTimeout(boot, 0);
}
