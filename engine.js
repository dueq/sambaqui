/**
 * Sambaqui – Game Engine (pure logic, no DOM)
 *
 * Extracted verbatim from sambaqui_1_4_3.html Sections 1 (board helpers),
 * 2 (pure game logic), 3 (board patterns), and 10 (AI / MCTS search), so
 * that the exact code driving in-browser play is byte-for-byte the same
 * code used by calibrate.js to estimate AI Elo offline. Do not let this
 * drift from the inline copy in the HTML — the HTML now <script>-loads
 * this file directly instead of duplicating the logic.
 *
 * Works unmodified in both environments:
 *   • Browser: loaded via <script src="./engine.js"></script>, before the
 *     game's own <script> block — everything below attaches to the global
 *     scope (window), exactly as the inline version did.
 *   • Node:    required by calibrate.js — the CommonJS export block at the
 *     bottom only runs when `module` exists, so it's a no-op in the browser.
 *
 * NOTE (fix history): findWinIn2 was rewritten to a proper depth-bounded
 * forcedWin() minimax that branches on simState.currentPlayer rather than
 * ply count, because the game's sneaking mechanic (a move that doesn't
 * reveal an enemy piece keeps the same player to move) breaks any logic
 * that assumes strict turn alternation. See forcedWin()'s comment below.
 */
'use strict';

// ═══════════════════════════════════════════════════════════════
//  BOARD LABELS & DIRECTIONS
// ═══════════════════════════════════════════════════════════════

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXY';

const DIRS = [
  [-1, -1, '↖\uFE0E'], [-1,  0, '↑\uFE0E'], [-1,  1, '↗\uFE0E'],
  [ 0, -1, '←\uFE0E'],                     [ 0,  1, '→\uFE0E'],
  [ 1, -1, '↙\uFE0E'], [ 1,  0, '↓\uFE0E'], [ 1,  1, '↘\uFE0E'],
];

function labelToRC(label) {
  const idx = LABELS.indexOf(label);
  return [Math.floor(idx / 5), idx % 5];
}

function rcToLabel(r, c) {
  if (r < 0 || r > 4 || c < 0 || c > 4) return null;
  return LABELS[r * 5 + c];
}


// ═══════════════════════════════════════════════════════════════
//  PURE GAME LOGIC
// ═══════════════════════════════════════════════════════════════

//  SECTION 2 — PURE GAME LOGIC
// ═══════════════════════════════════════════════════════════════

function computeSlide(fromLabel, dr, dc, pieces) {
  const [r0, c0] = labelToRC(fromLabel);
  const path = [];
  let r = r0 + dr, c = c0 + dc;
  while (r >= 0 && r <= 4 && c >= 0 && c <= 4) {
    const sq = rcToLabel(r, c);
    if (pieces[sq]) break;
    path.push(sq);
    r += dr; c += dc;
  }
  return path.length === 0 ? null : { landing: path[path.length - 1], path };
}

function computeAllSlides(fromLabel, pieces) {
  const moves = [];
  for (const [dr, dc, arrow] of DIRS) {
    const result = computeSlide(fromLabel, dr, dc, pieces);
    if (result) moves.push({ dr, dc, arrow, ...result });
  }
  return moves;
}

function computeVisibleMoveableEnemies(fromLabel, pieces, currentPlayer) {
  const enemy = currentPlayer === 1 ? 2 : 1;
  const visible = [];
  for (const [dr, dc] of DIRS) {
    const [r0, c0] = labelToRC(fromLabel);
    let r = r0 + dr, c = c0 + dc;
    while (r >= 0 && r <= 4 && c >= 0 && c <= 4) {
      const sq = rcToLabel(r, c);
      if (pieces[sq]) {
        if (pieces[sq].player === enemy && computeAllSlides(sq, pieces).length > 0) {
          visible.push(sq);
        }
        break;
      }
      r += dr; c += dc;
    }
  }
  return visible;
}

