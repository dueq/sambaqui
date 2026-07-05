/**
 * Sambaqui – Leaderboard Module v2
 *
 * Drop-in companion to sambaqui_1_3_8.html.
 * Requires the Supabase UMD bundle (already loaded by the game page).
 *
 * Sambaqui's solo mode is a DAILY challenge: the board pattern is seeded from
 * the current UTC date, so every player sees the same layout each day, and
 * the local "best" resets at UTC midnight. This module mirrors that:
 *
 *   • "Today"     – ranked by today's runs only (level, then moves as tiebreak)
 *   • "All-Time"  – each player's single best-ever run, across all days
 *
 * ── Supabase setup ─────────────────────────────────────────────────────────
 * Run this once in your Supabase project → SQL Editor. If you already ran
 * the leaderboard DDL from the first draft, run this too — it replaces that
 * table with a safer schema (see security note below) and will DELETE any
 * rows created under the old schema.
 *
 *   drop table if exists leaderboard cascade;
 *   create extension if not exists pgcrypto;
 *
 *   create table leaderboard (
 *     id         uuid primary key default gen_random_uuid(),
 *     play_date  date not null default (now() at time zone 'utc')::date,
 *     name       text not null,
 *     level      integer not null,
 *     moves      integer not null,
 *     owner_hash text not null,   -- sha256(secret token). Safe to expose:
 *                                 -- the token has enough entropy that the
 *                                 -- hash can't practically be reversed.
 *     updated_at timestamptz not null default now()
 *   );
 *
 *   create unique index leaderboard_owner_date_idx
 *     on leaderboard (owner_hash, play_date);
 *
 *   -- One row per player = their single best-ever run (their best day).
 *   create view leaderboard_alltime as
 *     select distinct on (owner_hash)
 *       id, name, level, moves, owner_hash, updated_at
 *     from leaderboard
 *     order by owner_hash, level desc, moves desc, updated_at asc;
 *
 *   alter table leaderboard enable row level security;
 *
 *   -- Public read access — needed for both views.
 *   create policy "Public read" on leaderboard for select using (true);
 *
 *   -- No insert/update/delete policies, and no direct table grants either:
 *   -- every write goes through the SECURITY DEFINER functions below, which
 *   -- verify the caller's secret token server-side (by hashing it and
 *   -- comparing) before ever touching a row. The anon key alone can never
 *   -- write or delete an arbitrary row — unlike the first draft, which
 *   -- returned the raw ownership token in every leaderboard read, letting
 *   -- anyone edit or delete anyone else's entry.
 *   revoke insert, update, delete on leaderboard from anon, authenticated;
 *   grant select on leaderboard_alltime to anon, authenticated;
 *
 *   create or replace function lb_submit_score(p_token text, p_name text, p_level int, p_moves int)
 *   returns void language plpgsql security definer set search_path = public as $$
 *   declare
 *     v_hash text := encode(digest(p_token, 'sha256'), 'hex');
 *     v_today date := (now() at time zone 'utc')::date;
 *     v_name text := left(trim(coalesce(p_name, '')), 20);
 *   begin
 *     if v_name = '' then raise exception 'Name required'; end if;
 *     if p_level is null or p_moves is null or p_level < 0 or p_moves < 0 then
 *       raise exception 'Invalid score';
 *     end if;
 *     insert into leaderboard (play_date, name, level, moves, owner_hash, updated_at)
 *     values (v_today, v_name, p_level, p_moves, v_hash, now())
 *     on conflict (owner_hash, play_date) do update
 *       set name       = excluded.name,
 *           level      = case when (excluded.level, excluded.moves) > (leaderboard.level, leaderboard.moves)
 *                             then excluded.level else leaderboard.level end,
 *           moves      = case when (excluded.level, excluded.moves) > (leaderboard.level, leaderboard.moves)
 *                             then excluded.moves else leaderboard.moves end,
 *           updated_at = case when (excluded.level, excluded.moves) > (leaderboard.level, leaderboard.moves)
 *                             then now() else leaderboard.updated_at end;
 *   end $$;
 *
 *   create or replace function lb_rename(p_token text, p_new_name text)
 *   returns void language plpgsql security definer set search_path = public as $$
 *   declare
 *     v_hash text := encode(digest(p_token, 'sha256'), 'hex');
 *     v_name text := left(trim(coalesce(p_new_name, '')), 20);
 *   begin
 *     if v_name = '' then raise exception 'Name required'; end if;
 *     update leaderboard set name = v_name, updated_at = now() where owner_hash = v_hash;
 *   end $$;
 *
 *   create or replace function lb_remove_today(p_token text)
 *   returns void language plpgsql security definer set search_path = public as $$
 *   declare v_hash text := encode(digest(p_token, 'sha256'), 'hex');
 *   begin
 *     delete from leaderboard where owner_hash = v_hash and play_date = (now() at time zone 'utc')::date;
 *   end $$;
 *
 *   create or replace function lb_remove_all(p_token text)
 *   returns void language plpgsql security definer set search_path = public as $$
 *   declare v_hash text := encode(digest(p_token, 'sha256'), 'hex');
 *   begin
 *     delete from leaderboard where owner_hash = v_hash;
 *   end $$;
 *
 *   grant execute on function lb_submit_score(text, text, int, int) to anon, authenticated;
 *   grant execute on function lb_rename(text, text) to anon, authenticated;
 *   grant execute on function lb_remove_today(text) to anon, authenticated;
 *   grant execute on function lb_remove_all(text) to anon, authenticated;
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
// Reuses the same Supabase project as multiplayer.js — no extra setup needed.

const LB_URL      = 'https://qasopfvcdyikqxbniyqn.supabase.co';
const LB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFhc29wZnZjZHlpa3F4Ym5peXFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MzUwMDAsImV4cCI6MjA5NzMxMTAwMH0.MIiyCiRC09kC2hFA-h5-HoNJZGBAhHxoHUPchUB2VKE';
const LB_TABLE    = 'leaderboard';
const LB_VIEW     = 'leaderboard_alltime';
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

// ── Identity ──────────────────────────────────────────────────────────────────
// A random secret lives only in this browser's localStorage. It is sent to
// Supabase solely as an RPC argument (over HTTPS) to be hashed and matched
// server-side — it is never stored or returned in the clear, and never used
// to filter a query from the client, so it can't be intercepted by reading
// leaderboard rows the way the original design allowed.

function lbToken() {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = 'lb_' + crypto.randomUUID().replace(/-/g, '');
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

// Client-side fingerprint used ONLY to highlight "my" row in the fetched
// results — a one-way hash of our own secret, so it's safe to compute and
// compare locally. This never grants write access by itself.
let _lbHashPromise = null;
async function lbMyHash() {
  if (_lbHashPromise) return _lbHashPromise;
  _lbHashPromise = (async () => {
    try {
      const enc = new TextEncoder().encode(lbToken());
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('[LB] could not compute local fingerprint', e);
      return null;
    }
  })();
  return _lbHashPromise;
}

// ── i18n helper ───────────────────────────────────────────────────────────────

function lbLang() {
  return (typeof window.currentLang !== 'undefined') ? window.currentLang : 'PT';
}
function lbT(pt, en) { return lbLang() === 'PT' ? pt : en; }

function lbTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function lbFetch(tab) {
  const c = lbClient(); if (!c) return [];
  if (tab === 'alltime') {
    const { data, error } = await c
      .from(LB_VIEW)
      .select('name, level, moves, owner_hash, updated_at')
      .order('level', { ascending: false })
      .order('moves', { ascending: false })
      .limit(50);
    if (error) { console.error('[LB] fetch all-time', error); return []; }
    return data || [];
  }
  const { data, error } = await c
    .from(LB_TABLE)
    .select('name, level, moves, owner_hash, updated_at')
    .eq('play_date', lbTodayUTC())
    .order('level', { ascending: false })
    .order('moves', { ascending: false })
    .limit(50);
  if (error) { console.error('[LB] fetch today', error); return []; }
  return data || [];
}

async function lbSubmit(name, level, moves) {
  const c = lbClient(); if (!c) return false;
  const { error } = await c.rpc('lb_submit_score', {
    p_token: lbToken(), p_name: name, p_level: level, p_moves: moves,
  });
  if (error) { console.error('[LB] submit', error); return false; }
  localStorage.setItem(NAME_KEY, name);
  return true;
}

async function lbRename(newName) {
  const c = lbClient(); if (!c) return false;
  const { error } = await c.rpc('lb_rename', { p_token: lbToken(), p_new_name: newName });
  if (error) { console.error('[LB] rename', error); return false; }
  localStorage.setItem(NAME_KEY, newName);
  return true;
}

async function lbRemove(scope) {
  const c = lbClient(); if (!c) return false;
  const fn = scope === 'all' ? 'lb_remove_all' : 'lb_remove_today';
  const { error } = await c.rpc(fn, { p_token: lbToken() });
  if (error) { console.error('[LB] remove', error); return false; }
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
      color: var(--gold); font-family: 'Quicksand', cursive;
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
      font-size: 1.65rem; color: var(--gold); letter-spacing: .05em;
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

    /* tabs */
    .lb-tabs { display: flex; gap: .4rem; }
    .lb-tab {
      flex: 1; background: rgba(72,49,2,.25); border: 1px solid rgba(122,79,46,.4);
      border-radius: 6px; color: var(--sand3); padding: .42rem .5rem; cursor: pointer;
      font-family: 'Quicksand', serif; font-size: .7rem; letter-spacing: .09em;
      text-transform: uppercase; transition: all .18s;
    }
    .lb-tab:hover { color: var(--sand); border-color: var(--sand3); }
    .lb-tab.active { color: var(--gold); border-color: var(--gold); background: rgba(196,154,68,.12); }

    /* table */
    .lb-wrap { max-height: 252px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--accent) transparent; }
    .lb-tbl { width: 100%; border-collapse: collapse; }
    .lb-tbl th {
      font-size: .6rem; letter-spacing: .12em; color: var(--sand3);
      text-transform: uppercase; text-align: left;
      padding: .28rem .4rem; border-bottom: 1px solid rgba(122,79,46,.3);
    }
    .lb-tbl th:nth-child(3) { text-align: center; }
    .lb-tbl th:last-child { text-align: right; }
    .lb-tbl td {
      font-size: .86rem; letter-spacing: .05em; color: var(--sand);
      padding: .42rem .4rem; border-bottom: 1px solid rgba(122,79,46,.14);
    }
    .lb-tbl td:first-child { color: var(--sand3); font-size: .72rem; width: 1.8rem; }
    .lb-tbl td:nth-child(3) { text-align: center; color: var(--sand3); font-size: .8rem; }
    .lb-tbl td:last-child { text-align: right; font-family: 'Quicksand', cursive; color: var(--gold); }
    .lb-tbl tr.lb-me td { color: var(--gold); }
    .lb-tbl tr.lb-me td:first-child,
    .lb-tbl tr.lb-me td:nth-child(3) { color: var(--gold); }
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

