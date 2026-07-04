/**
 * Sambaqui – Leaderboard Module
 *
 * Drop-in companion to sambaqui_1_3_4.html.
 * Requires the Supabase UMD bundle (already loaded by the game page).
 *
 * ── Supabase table DDL ────────────────────────────────────────────────────────
 * Run this once in your Supabase project → SQL Editor:
 *
 *   CREATE TABLE leaderboard (
 *     id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     name       text NOT NULL,
 *     score      integer NOT NULL,
 *     token      text NOT NULL,
 *     updated_at timestamptz NOT NULL DEFAULT now()
 *   );
 *
 *   -- One entry per browser (token = random UUID stored in localStorage)
 *   CREATE UNIQUE INDEX leaderboard_token_idx ON leaderboard (token);
 *
 *   -- Allow fully public anonymous access (no login needed)
 *   ALTER TABLE leaderboard ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Public read"   ON leaderboard FOR SELECT USING (true);
 *   CREATE POLICY "Public insert" ON leaderboard FOR INSERT WITH CHECK (true);
 *   CREATE POLICY "Public update" ON leaderboard FOR UPDATE USING (true);
 *   CREATE POLICY "Public delete" ON leaderboard FOR DELETE USING (true);
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
// Reuses the same Supabase project as multiplayer.js — no extra setup needed.

const LB_URL      = 'https://qasopfvcdyikqxbniyqn.supabase.co';
const LB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhc29wZnZjZHlpa3F4Ym5peXFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MzUwMDAsImV4cCI6MjA5NzMxMTAwMH0.MIiyCiRC09kC2hFA-h5-HoNJZGBAhHxoHUPchUB2VKE';
const LB_TABLE    = 'leaderboard';
const TOKEN_KEY   = 'sambaqui_lb_token';
const NAME_KEY    = 'sambaqui_lb_name';

// ── Supabase client ───────────────────────────────────────────────────────────

function lbClient() {
  if (!window._lbClient) {
    if (!window.supabase) { console.error('[LB] Supabase not loaded'); return null; }
    window._lbClient = window.supabase.createClient(LB_URL, LB_ANON_KEY);
  }
  return window._lbClient;
}

// ── Identity token (anonymous ownership) ─────────────────────────────────────

function lbToken() {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = 'lb_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

// ── i18n helper ───────────────────────────────────────────────────────────────

function lbLang() {
  return (typeof window.currentLang !== 'undefined') ? window.currentLang : 'PT';
}
function lbT(pt, en) { return lbLang() === 'PT' ? pt : en; }

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function lbFetch() {
  const c = lbClient(); if (!c) return [];
  const { data, error } = await c
    .from(LB_TABLE)
    .select('name, score, token, updated_at')
    .order('score', { ascending: false })
    .limit(50);
  if (error) { console.error('[LB] fetch', error); return []; }
  return data || [];
}

async function lbUpsert(name, score) {
  const c = lbClient(); if (!c) return false;
  const { error } = await c.from(LB_TABLE).upsert(
    { name, score, token: lbToken(), updated_at: new Date().toISOString() },
    { onConflict: 'token' }
  );
  if (error) { console.error('[LB] upsert', error); return false; }
  localStorage.setItem(NAME_KEY, name);
  return true;
}

async function lbRename(newName) {
  const c = lbClient(); if (!c) return false;
  const { error } = await c.from(LB_TABLE)
    .update({ name: newName, updated_at: new Date().toISOString() })
    .eq('token', lbToken());
  if (error) { console.error('[LB] rename', error); return false; }
  localStorage.setItem(NAME_KEY, newName);
  return true;
}

async function lbRemove() {
  const c = lbClient(); if (!c) return false;
  const { error } = await c.from(LB_TABLE).delete().eq('token', lbToken());
  if (error) { console.error('[LB] delete', error); return false; }
  return true;
}

// ── Styles ────────────────────────────────────────────────────────────────────

function lbInjectStyles() {
  if (document.getElementById('lb-styles')) return;
  const s = document.createElement('style');
  s.id = 'lb-styles';
  s.textContent = `
    .lb-overlay {
      position: fixed; inset: 0; z-index: 300;
      background: rgba(10,6,3,0.92);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Quicksand', serif;
      animation: fade-in .25s ease;
    }
    .lb-card {
      background: #1e1610; border: 2px solid var(--accent); border-radius: 10px;
      width: 92%; max-width: 390px; padding: 1.5rem 1.7rem;
      box-shadow: 0 12px 50px rgba(0,0,0,.85);
      display: flex; flex-direction: column; gap: 1rem;
    }
    .lb-head {
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgba(122,79,46,.35); padding-bottom: .55rem;
    }
    .lb-title {
      color: var(--gold); font-family: 'Lily Script One', cursive;
      font-size: 1.25rem; letter-spacing: .07em;
    }
    .lb-x {
      background: none; border: none; color: var(--sand3);
      font-size: 1.2rem; cursor: pointer; padding: .15rem .4rem; line-height: 1;
    }
    .lb-x:hover { color: var(--sand); }

    /* prompt */
    .lb-prompt { display: flex; flex-direction: column; gap: .65rem; }
    .lb-prompt-lbl {
      font-size: .78rem; letter-spacing: .12em; color: var(--sand3); text-align: center;
    }
    .lb-score-badge {
      text-align: center; font-family: 'Lily Script One', cursive;
      font-size: 1.9rem; color: var(--gold); letter-spacing: .06em;
      text-shadow: 0 0 28px rgba(196,154,68,.4);
    }
    .lb-row { display: flex; gap: .45rem; }
    .lb-input {
      flex: 1; min-width: 0;
      background: rgba(72,49,2,.45); border: 1px solid var(--accent);
      border-radius: 6px; color: var(--sand); padding: .5rem .7rem;
      font-family: 'Quicksand', serif; font-size: .9rem; letter-spacing: .08em; outline: none;
      transition: border-color .2s;
    }
    .lb-input:focus { border-color: var(--gold); }
    .lb-input::placeholder { color: var(--sand3); opacity: .55; }
    .lb-btn {
      background: rgba(196,154,68,.1); border: 1px solid rgba(196,154,68,.45);
      border-radius: 6px; color: var(--gold); padding: .5rem .95rem;
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
      font-family: 'Quicksand', serif; font-size: .8rem; letter-spacing: .1em;
      transition: background .2s, border-color .2s;
    }
    .lb-btn:hover:not(:disabled) { background: rgba(196,154,68,.22); border-color: var(--gold); }
    .lb-btn:disabled { opacity: .38; cursor: not-allowed; }
    .lb-msg {
      font-size: .7rem; letter-spacing: .1em; color: var(--teal);
      min-height: 1em; text-align: center;
    }
    .lb-msg.err { color: #c07050; }

    /* table */
    .lb-wrap { max-height: 252px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--accent) transparent; }
    .lb-tbl { width: 100%; border-collapse: collapse; }
    .lb-tbl th {
      font-size: .62rem; letter-spacing: .15em; color: var(--sand3);
      text-transform: uppercase; text-align: left;
      padding: .28rem .45rem; border-bottom: 1px solid rgba(122,79,46,.3);
    }
    .lb-tbl th:last-child { text-align: right; }
    .lb-tbl td {
      font-size: .86rem; letter-spacing: .05em; color: var(--sand);
      padding: .42rem .45rem; border-bottom: 1px solid rgba(122,79,46,.14);
    }
    .lb-tbl td:first-child { color: var(--sand3); font-size: .72rem; width: 2rem; }
    .lb-tbl td:last-child { text-align: right; font-family: 'Lily Script One', cursive; color: var(--gold); }
    .lb-tbl tr.lb-me td { color: var(--gold); }
    .lb-tbl tr.lb-me td:first-child { color: var(--gold); }
    .lb-tbl tr:last-child td { border-bottom: none; }
    .lb-empty {
      text-align: center; font-size: .74rem; letter-spacing: .1em;
      color: var(--sand3); padding: 1.1rem 0;
    }
    .lb-loading { text-align: center; font-size: .74rem; letter-spacing: .1em; color: var(--sand3); padding: 1.1rem 0; }

    /* own-entry actions */
    .lb-actions { display: flex; gap: .45rem; justify-content: flex-end; flex-wrap: wrap; }
    .lb-act {
      background: transparent; border: 1px solid rgba(184,169,138,.22);
      border-radius: 4px; color: var(--sand3);
      padding: .26rem .65rem; cursor: pointer;
      font-family: 'Quicksand', serif; font-size: .7rem; letter-spacing: .1em;
      transition: all .18s;
    }
    .lb-act:hover { border-color: var(--sand3); color: var(--sand); }
    .lb-act.del { color: #c07050; border-color: rgba(192,112,74,.3); }
    .lb-act.del:hover { border-color: #c07050; background: rgba(192,112,74,.08); }
  `;
  document.head.appendChild(s);
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function lbClose() { document.getElementById('lb-overlay')?.remove(); }

async function lbOpen({ prompt = false, score = 0 } = {}) {
  if (document.getElementById('lb-overlay')) return;
  lbInjectStyles();

  const myToken    = lbToken();
  const cachedName = localStorage.getItem(NAME_KEY) || '';
  const wins       = lbT(score === 1 ? 'vitória' : 'vitórias', score === 1 ? 'win' : 'wins');

  const overlay = document.createElement('div');
  overlay.className = 'lb-overlay';
  overlay.id = 'lb-overlay';
  overlay.innerHTML = `
    <div class="lb-card">
      <div class="lb-head">
        <span class="lb-title">🏆 Ranking</span>
        <button class="lb-x" id="lb-x">✕</button>
      </div>

      ${prompt ? `
      <div class="lb-prompt" id="lb-prompt">
        <div class="lb-prompt-lbl">
          ${lbT('Novo recorde pessoal! Adicione ao ranking:', 'New personal best! Add to the ranking:')}
        </div>
        <div class="lb-score-badge">${score} ${wins}</div>
        <div class="lb-row">
          <input class="lb-input" id="lb-name" maxlength="20"
            placeholder="${lbT('Seu nome', 'Your name')}"
            value="${esc(cachedName)}" autocomplete="off" spellcheck="false" />
          <button class="lb-btn" id="lb-submit">${lbT('Enviar', 'Submit')}</button>
        </div>
        <div class="lb-msg" id="lb-msg"></div>
      </div>` : ''}

      <div class="lb-loading" id="lb-loading">${lbT('Carregando…', 'Loading…')}</div>
      <table class="lb-tbl" id="lb-tbl" style="display:none">
        <thead><tr>
          <th>#</th>
          <th>${lbT('Nome', 'Name')}</th>
          <th>${lbT('Vitórias', 'Wins')}</th>
        </tr></thead>
        <tbody id="lb-tbody"></tbody>
      </table>

      <div class="lb-actions" id="lb-actions" style="display:none"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) lbClose(); });
  overlay.querySelector('#lb-x').addEventListener('click', lbClose);

  // Submit flow
  if (prompt) {
    const nameEl = overlay.querySelector('#lb-name');
    const subBtn = overlay.querySelector('#lb-submit');
    const msgEl  = overlay.querySelector('#lb-msg');

    nameEl.focus(); nameEl.select();

    async function doSubmit() {
      const name = nameEl.value.trim();
      if (!name) { setMsg(lbT('Digite seu nome.', 'Enter your name.'), true); return; }
      subBtn.disabled = true;
      subBtn.textContent = lbT('Enviando…', 'Sending…');
      const ok = await lbUpsert(name, score);
      if (ok) {
        setMsg(lbT('Pontuação salva! ✓', 'Score saved! ✓'), false);
        await lbRefreshTable(myToken);
      } else {
        setMsg(lbT('Erro ao salvar. Tente de novo.', 'Error saving. Try again.'), true);
        subBtn.disabled = false;
        subBtn.textContent = lbT('Enviar', 'Submit');
      }
    }
    function setMsg(m, err) {
      msgEl.textContent = m;
      msgEl.className = 'lb-msg' + (err ? ' err' : '');
    }

    subBtn.addEventListener('click', doSubmit);
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
  }

  await lbRefreshTable(myToken);
}