const ALL_LINES = (() => {
  const lines = [];
  for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const run = [];
        let rr = r, cc = c;
        while (rr >= 0 && rr < 5 && cc >= 0 && cc < 5) {
          run.push(rcToLabel(rr, cc));
          rr += dr; cc += dc;
        }
        for (let s = 0; s <= run.length - 3; s++) {
          for (let len = 3; len <= run.length - s; len++) {
            lines.push(run.slice(s, s + len));
          }
        }
      }
    }
  }
  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.join(',');
    if (!seen.has(key)) { seen.add(key); unique.push(line); }
  }
  return unique;
})();

function checkVictory(pieces) {
  for (const line of ALL_LINES) {
    if (line.length < 3) continue;
    let match = true;
    const firstPiece = pieces[line[0]];
    if (!firstPiece) continue;
    const pId = firstPiece.player;
    for (let i = 1; i < line.length; i++) {
      if (!pieces[line[i]] || pieces[line[i]].player !== pId) { match = false; break; }
    }
    if (match) {
      // Fix 2: if ALL pieces of the winner are part of some winning line, mark them all
      const allWinnerSquares = Object.keys(pieces).filter(sq => pieces[sq].player === pId);
      const squaresInAnyLine = new Set();
      for (const wLine of ALL_LINES) {
        if (wLine.length < 3) continue;
        const allMatch = wLine.every(sq => pieces[sq] && pieces[sq].player === pId);
        if (allMatch) wLine.forEach(sq => squaresInAnyLine.add(sq));
      }
      const allInLine = allWinnerSquares.every(sq => squaresInAnyLine.has(sq));
      const fullLine = allInLine ? allWinnerSquares : line;
      return { winner: pId, line: fullLine };
    }
  }
  return null;
}

function serialiseState(pieces, currentPlayer) {
  const parts = [];
  for (const label of LABELS) {
    const p = pieces[label];
    if (p) parts.push(`${label}${p.player}${p.active ? 'A' : 'I'}`);
  }
  parts.sort();
  return `${currentPlayer}:${parts.join(',')}`;
}

function hypotheticalKey(fromLabel, landing, currentPieces, currentPlayer) {
  const next = {};
  for (const [sq, p] of Object.entries(currentPieces)) next[sq] = { ...p };
  const moving = { ...next[fromLabel], active: false };
  delete next[fromLabel];
  next[landing] = moving;
  const enemy = currentPlayer === 1 ? 2 : 1;
  const visibleEnemies = computeVisibleMoveableEnemies(landing, next, currentPlayer);
  if (visibleEnemies.length > 0) {
    for (const [sq, p] of Object.entries(next)) {
      if (p.player === enemy) next[sq] = { ...p, active: false };
    }
    for (const sq of visibleEnemies) next[sq] = { ...next[sq], active: true };
    return serialiseState(next, enemy);
  } else {
    next[landing] = { ...next[landing], active: true };
    return serialiseState(next, currentPlayer);
  }
}

function currentPlayerHasLegalMoves(pieces, currentPlayer, sneaking, sneakingSquare, history) {
  const pool = sneaking ? [sneakingSquare] : LABELS;
  for (const label of pool) {
    const p = pieces[label];
    if (!p || p.player !== currentPlayer || !p.active) continue;
    const slides = computeAllSlides(label, pieces);
    for (const m of slides) {
      const key = hypotheticalKey(label, m.landing, pieces, currentPlayer);
      if (!history.has(key)) return true;
    }
  }
  return false;
}


// ═══════════════════════════════════════════════════════════════
//  BOARD PATTERNS (50 daily-puzzle layouts, reused as random starting
//  positions for rated games and AI-vs-AI calibration)
// ═══════════════════════════════════════════════════════════════

