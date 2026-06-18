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

const SUPABASE_URL      = 'https://qasopfvcdyikqxbniyqn.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhc29wZnZjZHlpa3F4Ym5peXFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTAyMDEwNjgsImV4cCI6MjA2NTc3NzA2OH0.' +
  'RrJXJCpj1r-blOsOJ2n-P0IYS0p3Z0cWAnl2Y-jC29o';

// ─── Module state ─────────────────────────────────────────────────────────────

const mp = {
  active:          false,  // online mode is on
  isHost:          false,  // true = player 1 (created room)
  roomCode:        null,
  channel:         null,   // Supabase RealtimeChannel
  client:          null,
  opponentPresent: false,
  myColor:         null,   // 1 or 2
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function channelName(code) {
  return `sambaqui-room-${code}`;
}

function log(...args) { console.log('[MP]', ...args); }

// ─── Supabase init ────────────────────────────────────────────────────────────

async function initSupabase() {
  if (mp.client) return mp.client;
  if (!window.supabase) {
    throw new Error('Supabase JS not loaded. Check network / CDN.');
  }
  mp.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return mp.client;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setMpStatus(msg, color) {
  // Update the panel status line if open, otherwise use the game status bar
  const el = document.getElementById('mp-status-line');
  if (el) { el.textContent = msg; if (color) el.style.color = color; }
}

function showPanel() {
  if (document.getElementById('mp-panel')) return;
  document.body.insertAdjacentHTML('beforeend', buildPanelHTML());
  bindPanelEvents();
}

function hidePanel() {
  document.getElementById('mp-panel')?.remove();
}

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

    <!-- Lobby screen -->
    <div id="mp-lobby" style="display:flex; flex-direction:column; gap:.9rem;">
      <button id="mp-create-btn" class="generic-btn"
        style="width:100%; font-size:1rem; padding:.7rem 1rem;">
        Criar Sala &nbsp;·&nbsp; Create Room
      </button>
      <div style="display:flex; gap:.5rem; align-items:stretch;">
        <input id="mp-code-input" maxlength="6"
          placeholder="CÓDIGO · CODE"
          style="
            flex:1; background:rgba(72,49,2,.5); border:1px solid var(--accent);
            border-radius:6px; color:var(--sand); padding:.55rem .75rem;
            font-family:'Lato',serif; font-size:.9rem; letter-spacing:.2em;
            text-transform:uppercase; outline:none; min-width:0;
          "
        />
        <button id="mp-join-btn" class="generic-btn"
          style="white-space:nowrap; padding:.55rem 1rem; flex-shrink:0;">
          Entrar · Join
        </button>
      </div>
      <p id="mp-status-line"
        style="font-size:.75rem; letter-spacing:.1em; color:var(--sand3);
               min-height:1.1em; text-align:center; margin:0;"></p>
    </div>

    <!-- Waiting screen (hidden initially) -->
    <div id="mp-waiting" style="display:none; flex-direction:column; gap:1rem; align-items:center;">
      <p style="color:var(--sand); font-size:.9rem; letter-spacing:.06em;
                text-align:center; margin:0; line-height:1.5;">
        Compartilhe com seu oponente<br>
        <span style="font-size:.75rem; color:var(--sand3);">Share with your opponent</span>
      </p>
      <div id="mp-code-display" style="
        font-size:2.4rem; letter-spacing:.35em; color:var(--gold);
        font-family:'Molle',cursive; text-align:center;
        background:rgba(196,154,68,.07); border:1px solid rgba(196,154,68,.3);
        border-radius:8px; padding:.5rem 1.4rem; cursor:pointer; user-select:all;
      " title="Clique para copiar · Click to copy"></div>
      <p style="font-size:.68rem; color:var(--sand3); letter-spacing:.1em;
                text-align:center; margin:0;">clique para copiar · click to copy</p>
      <p id="mp-status-line"
        style="font-size:.78rem; letter-spacing:.1em; color:var(--sand3);
               min-height:1.2em; text-align:center; margin:0;">
        Aguardando oponente… / Waiting for opponent…
      </p>
      <button id="mp-cancel-btn" class="generic-btn danger"
        style="font-size:.78rem; padding:.4rem 1.1rem;">
        Cancelar · Cancel
      </button>
    </div>

  </div>
</div>`;
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

  // Click the code display to copy it
  document.getElementById('mp-code-display')
    ?.addEventListener('click', () => {
      const code = document.getElementById('mp-code-display')?.textContent;
      if (code) navigator.clipboard.writeText(code).catch(() => {});
    });
}

function switchToWaitingScreen(code) {
  document.getElementById('mp-lobby').style.display  = 'none';
  const waiting = document.getElementById('mp-waiting');
  waiting.style.display = 'flex';
  const display = document.getElementById('mp-code-display');
  if (display) display.textContent = code;
}

// ─── Online button injection ──────────────────────────────────────────────────

function injectOnlineButton() {
  if (document.getElementById('mp-online-btn')) return;
  const modeBar = document.querySelector('.mode-bar');
  if (!modeBar) return;

  const btn = document.createElement('button');
  btn.id        = 'mp-online-btn';
  btn.className = 'mode-btn';
  btn.textContent = 'Online';
  btn.addEventListener('click', onOnlineBtnClick);
  modeBar.appendChild(btn);
}

function onOnlineBtnClick() {
  if (mp.active) {
    const leave = confirm(
      'Sair do jogo online?\nLeave the online game?'
    );
    if (leave) fullDisconnect();
  } else {
    showPanel();
  }
}

function setOnlineBtnActive(code) {
  const btn = document.getElementById('mp-online-btn');
  if (!btn) return;
  btn.classList.add('active');
  btn.textContent = `Online · ${code}`;
}

function resetOnlineBtn() {
  const btn = document.getElementById('mp-online-btn');
  if (!btn) return;
  btn.classList.remove('active');
  btn.textContent = 'Online';
}

// ─── Panel button handlers ────────────────────────────────────────────────────

function onClosePanelBtn() {
  hidePanel();
  // If we were waiting for an opponent, clean up the channel
  if (mp.channel && !mp.opponentPresent) {
    mp.channel.unsubscribe();
    mp.channel = null;
    mp.active  = false;
    mp.roomCode = null;
    resetOnlineBtn();
  }
}

function onCancelWait() {
  hidePanel();
  if (mp.channel) {
    mp.channel.unsubscribe();
    mp.channel = null;
  }
  mp.active   = false;
  mp.roomCode = null;
  resetOnlineBtn();
}

async function onCreateRoom() {
  setMpStatus('Criando sala… / Creating room…');
  try {
    await initSupabase();
  } catch (err) {
    setMpStatus('Erro ao carregar Supabase · ' + err.message, '#c0704a');
    return;
  }

  const code   = randomCode();
  mp.isHost    = true;
  mp.roomCode  = code;
  mp.myColor   = 1;
  mp.active    = true;

  switchToWaitingScreen(code);
  subscribeChannel(code, () => {
    log(`Room ${code} created, waiting for opponent`);
  });
}

async function onJoinRoom() {
  const raw  = document.getElementById('mp-code-input')?.value || '';
  const code = raw.trim().toUpperCase();

  if (code.length < 4) {
    setMpStatus('Digite um código válido · Enter a valid code', '#c0704a');
    return;
  }

  setMpStatus('Conectando… / Connecting…');
  try {
    await initSupabase();
  } catch (err) {
    setMpStatus('Erro ao carregar Supabase · ' + err.message, '#c0704a');
    return;
  }

  mp.isHost   = false;
  mp.roomCode = code;
  mp.myColor  = 2;
  mp.active   = true;

  subscribeChannel(code, () => {
    log(`Joined room ${code}, announcing presence`);
    mp.channel.send({
      type:    'broadcast',
      event:   'player_joined',
      payload: { color: 2 },
    });
  });
}

// ─── Supabase channel ─────────────────────────────────────────────────────────

function subscribeChannel(code, onSubscribed) {
  const ch = mp.client.channel(channelName(code), {
    config: { broadcast: { self: false } },
  });

  // Opponent arrived
  ch.on('broadcast', { event: 'player_joined' }, ({ payload }) => {
    log('player_joined received', payload);
    mp.opponentPresent = true;
    onBothPlayersReady();
  });

  // Incoming move
  ch.on('broadcast', { event: 'move' }, ({ payload }) => {
    applyRemoteMove(payload);
  });

  // Opponent restarted (new game)
  ch.on('broadcast', { event: 'restart' }, () => {
    log('Remote restart received');
    window.restartGame(true);
  });

  ch.subscribe(status => {
    log('Channel status:', status);
    if (status === 'SUBSCRIBED') {
      mp.channel = ch;
      if (onSubscribed) onSubscribed();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      setMpStatus('Erro de conexão · Connection error', '#c0704a');
    }
  });
}

// ─── Game start ───────────────────────────────────────────────────────────────

function onBothPlayersReady() {
  hidePanel();
  setOnlineBtnActive(mp.roomCode);
  // Set global flags used by the game turn guard
  window.mpOnline = true;
  window.mpMyColor = mp.myColor;
  // Activate online mode inside the game (closes over the let variables)
  window.mpActivate(mp.myColor);
  log(`Game started as player ${mp.myColor}`);
}

// ─── Move broadcasting ────────────────────────────────────────────────────────

function broadcastMove(fromLabel, landingLabel) {
  if (!mp.active || !mp.channel) return;
  log(`Broadcasting move ${fromLabel}→${landingLabel}`);
  mp.channel.send({
    type:    'broadcast',
    event:   'move',
    payload: { from: fromLabel, to: landingLabel, color: mp.myColor },
  });
}

function broadcastRestart() {
  if (!mp.active || !mp.channel) return;
  mp.channel.send({
    type:    'broadcast',
    event:   'restart',
    payload: { by: mp.myColor },
  });
}

// ─── Apply remote move ────────────────────────────────────────────────────────

function applyRemoteMove({ from, to, color }) {
  if (color === mp.myColor) return; // shouldn't happen (self:false), but guard
  log(`Received move ${from}→${to} from player ${color}`);

  const slides = window.computeAllSlides(from, window.state.pieces);
  const match  = slides.find(s => s.landing === to);

  if (!match) {
    log('WARNING: received move has no matching slide — possible desync');
    return;
  }

  window.executeMove(from, match);
}

// ─── Full disconnect ──────────────────────────────────────────────────────────

function fullDisconnect() {
  if (mp.channel) {
    mp.channel.unsubscribe();
    mp.channel = null;
  }
  mp.active          = false;
  mp.opponentPresent = false;
  mp.roomCode        = null;
  mp.myColor         = null;

  resetOnlineBtn();
  // Clear online flags
  window.mpOnline  = false;
  window.mpMyColor = null;
  // Return to vs-AI mode
  window.vsAI             = true;
  window.humanPlayerColor = 1;
  window.restartGame(true);
  log('Disconnected');
}

// ─── Patch executeMove to capture outgoing moves ──────────────────────────────
// We wrap the game's executeMove. When it's our turn in multiplayer mode,
// we capture the (from, landing) pair and broadcast it.

function patchGameFunctions() {
  // executeMove
  const origExecuteMove = window.executeMove;
  if (!origExecuteMove) {
    console.error('[MP] window.executeMove not found — cannot patch');
    return;
  }
  window.executeMove = function(fromLabel, move) {
    const isMyTurn =
      mp.active &&
      window.state.currentPlayer === mp.myColor;
    // Broadcast first (before animation starts) so opponent gets it ASAP
    if (isMyTurn) broadcastMove(fromLabel, move.landing);
    origExecuteMove.call(this, fromLabel, move);
  };

  // restartGame — broadcast when host deliberately restarts
  const origRestart = window.restartGame;
  window.restartGame = function(forceResetColor) {
    origRestart.call(this, forceResetColor);
    if (mp.active && forceResetColor) broadcastRestart();
  };

  log('Game functions patched');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  injectOnlineButton();
  patchGameFunctions();
  log('Multiplayer module ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  setTimeout(boot, 0);
}