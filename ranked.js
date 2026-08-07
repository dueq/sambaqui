/**
 * Sambaqui – Ranked Mode
 * 
 * Adds a new game mode where the player competes for a local Elo rating
 * against fixed-Elo AI profiles.
 */
(function() {
'use strict';

// ─── AI Profiles (Calibrated) ────────────────────────────────────────────────
const RANKED_PROFILES = [
  { id: 1, iterations: 2,    tacticalAcuity: 0.0, temperature: 2.0, elo: 600 },
  { id: 2, iterations: 4,    tacticalAcuity: 0.1, temperature: 1.9, elo: 700 },
  { id: 3, iterations: 16,   tacticalAcuity: 0.2, temperature: 1.6, elo: 800 },
  { id: 4, iterations: 32,   tacticalAcuity: 0.3, temperature: 1.4, elo: 900 },
  { id: 5, iterations: 192,  tacticalAcuity: 0.6, temperature: 0.9, elo: 1000 },
  { id: 6, iterations: 256,  tacticalAcuity: 0.6, temperature: 0.8, elo: 1100 },
  { id: 7, iterations: 512,  tacticalAcuity: 0.7, temperature: 0.6, elo: 1200 },
  { id: 8, iterations: 1024, tacticalAcuity: 0.8, temperature: 0.4, elo: 1300 },
  { id: 9, iterations: 2048, tacticalAcuity: 0.9, temperature: 0.2, elo: 1400 }
];

const STORAGE_KEY = 'sambaqui_ranked_state';

// ─── State Management ────────────────────────────────────────────────────────
let rankedState = { elo: 1000, games: 0 };
let activeRankedOpponent = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) rankedState = JSON.parse(raw);
  } catch (e) {
    console.warn('[RANKED] Failed to load state, starting fresh.');
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rankedState));
  updateMenuDisplay();
}

// ─── Elo Math ────────────────────────────────────────────────────────────────
function getExpectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function getKFactor(gamesPlayed) {
  if (gamesPlayed < 30) return 40;
  if (gamesPlayed < 100) return 20;
  return 10;
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────
function findOpponent(playerElo) {
  // Find the AI profile closest to the player's current Elo
  return RANKED_PROFILES.reduce((prev, curr) => {
    return (Math.abs(curr.elo - playerElo) < Math.abs(prev.elo - playerElo) ? curr : prev);
  });
}

// ─── Game Hooks ──────────────────────────────────────────────────────────────
function startRankedGame() {
  activeRankedOpponent = findOpponent(rankedState.elo);
  
  // Intercept the engine's difficulty profile requester
  const origGetDifficultyProfile = window.getDifficultyProfile;
  window.getDifficultyProfile = function() {
    if (activeRankedOpponent) {
      return {
        tacticalAcuity: activeRankedOpponent.tacticalAcuity,
        temperature: activeRankedOpponent.temperature,
        mctsIterations: activeRankedOpponent.iterations
      };
    }
    return origGetDifficultyProfile(); // Fallback to standard mode
  };

  // Setup the game environment
  window.vsAI = true;
  window.restartGame(true);
  
  const myColor = Math.random() < 0.5 ? 1 : 2;
  window.state.pieces = window.pickRandomPattern();
  window.state.history = new Set();
  window.state.history.add(window.serialiseState(window.state.pieces, window.state.currentPlayer));
  window.render();
  window.assignStartingColor(myColor);
  window.triggerAIMove();

  showRankedBanner(activeRankedOpponent.elo);
}

window.rankedOnGameOver = function(winner, humanPlayerColor, vsAI) {
  if (!activeRankedOpponent || !vsAI) return;
  
  const opponent = activeRankedOpponent;
  activeRankedOpponent = null;
  hideRankedBanner();

  const isWin = winner === humanPlayerColor;
  const isDraw = winner === null || winner === 0;
  const score = isWin ? 1 : (isDraw ? 0.5 : 0);
  
  const expected = getExpectedScore(rankedState.elo, opponent.elo);
  const k = getKFactor(rankedState.games);
  
  const oldElo = rankedState.elo;
  rankedState.elo = Math.round(rankedState.elo + k * (score - expected));
  rankedState.games++;
  saveState();
  
  const delta = rankedState.elo - oldElo;
  const sign = delta >= 0 ? '+' : '';
  const resultText = isWin ? 'Vitória' : (isDraw ? 'Empate' : 'Derrota');
  
  const msg = `Modo Ranqueado: ${resultText}! Elo: ${rankedState.elo} (${sign}${delta})`;
  if (typeof window.showToast === 'function') {
    window.showToast(msg, 5000);
  } else {
    console.log(`[RANKED] ${msg}`);
  }
};

// ─── UI Integrations ─────────────────────────────────────────────────────────
function showRankedBanner(opponentElo) {
  hideRankedBanner();
  const el = document.createElement('div');
  el.id = 'ranked-match-banner';
  el.style.cssText = `
    position:fixed; top:8px; left:50%; transform:translateX(-50%); z-index:250;
    background:#241a12f6; border:1px solid var(--accent); border-radius:8px;
    padding:.45rem 1rem; display:flex; align-items:center; gap:.7rem;
    font-family:'Quicksand',serif; color:var(--gold); font-size:.85rem; letter-spacing:.06em;
    box-shadow:0 6px 20px rgba(0,0,0,.6);
  `;
  el.innerHTML = `
    <span>🏆 Partida Ranqueada · Oponente: ${opponentElo} Elo</span>
    <button id="ranked-exit" style="background:none;border:1px solid var(--sand3);
      border-radius:5px; color:var(--sand); font-size:.7rem; padding:.15rem .5rem; cursor:pointer;">
      Abandonar
    </button>
  `;
  document.body.appendChild(el);
  
  document.getElementById('ranked-exit').addEventListener('click', () => {
    activeRankedOpponent = null;
    hideRankedBanner();
    window.vsAI = true;
    window.restartGame(true); // Treat as an unrated abandon
  });
}

function hideRankedBanner() {
  document.getElementById('ranked-match-banner')?.remove();
}

function updateMenuDisplay() {
  const display = document.getElementById('ranked-elo-display');
  if (display) {
    display.textContent = `Seu Elo: ${rankedState.elo} (${rankedState.games} jogos)`;
  }
}

function injectMenuButton() {
  const menu = document.getElementById('main-menu');
  if (!menu) return;

  const btn = document.createElement('button');
  btn.className = 'menu-item';
  btn.style.marginTop = '10px';
  btn.style.border = '1px solid var(--gold)';
  btn.innerHTML = `
    🏆 Jogar Ranqueado
    <div id="ranked-elo-display" style="font-size: 0.7rem; color: var(--sand3); margin-top: 4px;"></div>
  `;
  btn.addEventListener('click', () => {
    document.getElementById('main-menu').style.display = 'none';
    startRankedGame();
  });
  
  // Insert it near the standard "Play vs AI" button
  menu.insertBefore(btn, menu.children[1]); 
  updateMenuDisplay();
}

// ─── Initialization ──────────────────────────────────────────────────────────
function boot() {
  loadState();
  injectMenuButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  setTimeout(boot, 0);
}

})();