const BOARD_CODES = [
  'BFTX-DJPV',
  'GJKN-FILO',
  'EGRV-BHQY',
  'CNVY-AHOP',
  'CJNW-DHKO',
  'CPRT-BLOV',
  'JPSY-EFIT',
  'BIQV-DGSX',
  'BIUY-AEQX',
  'GJKY-ADSW',
  'AKST-FGOY',
  'BGTX-DJQV',
  'BJTV-DFPX',
  'BJPY-EFTV',
  'ACTV-BOPY',
  'DFRW-JKLX',
  'EITX-AGPV',
  'GNPX-FHSV',
  'DKLV-BNOX',
  'AEST-IJUY',
  'BJKS-DGTW',
  'FGSU-AIPQ',
  'DGKO-CJSW',
  'ILOP-DHQW',
  'BJRW-FNOV',
  'GJRU-AHQT',
  'DFIU-APSX',
  'CFTV-BJKX',
  'AIQV-EGSX',
  'GSUX-IQVY',
  'FGUY-AEPQ',
  'BKTU-DOPY',
  'ELSU-ANQY',
  'BFNW-HKTX',
  'HJQU-EILV',
  'ADST-IJUX',
  'DHRX-FJLN',
  'ACST-BGOY',
  'BJKW-COPX',
  'DIPY-BGTU',
  'CJNQ-IKRV',
  'KLTX-BFRW',
  'APQV-BFGU',
  'BFNO-CHTX',
  'ALTV-DFNY',
  'DGSV-BIQX',
  'JNQU-EIRV',
  'JKLY-ADRW',
  'CIJU-EKQV',
  'GLTX-BFNS',
  'DFIV-BPSX',
  'FGOX-IJKV',
  'BFIU-APSV',
  'BHQX-DGRV',
  'CLUX-EHKT',
  'DFNW-HJKX',
  'CQXY-ABIW',
  'BGJX-DQTV',
  'AEVX-BDUY',
  'CRVY-ADHW',
  'DGPW-JKSV',
  'CGPW-KOSV',
  'DFSY-BJQU',
  'BHSW-CGRX',
  'BIUX-ADSV',
  'AIUV-EGXY',
  'AEHP-FRUY',
  'AEIT-FQUY',
  'NTUX-LPVY',
  'GPTV-BFJQ',
  'AHOV-CNPY',
  'CPSV-DGJW',
  'GPWX-FKSV',
  'DPRV-BFHX',
  'FJVX-BDPT',
  'CFSX-DIPW',
  'BFGS-DIJQ',
  'DFNW-CLTV',
  'DFHQ-BILP',
  'ADGO-CJSY',
  'DLOV-BKNX',
  'CEQV-IJKU',
  'DHKT-CLPX',
  'BLOV-FHJW',
  'BLUX-DNVY',
  'DPTX-BFJV',
  'CFLT-BHKX',
  'AKST-BGWY',
  'BEFL-ADJN',
  'AHSW-GKNY',
  'AEJQ-GTUY',
  'BCSU-AIVW',
  'ABDO-CJTY',
  'FJLS-DGRX',
  'AIJY-EFGU',
  'IOPS-GKQT',
  'AJSX-DFGY',
  'DFNW-BOPR',
  'FILO-GJKN',
  'DFGW-JKSX',
  'DIVY-BESX',
  'CJQU-EIPW',
  'CLNP-DHKR',
  'EIKV-CJQU',
  'DKNX-CPRT',
  'CDRX-FJLO',
  'ELSV-ANQX',
  'BJOW-CDKT',
  'BIUY-AESV',
  'BDLW-FHOP',
  'DGTV-BJQX',
  'DIQX-BGSV',
  'ADIU-BEGY',
  'ATUX-EPVY',
  'DHQT-ILPX',
  'BIJQ-DFGS',
  'BCPT-DFKX',
  'EHNV-DLRU',
  'BENW-FORU',
  'DJPY-EFTX',
  'BEQX-FITU',
  'HJKR-CLNV',
  'EFRV-BHPY',
  'FJNQ-BIRV',
  'GIPT-FJQS',
  'BNQV-DILX',
  'AGTW-CFSY',
  'CKTV-DFOW',
  'BIKY-AOQX',
  'BGJW-CPSX',
  'CUXY-ABEW',
  'BITU-EFQX',
  'BORW-CHKX',
  'JLSU-EGNP',
  'AJTU-EFPY',
  'DKRW-CHOV',
  'DEFW-CTUV',
  'AIST-FGQY',
  'DQTX-BFIV',
  'FJSU-EGPT',
  'HPST-FGJR',
  'CRTU-EFHW',
  'AOPU-EJKY',
  'CITX-BFQW',
  'CIUY-AEQW',
  'EGNQ-ILSU',
  'DGWX-BCSV',
  'BIVY-ADQX',
  'FLOY-AKNT',
  'DGJU-EPSV',
  'KNQY-AILO',
  'IPRT-FHJQ',
  'BDPT-FJVX',
  'APRV-DHJY',
  'BPSV-DGJX',
  'FHOS-GKRT',
  'ADHX-BRVY',
  'DQSW-CGIV',
  'BOQU-EIKX',
  'HJKW-COPR',
  'EFHS-GRTU',
  'BILS-GNQX',
  'DGJW-CPSV',
  'CILV-DNQW',
  'BFQY-AITX',
  'GPTV-DFJS',
  'GJKQ-IOPS',
  'ACRX-BHWY',
  'CTUX-BEFW',
  'AIPT-FJQY',
  'AKNT-FLOY',
  'GKTY-AFOS',
  'DGWY-ACSV',
  'GPRT-FHJS',
  'JSVY-ADGP',
  'CIJU-EPQW',
  'ATWX-BCFY',
  'EGPQ-IJSU',
  'EITW-CFQU',
  'BGNV-DLSX',
  'DGQX-BISV',
  'BDQS-GIVX',
  'DGHW-CRSV',
  'AJLV-DNPY',
  'BCSV-DGWX',
  'AOSU-EGKY',
  'JSUY-AEGP',
  'DJKY-AOPV',
  'BNPV-DJLX',
  'IJSU-EGPQ',
  'BDFY-ATVX',
  'AHLS-GNRY',
  'BNRY-AHLX',
  'CQRX-BHIW',
  'AQUX-BEIY',
  'CKLT-FNOW',
  'AEQV-DIUY',
  'JKLX-BNOP',
  'FNOY-AKLT',
  'BJPX-DFTV',
];