async function lbRefreshTable(myToken) {
  const loadEl   = document.getElementById('lb-loading');
  const tblEl    = document.getElementById('lb-tbl');
  const tbodyEl  = document.getElementById('lb-tbody');
  const actEl    = document.getElementById('lb-actions');
  if (!tbodyEl) return;

  const rows = await lbFetch();

  if (loadEl)  loadEl.style.display  = 'none';
  if (tblEl)   tblEl.style.display   = 'table';

  tbodyEl.innerHTML = '';
  let myEntry = null;

  if (rows.length === 0) {
    tbodyEl.innerHTML = `<tr><td colspan="3"><div class="lb-empty">${lbT('Nenhuma pontuação ainda.', 'No scores yet.')}</div></td></tr>`;
  } else {
    rows.forEach((row, i) => {
      const mine = row.token === myToken;
      if (mine) myEntry = row;
      const tr = document.createElement('tr');
      if (mine) tr.className = 'lb-me';
      tr.innerHTML = `<td>${i + 1}</td><td>${esc(row.name)}${mine ? ' ✎' : ''}</td><td>${row.score}</td>`;
      tbodyEl.appendChild(tr);
    });
  }

  // Own-entry management buttons
  if (!actEl) return;
  if (myEntry) {
    actEl.style.display = 'flex';
    actEl.innerHTML = `
      <button class="lb-act" id="lb-rename">${lbT('Editar nome', 'Edit name')}</button>
      <button class="lb-act del" id="lb-del">${lbT('Remover entrada', 'Remove entry')}</button>
    `;
    actEl.querySelector('#lb-rename').addEventListener('click', () => lbRenameFlow(myToken));
    actEl.querySelector('#lb-del').addEventListener('click',    () => lbDeleteFlow(myToken));
  } else {
    actEl.style.display = 'none';
  }
}