let lbActiveTab = 'today';

async function lbOpen({ prompt = false, level = null, moves = null } = {}) {
  if (document.getElementById('lb-overlay')) return;
  lbInjectStyles();
  lbActiveTab = 'today';

  // When opened generically (e.g. from the menu, with no explicit score),
  // fall back to today's local best so there's always a way to submit —
  // not just in the instant right after beating it.
  if (level === null || moves === null) {
    const b = (typeof window.getBestResult === 'function') ? window.getBestResult() : null;
    level = b ? b.level : 0;
    moves = b ? b.moves : 0;
  }
  const canSubmit  = level > 0;

  const cachedName  = localStorage.getItem(NAME_KEY) || '';
  const movesWord   = lbT(moves === 1 ? 'movimento' : 'movimentos', moves === 1 ? 'move' : 'moves');

  const overlay = document.createElement('div');
  overlay.className = 'lb-overlay';
  overlay.id = 'lb-overlay';
  overlay.innerHTML = `
    <div class="lb-card">
      <div class="lb-head">
        <span class="lb-title"> ★ ${lbT('Ranking', 'Leaderboard')}</span>
        <button class="lb-x" id="lb-x">✕</button>
      </div>

      ${canSubmit ? `
      <div class="lb-prompt" id="lb-prompt">
        <div class="lb-prompt-lbl">
          ${prompt
            ? lbT('Novo recorde do dia! Adicione ao ranking:', "New daily best! Add it to the ranking:")
            : lbT('Sua melhor pontuação de hoje:', "Today's best score:")}
        </div>
        <div class="lb-score-badge"> ${level} • ${moves} </div>
        <div class="lb-row">
          <input class="lb-input" id="lb-name" maxlength="20"
            placeholder="${lbT('Seu nome', 'Your name')}"
            value="${esc(cachedName)}" autocomplete="off" spellcheck="false" />
          <button class="lb-btn" id="lb-submit">${lbT('Enviar', 'Submit')}</button>
        </div>
        <div class="lb-msg" id="lb-msg"></div>
      </div>` : `
      <div class="lb-prompt-lbl" style="padding: .2rem 0">
        ${lbT('Jogue o desafio de hoje para poder enviar sua pontuação!', "Play today's challenge to submit a score!")}
      </div>`}

      <div class="lb-tabs">
        <button class="lb-tab active" id="lb-tab-today" data-tab="today">${lbT('Hoje', 'Today')}</button>
        <button class="lb-tab" id="lb-tab-alltime" data-tab="alltime">${lbT('Todos os Tempos', 'All-Time')}</button>
      </div>

      <div class="lb-wrap">
        <div class="lb-loading" id="lb-loading">${lbT('Carregando…', 'Loading…')}</div>
        <table class="lb-tbl" id="lb-tbl" style="display:none">
          <thead><tr>
            <th>#</th>
            <th>${lbT('Nome', 'Name')}</th>
            <th>${lbT('Nível', 'Lvl')}</th>
            <th>${lbT('Mov.', 'Mvs')}</th>
          </tr></thead>
          <tbody id="lb-tbody"></tbody>
        </table>
      </div>

      <div class="lb-actions" id="lb-actions" style="display:none"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) lbClose(); });
  overlay.querySelector('#lb-x').addEventListener('click', lbClose);

  overlay.querySelectorAll('.lb-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      if (tabBtn.dataset.tab === lbActiveTab) return;
      lbActiveTab = tabBtn.dataset.tab;
      overlay.querySelectorAll('.lb-tab').forEach(b => b.classList.toggle('active', b === tabBtn));
      lbRefreshTable();
    });
  });

  // Submit flow
  if (canSubmit) {
    const nameEl = overlay.querySelector('#lb-name');
    const subBtn = overlay.querySelector('#lb-submit');
    const msgEl  = overlay.querySelector('#lb-msg');

    nameEl.focus(); nameEl.select();

    async function doSubmit() {
      const name = nameEl.value.trim();
      if (!name) { setMsg(lbT('Digite seu nome.', 'Enter your name.'), true); return; }
      subBtn.disabled = true;
      subBtn.textContent = lbT('Enviando…', 'Sending…');
      const ok = await lbSubmit(name, level, moves);
      if (ok) {
        setMsg(lbT('Pontuação salva! ✓', 'Score saved! ✓'), false);
        await lbRefreshTable();
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

  await lbRefreshTable();
}

async function lbRefreshTable() {
  const loadEl   = document.getElementById('lb-loading');
  const tblEl    = document.getElementById('lb-tbl');
  const tbodyEl  = document.getElementById('lb-tbody');
  const actEl    = document.getElementById('lb-actions');
  if (!tbodyEl) return;

  if (loadEl)  { loadEl.style.display = 'block'; loadEl.textContent = lbT('Carregando…', 'Loading…'); }
  if (tblEl)   tblEl.style.display = 'none';

  const [rows, myHash] = await Promise.all([lbFetch(lbActiveTab), lbMyHash()]);

  if (loadEl)  loadEl.style.display  = 'none';
  if (tblEl)   tblEl.style.display   = 'table';

  tbodyEl.innerHTML = '';
  let mine = null;

  if (rows.length === 0) {
    const emptyMsg = lbActiveTab === 'alltime'
      ? lbT('Nenhuma pontuação ainda.', 'No scores yet.')
      : lbT('Nenhuma pontuação hoje ainda.', 'No scores today yet.');
    tbodyEl.innerHTML = `<tr><td colspan="4"><div class="lb-empty">${emptyMsg}</div></td></tr>`;
  } else {
    rows.forEach((row, i) => {
      const isMine = myHash && row.owner_hash === myHash;
      if (isMine) mine = row;
      const tr = document.createElement('tr');
      if (isMine) tr.className = 'lb-me';
      tr.innerHTML = `<td>${i + 1}</td><td>${esc(row.name)}${isMine ? ' ✎' : ''}</td><td>${row.level}</td><td>${row.moves}</td>`;
      tbodyEl.appendChild(tr);
    });
  }

  // Own-entry management buttons
  if (!actEl) return;
  if (mine) {
    actEl.style.display = 'flex';
    const removeLabel = lbActiveTab === 'alltime'
      ? lbT('Remover histórico', 'Remove history')
      : lbT('Remover pontuação de hoje', "Remove today's score");
    actEl.innerHTML = `
      <button class="lb-act" id="lb-rename">${lbT('Editar nome', 'Edit name')}</button>
      <button class="lb-act del" id="lb-del">${removeLabel}</button>
    `;
    actEl.querySelector('#lb-rename').addEventListener('click', lbRenameFlow);
    actEl.querySelector('#lb-del').addEventListener('click', lbDeleteFlow);
  } else {
    actEl.style.display = 'none';
  }
}

function lbRenameFlow() {
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
    if (ok) await lbRefreshTable();
  }
  actEl.querySelector('#lb-rename-ok').addEventListener('click', doRename);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') doRename(); });
  actEl.querySelector('#lb-rename-cancel').addEventListener('click', () => lbRefreshTable());
}

function lbDeleteFlow() {
  const actEl = document.getElementById('lb-actions');
  if (!actEl) return;
  const scope = lbActiveTab === 'alltime' ? 'all' : 'today';
  const warnMsg = scope === 'all'
    ? lbT('Isso apaga TODO o seu histórico. Tem certeza?', 'This deletes your ENTIRE history. Are you sure?')
    : lbT('Remover sua pontuação de hoje?', "Remove today's score?");
  actEl.innerHTML = `
    <span style="font-size:.72rem;letter-spacing:.08em;color:var(--sand3)">${warnMsg}</span>
    <button class="lb-act del" id="lb-del-ok">${lbT('Sim, remover', 'Yes, remove')}</button>
    <button class="lb-act" id="lb-del-cancel">${lbT('Cancelar', 'Cancel')}</button>
  `;
  actEl.querySelector('#lb-del-ok').addEventListener('click', async () => {
    const ok = await lbRemove(scope);
    if (ok) {
      if (scope === 'all') localStorage.removeItem(NAME_KEY);
      await lbRefreshTable();
    }
  });
  actEl.querySelector('#lb-del-cancel').addEventListener('click', () => lbRefreshTable());
}

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Game hook (called from sambaqui_1_3_8.html after a run ends) ─────────────

/**
 * Called once per finished run, right after a loss (game over vs AI).
 * @param {number}  level      — humanStreak + 1 for the run that just ended
 * @param {number}  moves      — total human moves made across that run
 * @param {boolean} isNewBest  — true when this beat today's previous local best
 */
window.lbOnWin = function(level, moves, isNewBest) {
  if (!isNewBest || level < 1) return;
  // Slight delay so the "Fim de Jogo" banner settles first
  setTimeout(() => lbOpen({ prompt: true, level, moves }), 900);
};

// ── Boot: inject styles + our own menu entry ──────────────────────────────────

function lbInjectMenuButton() {
  if (document.getElementById('lb-menu-btn')) return;
  const menu = document.getElementById('main-menu');
  if (!menu) { console.warn('[LB] #main-menu not found'); return; }

  const btn = document.createElement('button');
  btn.id = 'lb-menu-btn';
  btn.className = 'menu-item';
  btn.textContent = '★ Ranking';
  btn.addEventListener('click', () => lbOpen({ prompt: false }));

  // Same insertion point multiplayer.js uses for its own menu item, so both
  // end up grouped together above Share/Support regardless of load order.
  menu.insertBefore(btn, document.getElementById('footer-share-link'));
}

function lbBoot() {
  lbInjectStyles();
  lbInjectMenuButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', lbBoot);
} else {
  setTimeout(lbBoot, 0);
}