function decompressPatterns(compressedList) {
  return compressedList.map(pattern => {
    const [p1Chars, p2Chars] = pattern.split('-');
    const boardObject = {};
    for (const char of p1Chars) boardObject[char] = { player: 1, active: true };
    for (const char of p2Chars) boardObject[char] = { player: 2, active: true };
    return boardObject;
  });
}
const BOARD_PATTERNS = decompressPatterns(BOARD_CODES);

/** Deep-copies a random (or specific) pattern. Used by calibrate.js and by
 *  rated.js/elo.js (via window.pickRandomPattern) for non-daily game setups. */
function pickRandomPattern(index) {
  const i = (index !== undefined) ? index : Math.floor(Math.random() * BOARD_PATTERNS.length);
  return JSON.parse(JSON.stringify(BOARD_PATTERNS[i]));
}

// ═══════════════════════════════════════════════════════════════
//  AI / TREE SEARCH ENGINE (SimState, MCTSNode, AdvancedEngineMCTS,
//  evaluatePosition, getDifficultyProfile)
// ═══════════════════════════════════════════════════════════════

const BOARD_SIZE  = 5;
const DIRECTIONS  = [
  { dr: 0,  dc: 1,  weight: 1.0 },  // horizontal
  { dr: 1,  dc: 0,  weight: 1.0 },  // vertical
  { dr: 1,  dc: 1,  weight: 0.9 },  // diagonal ↘
  { dr: 1,  dc: -1, weight: 0.9 },  // diagonal ↙
];

// labelToRC and rcToLabel are defined earlier in the codebase and used here as-is.
// labelToRC(label) returns [r, c] as a two-element array.
// rcToLabel(r, c)  returns a label string or null if out of bounds.