function lbRenameFlow(myToken) {
  const actEl = document.getElementById('lb-actions');
  if (!actEl) return;
  const current = localStorage.getItem(NAME_KEY) || '';
  actEl.innerHTML = `
    <div class="lb-row" style="flex:1">
      <input class="lb-input" id="lb-new-name" maxlength="20"
        value="${esc(current)}" autocomplete="off" spellcheck="false" />
      <button class="lb-btn" id="lb-rename-ok">${lbT('Salvar', 'Save')}</button>
      <button class="lb-act" id="lb-rename-cancel">${lbT('Cancelar', 'Cancel')}</button>
    </div>
  `;
  const inp = actEl.querySelector('#lb-new-name');
  inp.focus(); inp.select();

  async function doRename() {
    const v = inp.value.trim();
    if (!v) return;
    actEl.querySelector('#lb-rename-ok').disabled = true;
    const ok = await lbRename(v);
    if (ok) await lbRefreshTable(myToken);
  }
  actEl.querySelector('#lb-rename-ok').addEventListener('click', doRename);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') doRename(); });
  actEl.querySelector('#lb-rename-cancel').addEventListener('click', () => lbRefreshTable(myToken));
}

function lbDeleteFlow(myToken) {
  const actEl = document.getElementById('lb-actions');
  if (!actEl) return;
  actEl.innerHTML = `
    <span style="font-size:.72rem;letter-spacing:.08em;color:var(--sand3)">
      ${lbT('Tem certeza?', 'Are you sure?')}
    </span>
    <button class="lb-act del" id="lb-del-ok">${lbT('Sim, remover', 'Yes, remove')}</button>
    <button class="lb-act" id="lb-del-cancel">${lbT('Cancelar', 'Cancel')}</button>
  `;
  actEl.querySelector('#lb-del-ok').addEventListener('click', async () => {
    const ok = await lbRemove();
    if (ok) {
      localStorage.removeItem(NAME_KEY);
      await lbRefreshTable(myToken);
    }
  });
  actEl.querySelector('#lb-del-cancel').addEventListener('click', () => lbRefreshTable(myToken));
}

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Game hooks (called from sambaqui_1_3_4.html) ──────────────────────────────

/**
 * Called after every human win vs AI.
 * @param {number}  streak     — current humanStreak value (the score just achieved)
 * @param {boolean} isNewBest  — true when this beat the previous highScore
 */
window.lbOnWin = function(streak, isNewBest) {
  if (!isNewBest || streak < 1) return;
  // Slight delay so the victory banner settles first
  setTimeout(() => lbOpen({ prompt: true, score: streak }), 900);
};

// ── Boot: wire the footer button (already in HTML) ────────────────────────────

function lbBoot() {
  lbInjectStyles();
  const btn = document.getElementById('lb-footer-btn');
  if (btn) {
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', () => lbOpen({ prompt: false }));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', lbBoot);
} else {
  lbBoot();
}