// Score a window of 3 squares in one direction for one player.
// Returns the count of own pieces in that window, or null if blocked by an enemy.
function scoreDirection(pieces, player, startR, startC, dr, dc) {
  const run = [];
  for (let i = 0; i < 3; i++) {
    const lbl = rcToLabel(startR + i * dr, startC + i * dc);
    if (lbl === null) return null;              // out of bounds
    const p = pieces[lbl];
    run.push(p ? p.player : 0);
  }
  const own = run.filter(v => v === player).length;
  const opp = run.filter(v => v !== 0 && v !== player).length;
  if (opp > 0) return null;                    // blocked by enemy
  return own;
}

function evaluatePosition(pieces, player) {
  const opponent = player === 1 ? 2 : 1;
  let selfScore = 0;
  let oppScore  = 0;

  for (const { dr, dc, weight } of DIRECTIONS) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const s = scoreDirection(pieces, player,   r, c, dr, dc);
        const o = scoreDirection(pieces, opponent, r, c, dr, dc);
        // Exponential weighting: 2-in-a-row scores 4×, not 2×
        if (s !== null) selfScore = Math.max(selfScore, Math.pow(s, 2) * weight);
        if (o !== null) oppScore  = Math.max(oppScore,  Math.pow(o, 2) * weight);
      }
    }
  }

  // Relative score in [−1, +1]: positive = good for player.
  return (selfScore - oppScore) / 9.0;
}

// ── SimState ─────────────────────────────────────────────────────────────────
// (unchanged from original — reproduced here for completeness)

class SimState {
  constructor(pieces, currentPlayer, sneaking, sneakingSquare, history, isGameOver, winner) {
    this.pieces = pieces;
    this.currentPlayer = currentPlayer;
    this.sneaking = sneaking;
    this.sneakingSquare = sneakingSquare;
    this.history = new Set(history);
    this.isGameOver = isGameOver;
    this.winner = winner;
  }
  clone() {
    const cp = {};
    for (const sq in this.pieces) {
      cp[sq] = { player: this.pieces[sq].player, active: this.pieces[sq].active };
    }
    return new SimState(cp, this.currentPlayer, this.sneaking, this.sneakingSquare, this.history, this.isGameOver, this.winner);
  }
  getValidMoves() {
    const moves = [];
    const pool = this.sneaking ? [this.sneakingSquare] : LABELS;
    for (const label of pool) {
      const p = this.pieces[label];
      if (!p || p.player !== this.currentPlayer || !p.active) continue;
      for (const m of computeAllSlides(label, this.pieces)) {
        if (!this.history.has(hypotheticalKey(label, m.landing, this.pieces, this.currentPlayer))) {
          moves.push({ from: label, move: m });
        }
      }
    }
    return moves;
  }
  makeMove(from, move) {
    for (const sq in this.pieces) {
      if (this.pieces[sq].player === this.currentPlayer && sq !== from) this.pieces[sq].active = false;
    }
    const mv = { ...this.pieces[from], active: false };
    delete this.pieces[from];
    this.pieces[move.landing] = mv;

    const win = checkVictory(this.pieces);
    if (win) { this.isGameOver = true; this.winner = win.winner; return; }

    const visible = computeVisibleMoveableEnemies(move.landing, this.pieces, this.currentPlayer);
    if (visible.length > 0) {
      const enemy = this.currentPlayer === 1 ? 2 : 1;
      for (const sq in this.pieces) this.pieces[sq].active = (this.pieces[sq].player === enemy && visible.includes(sq));
      this.currentPlayer = enemy;
      this.sneaking = false;
      this.sneakingSquare = null;
    } else {
      this.sneaking = true;
      this.sneakingSquare = move.landing;
      this.pieces[move.landing].active = true;
    }
    this.history.add(serialiseState(this.pieces, this.currentPlayer));

    if (!currentPlayerHasLegalMoves(this.pieces, this.currentPlayer, this.sneaking, this.sneakingSquare, this.history)) {
      const opp = this.currentPlayer === 1 ? 2 : 1;
      for (const sq in this.pieces) if (this.pieces[sq].player === opp) this.pieces[sq].active = true;
      this.currentPlayer = opp;
      this.sneaking = false;
      this.sneakingSquare = null;
      this.history.add(serialiseState(this.pieces, this.currentPlayer));
    }
  }
}

// ── MCTSNode ─────────────────────────────────────────────────────────────────

class MCTSNode {
  constructor(simState, parent, leadingMove) {
    this.state = simState;
    this.parent = parent;
    this.move = leadingMove;
    this.children = [];
    this.wins = 0;
    this.visits = 0;
    this.untriedMoves = simState.getValidMoves();
    this.playerJustMoved = parent ? parent.state.currentPlayer : null;
  }

  // CHANGE 5: UCB1 exploration constant raised to 1.8 for wider search.
  ucb1(c = 1.8) {
    if (this.visits === 0) return Infinity;
    return (this.wins / this.visits) + c * Math.sqrt(Math.log(this.parent.visits) / this.visits);
  }
  isFullyExpanded() { return this.untriedMoves.length === 0; }
  hasChildren()     { return this.children.length > 0; }
}

// ── AdvancedEngineMCTS ────────────────────────────────────────────────────────

class AdvancedEngineMCTS {
  constructor(simState, iterations) {
    this.root = new MCTSNode(simState, null, null);
    this.iterations = iterations;
    this.aiPlayer = simState.currentPlayer;
  }

  findImmediateWin(simState, player) {
    const valid = simState.getValidMoves();
    for (const action of valid) {
      const temp = simState.clone();
      temp.makeMove(action.from, action.move);
      if (temp.isGameOver && temp.winner === player) return action;
    }
    return null;
  }

  // CHANGE 4: findWinIn2 replaced with a proper bounded forced-win search.
  //
  // The previous version assumed strict turn alternation ("AI moves, then
  // opponent moves, then check"), but this game has a sneaking mechanic:
  // a move that doesn't reveal an enemy piece keeps `currentPlayer`
  // unchanged (the same side moves again). That meant temp.getValidMoves()
  // after the AI's own first move could actually still be the AI's OWN
  // follow-up options (if that move kept it sneaking), not the opponent's
  // replies — and the code was requiring a win after EVERY one of those,
  // which is backwards when the AI itself is the one choosing. Over any
  // sneak chain this made findWinIn2 wildly over-conservative and it would
  // almost never fire.
  //
  // Fixed by branching on who actually owns the resulting state
  // (simState.currentPlayer), not on ply count:
  //   - AI to move  → MAX node: only needs ONE move that forces a win.
  //   - Opponent to move → MIN node: AI must win against EVERY reply.
  // This handles sneaking correctly because a node's type falls out of the
  // real game state, not an assumed alternation pattern.
  forcedWin(simState, aiPlayer, depth) {
    if (simState.isGameOver) return simState.winner === aiPlayer;
    if (depth === 0) return false;

    const moves = simState.getValidMoves();
    if (moves.length === 0) return false; // stalemate-ish, not a proven win

    const aiToMove = simState.currentPlayer === aiPlayer;

    if (aiToMove) {
      // MAX node: AI just needs ONE move that leads to a forced win.
      for (const action of moves) {
        const t = simState.clone();
        t.makeMove(action.from, action.move);
        if (this.forcedWin(t, aiPlayer, depth - 1)) return true;
      }
      return false;
    } else {
      // MIN node: opponent to move — AI must win against EVERY reply.
      for (const action of moves) {
        const t = simState.clone();
        t.makeMove(action.from, action.move);
        if (!this.forcedWin(t, aiPlayer, depth - 1)) return false;
      }
      return true;
    }
  }

  findWinIn2(simState, player, depth = 5) {
    const valid = simState.getValidMoves();
    for (const action of valid) {
      const temp = simState.clone();
      temp.makeMove(action.from, action.move);
      if (this.forcedWin(temp, player, depth - 1)) return action;
    }
    return null;
  }

  findSafeMove(simState) {
    const valid = simState.getValidMoves();
    const optimal = [];
    const opponent = this.aiPlayer === 1 ? 2 : 1;
    for (const action of valid) {
      const temp = simState.clone();
      temp.makeMove(action.from, action.move);
      let lethal = false;
      for (const oppAct of temp.getValidMoves()) {
        const oppTemp = temp.clone();
        oppTemp.makeMove(oppAct.from, oppAct.move);
        if (oppTemp.isGameOver && oppTemp.winner === opponent) { lethal = true; break; }
      }
      if (!lethal) optimal.push(action);
    }
    return optimal.length > 0 ? optimal[Math.floor(Math.random() * optimal.length)] : null;
  }

  search(useImmediateWin, useWinIn2, useSafeMove) {
    const currentSimRoot = this.root.state;

    if (useImmediateWin) {
      const imm = this.findImmediateWin(currentSimRoot, this.aiPlayer);
      if (imm) return imm;

      // Clone and force state to opponent turn to check their immediate winning moves
      const opp = this.aiPlayer === 1 ? 2 : 1;
      const oppTurnState = currentSimRoot.clone();
      oppTurnState.currentPlayer = opp;
      const oppWinMove = this.findImmediateWin(oppTurnState, opp);
      
      // If opponent has a winning move, block that destination square if possible
      if (oppWinMove) {
        const blockingMove = currentSimRoot.getValidMoves().find(m => m.move.landing === oppWinMove.move.landing);
        if (blockingMove) return blockingMove;
      }
    }

    let safeMove = null;
    if (useSafeMove) safeMove = this.findSafeMove(currentSimRoot);

    for (let i = 0; i < this.iterations; i++) {
      let node = this.select(this.root);
      if (!node.state.isGameOver && !node.isFullyExpanded()) node = this.expand(node);
      const simulationResult = this.simulate(node.state);
      this.backpropagate(node, simulationResult);
    }

    const bestChildNode = this.getBestChild(this.root);
    if (safeMove && bestChildNode) {
      const bestActionIsSafe = this.checkIfActionIsSafe(currentSimRoot, bestChildNode.move);
      if (!bestActionIsSafe) return safeMove;
    }
    return bestChildNode ? bestChildNode.move : (safeMove || currentSimRoot.getValidMoves()[0]);
  }

checkIfActionIsSafe(simState, action) {
  const temp = simState.clone();
  temp.makeMove(action.from, action.move);
  const opponent = this.aiPlayer === 1 ? 2 : 1;
  
  // If the AI sneaked, the turn didn't swap to opponent yet
  if (temp.currentPlayer !== opponent) return true; 

  for (const oppAction of temp.getValidMoves()) {
    const oppState = temp.clone();
    oppState.makeMove(oppAction.from, oppAction.move);
    if (oppState.isGameOver && oppState.winner === opponent) return false;
  }
  return true;
}

  select(node) {
    while (node.isFullyExpanded() && node.hasChildren()) {
      let bestScore = -Infinity;
      let selectedChild = null;
      for (const child of node.children) {
        const score = child.ucb1();
        if (score > bestScore) { bestScore = score; selectedChild = child; }
      }
      node = selectedChild;
    }
    return node;
  }

  expand(node) {
    const idx = Math.floor(Math.random() * node.untriedMoves.length);
    const action = node.untriedMoves.splice(idx, 1)[0];
    const nextState = node.state.clone();
    nextState.makeMove(action.from, action.move);
    const child = new MCTSNode(nextState, node, action);
    node.children.push(child);
    return child;
  }

  // CHANGE 2: Guided simulation instead of pure random.
  // Each step of the playout uses a lightweight greedy policy:
  //   (a) take an immediate win if available,
  //   (b) block an opponent's immediate win,
  //   (c) pick the move with the best heuristic score delta,
  //   (d) random tiebreak.
  // This makes each rollout carry real information rather than random noise.
  simulate(simState) {
    let current = simState.clone();
    const maxDepth = 20;                        // lifted from 12
    let depth = 0;

    while (!current.isGameOver && depth < maxDepth) {
      const valid = current.getValidMoves();
      if (valid.length === 0) break;

      const player   = current.currentPlayer;
      const opponent = player === 1 ? 2 : 1;
      let chosen     = null;

      // (a) Win immediately
      for (const action of valid) {
        const tmp = current.clone();
        tmp.makeMove(action.from, action.move);
        if (tmp.isGameOver && tmp.winner === player) { chosen = action; break; }
      }

      // (b) Block opponent's immediate win
      if (!chosen) {
        for (const action of valid) {
          const tmp = current.clone();
          tmp.makeMove(action.from, action.move);
          if (!tmp.isGameOver) {
            const oppMoves = tmp.getValidMoves();
            for (const oAct of oppMoves) {
              const oTmp = tmp.clone();
              oTmp.makeMove(oAct.from, oAct.move);
              if (oTmp.isGameOver && oTmp.winner === opponent) {
                chosen = action;
                break;
              }
            }
          }
          if (chosen) break;
        }
      }

      // (c) Greedy heuristic: pick move with best evaluation delta
      if (!chosen) {
        let bestScore = -Infinity;
        for (const action of valid) {
          const tmp = current.clone();
          tmp.makeMove(action.from, action.move);
          // Score from the perspective of the player who just moved (player)
          const score = evaluatePosition(tmp.pieces, player);
          if (score > bestScore) { bestScore = score; chosen = action; }
        }
      }

      // (d) Random tiebreak (should rarely be needed)
      if (!chosen) chosen = valid[Math.floor(Math.random() * valid.length)];

      current.makeMove(chosen.from, chosen.move);
      depth++;
    }

    // CHANGE 4: Return structured result for partial-credit backprop.
    return { winner: current.winner, pieces: current.pieces };
  }

  // CHANGE 4: Partial-credit backpropagation.
  // Binary win/loss discards too much information from truncated rollouts.
  // Now: win = 1.0 pts, "moral win" (2-in-a-row on non-terminal) = 0.5 pts,
  // neutral = 0.25 pts (slightly above 0 to reward non-losing continuations).
  backpropagate(node, result) {
    let current = node;
    while (current !== null) {
      current.visits++;
      if (current.playerJustMoved !== null) {
        if (result.winner === current.playerJustMoved) {
          current.wins += 1.0;
        } else if (result.winner === null && result.pieces) {
          // No winner: use heuristic to award partial credit
          const hScore = evaluatePosition(result.pieces, current.playerJustMoved);
          // hScore ∈ [−1, 1]; map to credit ∈ [0, 0.8]
          current.wins += 0.4 + 0.4 * hScore;
        }
        // If opponent won: 0 credit (no change)
      }
      current = current.parent;
    }
  }

  getBestChild(node) {
    let maxVisits = -1;
    let best = null;
    for (const child of node.children) {
      if (child.visits > maxVisits) { maxVisits = child.visits; best = child; }
    }
    return best;
  }
}

// ── Difficulty profile 3.1───────────────────────────────────────────────────────
// (unchanged from original — higher iteration counts now produce much
//  stronger play because each iteration carries real evaluation signal)

//  ~1.5x search up to lvl 18
// targeted search at lvl 2, 4, 8.

function getDifficultyProfile(streak) {
  const itersByStreak = [2, 4, 6, 10, 16, 24, 36, 54, 80, 120, 180, 270, 400, 600, 900, 1200, 1800, 2700, 4000, 6000, 9000, 12000, 18000, 27000, 40000, 60000, 90000, 120000];
  const useImmediateWin = true;
  const useSafeMove     = streak >= 4;
  const useWinIn2       = streak >= 8;
  const mctsIterations  = itersByStreak[Math.min(streak, itersByStreak.length - 1)];
  return { useImmediateWin, useWinIn2, useSafeMove, mctsIterations };
}

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════

if (typeof module !== 'undefined' && module.exports) {
  // Node (calibrate.js)
  module.exports = {
    LABELS, DIRS, labelToRC, rcToLabel,
    computeSlide, computeAllSlides, computeVisibleMoveableEnemies,
    checkVictory, serialiseState, hypotheticalKey, currentPlayerHasLegalMoves,
    BOARD_CODES, BOARD_PATTERNS, pickRandomPattern,
    evaluatePosition, SimState, MCTSNode, AdvancedEngineMCTS, getDifficultyProfile,
  };
}