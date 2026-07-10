import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import { Chess, validateFen } from 'chess.js';
import { PUZZLES } from './puzzles.js';
import { Engine, scoreToWhiteCp } from './engine.js';
import { Board, pieceClass } from './board.js';
import { fenToMap, buildFen, flipTurn, rankOf } from './fen.js';

const MOVETIME_MS = 300; // per engine move during the playout
const DEFAULT_ANIM_MS = 50; // piece-slide duration (user-adjustable via slider)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimum time between displayed moves: the slide plus an equal rest. */
function movePaceMs() {
  return Math.max(moveAnimMs() * 2, 90);
}

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const els = {
  board: $('board'),
  banner: $('banner'),
  evalFill: $('eval-fill'),
  puzzleSelect: $('puzzle-select'),
  prevPuzzle: $('prev-puzzle'),
  nextPuzzle: $('next-puzzle'),
  puzzleName: $('puzzle-name'),
  puzzleDesc: $('puzzle-desc'),
  status: $('status'),
  tray: $('tray'),
  trayLabel: $('tray-label'),
  resetBtn: $('reset-btn'),
  playBtn: $('play-btn'),
  stopBtn: $('stop-btn'),
  retryBtn: $('retry-btn'),
  progress: $('progress'),
  movelist: $('movelist'),
  speedSlider: $('speed-slider'),
  speedValue: $('speed-value'),
};

/** Piece-slide duration in ms, from the user-adjustable slider. */
function moveAnimMs() {
  return Number(els.speedSlider.value) || DEFAULT_ANIM_MS;
}

// ---- State ----
const state = {
  proto: Number(localStorage.getItem('chessauto-proto')) === 2 ? 2 : 1,
  puzzle: PUZZLES[0],
  phase: 'setup', // 'setup' | 'playing' | 'done'
  baseMap: {}, // pieces fixed by the puzzle
  tray: [], // [{ type, square: string|null }] — the player's pieces to place
  selectedTray: -1,
  enginesReady: false,
  runId: 0, // increments to cancel a playout in flight
};

// The game is prototyped in selectable variants:
//   1 — candidate squares: place the piece on one of 2-3 marked squares
//   2 — hidden square: place anywhere, but the obvious winning squares are
//       blocked; exactly one of the remaining squares wins
//   3 — like 2, but the OPPONENT moves first after placement, so instant
//       captures don't work (analysed separately by the generator)
//   4 — like 3, but nothing is blocked: place anywhere; at most two squares
//       on the whole board win, and the piece may be a pawn, minor, or king
let activePuzzles = [];

function puzzlesForProto(proto) {
  if (proto === 2) return PUZZLES.filter((p) => p.excluded);
  if (proto === 3) return PUZZLES.filter((p) => p.p3);
  if (proto === 4) return PUZZLES.filter((p) => p.p4);
  if (proto === 5) return PUZZLES.filter((p) => p.p5);
  return PUZZLES.filter((p) => p.candidates || !p.source);
}

/** Placement is restricted to the puzzle's candidate squares (prototype 1). */
function usingCandidates() {
  return state.proto === 1 && Boolean(state.puzzle.candidates);
}

/** Placement is open except for blocked squares (prototypes 2 and 3). */
function usingExclusions() {
  return Boolean(activeExclusions());
}

/** The blocked-square list for the active prototype, if any. */
function activeExclusions() {
  if (state.proto === 2 && state.puzzle.excluded) return state.puzzle.excluded;
  if (state.proto === 3 && state.puzzle.p3) return state.puzzle.p3.excluded;
  return null; // prototype 4 blocks nothing
}

/**
 * Open-board data for the active prototype: P4 and P5 share identical rules
 * (place anywhere, opponent moves first, at most two winning squares) and
 * differ only in how their puzzle sets were discovered.
 */
function openSetData() {
  if (state.proto === 4 && state.puzzle.p4) return state.puzzle.p4;
  if (state.proto === 5 && state.puzzle.p5) return state.puzzle.p5;
  return null;
}

/** Prototype 4/5: open placement, opponent first, nothing blocked. */
function usingP4() {
  return Boolean(openSetData());
}

/** Prototypes 3-5 flip the side to move: the opponent replies first. */
function currentTurn() {
  const baseTurn = state.puzzle.fen.split(' ')[1];
  if ((state.proto === 3 && state.puzzle.p3) || usingP4()) {
    return baseTurn === 'w' ? 'b' : 'w';
  }
  return baseTurn;
}

/**
 * The precomputed playout line for the current placement, if the generator
 * shipped one ({ m: 'uci uci …', e: 'cp cp …' }). With a line in hand the
 * playout needs no engine at all.
 */
function lineForPlacement() {
  if (state.tray.length !== 1) return null;
  const sq = state.tray[0].square;
  if (!sq || !state.puzzle.lines) return null;
  const key = currentTurn() === state.puzzle.player ? 'own' : 'opp';
  return state.puzzle.lines[key]?.[sq] ?? null;
}

const whiteEngine = new Engine('white');
const blackEngine = new Engine('black');

const board = new Board(els.board, {
  onSquareClick: handleSquareClick,
  onDropPiece: (trayIndex, square) => {
    state.selectedTray = trayIndex;
    placeSelected(square);
  },
});

// ---- Setup phase ----

function loadPuzzle(index) {
  state.runId++; // cancels any playout in flight
  const puzzle = activePuzzles[index];
  state.puzzle = puzzle;
  state.phase = 'setup';
  state.baseMap = fenToMap(puzzle.fen);
  state.tray = puzzle.place.map((type) => ({ type, square: null }));
  state.selectedTray = -1;

  els.puzzleSelect.value = String(index);
  els.puzzleName.textContent = puzzle.name;
  els.puzzleDesc.textContent = puzzle.description;
  els.movelist.innerHTML = '';
  els.banner.classList.add('hidden');
  els.progress.classList.add('hidden');
  board.setOrientation(puzzle.player);
  showBaseEval();
  refreshSetup();
}

// ---- Base-position evaluation for the eval bar ----
// Before any piece is placed, the bar shows how bad things are WITHOUT the
// missing piece, so a good placement visibly swings it during the playout.
let baseEvalToken = 0;

async function showBaseEval() {
  const token = ++baseEvalToken;
  state.baseCp = 0;
  if (state.puzzle.place.includes('k')) {
    // A side without its king can't be evaluated — call it lost until placed.
    state.baseCp = state.puzzle.player === 'w' ? -9500 : 9500;
    setEvalBar(state.baseCp);
    return;
  }
  setEvalBar(0);
  const fen = buildFen(state.baseMap, currentTurn());
  try {
    await whiteEngine.init();
    // Serialize with any earlier base eval still searching.
    if (state.baseEvalSearch) await state.baseEvalSearch.catch(() => {});
    if (token !== baseEvalToken || state.phase !== 'setup') return;
    state.baseEvalSearch = whiteEngine.search(fen, 250);
    const { score } = await state.baseEvalSearch;
    state.baseEvalSearch = null;
    if (token !== baseEvalToken || state.phase !== 'setup') return;
    state.baseCp = scoreToWhiteCp(score, fen.split(' ')[1]);
    setEvalBar(state.baseCp);
  } catch {
    // Engines unavailable (e.g. blocked download) — leave the bar neutral.
  }
}

function currentMap() {
  const map = { ...state.baseMap };
  for (const item of state.tray) {
    if (item.square) map[item.square] = { type: item.type, color: state.puzzle.player, placed: true };
  }
  return map;
}

function currentFen() {
  return buildFen(currentMap(), currentTurn());
}

/** Validate the fully-constructed position. Returns an error string or null. */
function validatePosition() {
  const fen = currentFen();
  const check = validateFen(fen);
  if (!check.ok) return 'That position is not legal chess.';
  const game = new Chess(fen);
  // The opponent (side not to move) may not start the game in check.
  const flipped = new Chess(flipTurn(fen));
  if (flipped.isCheck()) {
    // With the opponent to move (prototypes 3/4) this means the PLAYER would
    // start in check — only possible when placing the king badly.
    return currentTurn() === state.puzzle.player
      ? 'You can’t place a piece that gives immediate check — the engines need a legal starting position.'
      : 'Your king can’t be placed into check — pick a safer square.';
  }
  if (game.isGameOver()) return 'That position is already over before a move is played.';
  return null;
}

function refreshSetup() {
  board.setPosition(currentMap());
  board.clearHighlights('hint', 'bad', 'last-move', 'selected', 'option', 'excluded');
  board.setPlacing(state.selectedTray >= 0);
  renderTray();

  const remaining = state.tray.filter((t) => !t.square).length;

  // Single-piece GM puzzles: auto-select the piece so one click places it.
  if ((usingCandidates() || usingExclusions() || usingP4()) && remaining > 0 && state.selectedTray === -1) {
    state.selectedTray = state.tray.findIndex((t) => !t.square);
    board.setPlacing(true);
    renderTray();
  }
  if (usingCandidates()) {
    const map = currentMap();
    for (const sq of state.puzzle.candidates) {
      if (!map[sq]) board.highlight(sq, 'option');
    }
  } else if (usingExclusions()) {
    for (const sq of activeExclusions()) board.highlight(sq, 'excluded');
  }

  let error = null;
  if (remaining === 0) error = validatePosition();

  // Puzzles with precomputed lines don't need the engines at all.
  const canRun = state.enginesReady || Boolean(lineForPlacement());
  els.playBtn.disabled = !(canRun && remaining === 0 && !error);
  els.playBtn.classList.remove('hidden');
  els.stopBtn.classList.add('hidden');
  els.retryBtn.classList.add('hidden');
  // Reset only exists while placing pieces.
  els.resetBtn.classList.remove('hidden');
  els.resetBtn.disabled = false;
  els.trayLabel.classList.remove('hidden');
  els.tray.classList.remove('hidden');

  if (!state.enginesReady && !state.puzzle.lines) {
    setStatus('Loading engines… you can start placing pieces meanwhile.');
  } else if (error) {
    setStatus(error, true);
  } else if (remaining > 0) {
    if (usingCandidates()) {
      setStatus(`Place your ${pieceName(state.tray[0].type)} on one of the ${state.puzzle.candidates.length} highlighted squares. Exactly one of them wins.`);
    } else if (usingExclusions()) {
      setStatus(`Place your ${pieceName(state.tray[0].type)} anywhere except the ✕ squares — those win too obviously. Exactly one legal square wins.${state.proto === 3 ? ' Careful: your opponent moves first!' : ''}`);
    } else if (usingP4()) {
      setStatus(`Place your ${pieceName(state.tray[0].type)} anywhere. At most two squares on the whole board win — and your opponent moves first!`);
    } else {
      setStatus(`Place ${remaining} more piece${remaining > 1 ? 's' : ''}. Click a placed piece to pick it back up.`);
    }
  } else {
    setStatus(usingCandidates() || usingExclusions() || usingP4()
      ? 'Piece placed — press “Play it out”, or click it to try a different square.'
      : 'Position set! Press “Play it out” and the engines will battle it out.');
  }
}

function renderTray() {
  els.tray.innerHTML = '';
  const unplaced = state.tray.filter((t) => !t.square);
  if (unplaced.length === 0) {
    const span = document.createElement('span');
    span.className = 'tray-empty';
    span.textContent = state.phase === 'setup' ? 'All pieces placed ✓' : '—';
    els.tray.appendChild(span);
    return;
  }
  state.tray.forEach((item, i) => {
    if (item.square) return;
    const div = document.createElement('div');
    div.className = `tray-piece ${pieceClass(state.puzzle.player, item.type)}`;
    div.draggable = true;
    div.title = `Place your ${pieceName(item.type)}`;
    if (i === state.selectedTray) div.classList.add('selected');
    div.addEventListener('click', () => {
      state.selectedTray = state.selectedTray === i ? -1 : i;
      refreshSetup();
      if (state.selectedTray >= 0) {
        setStatus(`Now click an empty square for your ${pieceName(item.type)}.`);
      }
    });
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/tray-index', String(i));
    });
    els.tray.appendChild(div);
  });
}

function handleSquareClick(square) {
  if (state.phase !== 'setup') return;
  // Picking a placed piece back up
  const placedIdx = state.tray.findIndex((t) => t.square === square);
  if (placedIdx >= 0 && state.selectedTray === -1) {
    state.tray[placedIdx].square = null;
    state.selectedTray = placedIdx;
    refreshSetup();
    return;
  }
  if (state.selectedTray >= 0) placeSelected(square);
}

function placeSelected(square) {
  const item = state.tray[state.selectedTray];
  if (!item || state.phase !== 'setup') return;
  if (usingCandidates() && !state.puzzle.candidates.includes(square)) {
    setStatus('This puzzle only allows the highlighted squares.', true);
    return;
  }
  if (usingExclusions() && activeExclusions().includes(square)) {
    setStatus('That square is blocked — it wins too obviously. Find the hidden winning square.', true);
    return;
  }
  if (currentMap()[square]) {
    setStatus('That square is occupied — pick an empty one.', true);
    return;
  }
  if (item.type === 'p' && (rankOf(square) === 1 || rankOf(square) === 8)) {
    setStatus('Pawns can’t stand on the first or last rank.', true);
    return;
  }
  item.square = square;
  state.selectedTray = -1;
  refreshSetup();
  board.dropIn(square);
  // Flag the offending piece if the position became illegal.
  if (state.tray.every((t) => t.square) && validatePosition()) {
    board.highlight(square, 'bad');
  }
}

function resetPlacements() {
  state.runId++;
  state.phase = 'setup';
  for (const item of state.tray) item.square = null;
  state.selectedTray = -1;
  els.movelist.innerHTML = '';
  els.banner.classList.add('hidden');
  els.progress.classList.add('hidden');
  setEvalBar(state.baseCp ?? 0);
  refreshSetup();
}

// ---- Playout phase ----

async function play() {
  const error = validatePosition();
  if (error) { setStatus(error, true); return; }

  const runId = ++state.runId;
  state.phase = 'playing';
  els.playBtn.classList.add('hidden');
  els.stopBtn.classList.remove('hidden');
  els.retryBtn.classList.add('hidden');
  els.resetBtn.classList.add('hidden'); // during playout, Stop is the only control
  els.trayLabel.classList.add('hidden');
  els.tray.classList.add('hidden');
  els.movelist.innerHTML = '';
  els.banner.classList.add('hidden');
  els.progress.classList.remove('hidden');
  board.clearHighlights('hint', 'bad', 'selected', 'option', 'excluded');

  const startFen = currentFen();
  const game = new Chess(startFen);
  const uciMoves = []; // full history so the engines can see repetitions
  let plies = 0;

  const queue = [];
  let producerDone = false;

  // Preferred path: a precomputed line ships with the puzzle, so the whole
  // game is known instantly and no engine runs at all.
  let line = lineForPlacement();
  if (line) {
    try {
      const moves = line.m.split(' ');
      const evals = line.e.split(' ').map(Number);
      for (let i = 0; i < moves.length; i++) {
        const uci = moves[i];
        const played = game.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci[4],
        });
        queue.push({
          played,
          fen: game.fen(),
          moveNo: Number(game.fen().split(' ')[5]),
          whiteCp: evals[i] ?? 0,
        });
      }
      producerDone = true;
    } catch (err) {
      console.warn('Stored line failed to replay; falling back to live engines.', err);
      line = null;
      queue.length = 0;
      game.load(startFen);
    }
  }

  if (!line) {
    // Live path: the engines fill the move buffer as fast as they can
    // think — starting during the reveal, so the display never starts dry.
    // Let any in-flight base-position eval finish first so its bestmove
    // can't be mistaken for the playout's.
    if (state.baseEvalSearch) {
      await state.baseEvalSearch.catch(() => {});
      state.baseEvalSearch = null;
    }
    await Promise.all([whiteEngine.init(), blackEngine.init()]);
    await Promise.all([whiteEngine.newGame(), blackEngine.newGame()]);
    if (runId !== state.runId) return;
    (async () => {
      try {
        while (!game.isGameOver()) {
          const side = game.turn();
          const engine = side === 'w' ? whiteEngine : blackEngine;
          const { move, score } = await engine.search(startFen, MOVETIME_MS, uciMoves);
          if (runId !== state.runId) return;
          if (!move || move === '(none)') break;
          const played = game.move({
            from: move.slice(0, 2),
            to: move.slice(2, 4),
            promotion: move[4],
          });
          uciMoves.push(move);
          queue.push({
            played,
            fen: game.fen(),
            moveNo: Number(game.fen().split(' ')[5]),
            whiteCp: scoreToWhiteCp(score, side),
          });
        }
      } finally {
        producerDone = true;
      }
    })();
  }

  // Verdict reveal (~1s) while the buffer fills.
  await playReveal();
  if (runId !== state.runId) return;
  setStatus('Engines are playing… ♜ vs ♜');

  // Consumer: drain the buffer at the user's pace, independent of how fast
  // the engines happen to be thinking.
  while (true) {
    if (!queue.length) {
      if (producerDone) break;
      await sleep(25);
      if (runId !== state.runId) return;
      continue;
    }
    const item = queue.shift();
    const stepStart = performance.now();
    const { played } = item;
    plies++;

    setEvalBar(item.whiteCp);
    board.clearHighlights('last-move');
    board.highlight(played.from, 'last-move');
    board.highlight(played.to, 'last-move');
    // Castling slides the rook along with the king.
    const slides = [{ from: played.from, to: played.to }];
    const homeRank = played.color === 'w' ? 1 : 8;
    if (played.flags.includes('k')) slides.push({ from: `h${homeRank}`, to: `f${homeRank}` });
    if (played.flags.includes('q')) slides.push({ from: `a${homeRank}`, to: `d${homeRank}` });
    await board.animateMoves(slides, fenToMap(item.fen), moveAnimMs());
    if (runId !== state.runId) return;
    appendMove(played, item.moveNo);
    els.progress.textContent = `Move ${Math.ceil(plies / 2)}`;

    const rest = movePaceMs() - (performance.now() - stepStart);
    if (rest > 0) {
      await sleep(rest);
      if (runId !== state.runId) return;
    }
  }

  if (runId !== state.runId) return;
  finish(game);
}

/**
 * Which way is this placement going to go? Known ahead of time for generated
 * puzzles (the engines verified every square); unknown for the classics.
 * @returns {'win'|'loss'|null}
 */
function knownVerdict() {
  const placed = state.tray.find((t) => t.square)?.square;
  if (!placed) return null;
  const p = state.puzzle;
  if (usingCandidates()) return placed === p.solution ? 'win' : 'loss';
  if (state.proto === 2 && p.excluded) return placed === p.solution ? 'win' : 'loss';
  if (state.proto === 3 && p.p3) return placed === p.p3.solution ? 'win' : 'loss';
  if (usingP4()) return openSetData().solutions.includes(placed) ? 'win' : 'loss';
  return null;
}

/** The ~1s win/loss reveal on the placed piece; doubles as buffer-fill time. */
async function playReveal() {
  const placed = state.tray.find((t) => t.square)?.square;
  const verdict = knownVerdict();
  if (verdict === 'win' && placed) {
    setStatus('Direct hit! Now watch it play out…');
    await board.revealWin(placed);
  } else if (verdict === 'loss' && placed) {
    setStatus('That square doesn’t win… watch what happens.', true);
    await board.revealLoss(placed);
  } else {
    // Classics: no verdict data — a short pause still primes the buffer.
    await sleep(600);
  }
}

function appendMove(played, fenMoveNo) {
  // The fullmove counter increments after Black's move, so the FEN taken
  // after the move reads N for White's move and N+1 for Black's.
  const moveNo = played.color === 'w' ? fenMoveNo : fenMoveNo - 1;
  const last = els.movelist.lastElementChild;
  if (played.color === 'b' && last && Number(last.value) === moveNo && !last.dataset.complete) {
    // Black's reply joins White's move on the same row.
    last.textContent += `  ${played.san}`;
    last.dataset.complete = '1';
  } else {
    const li = document.createElement('li');
    li.value = moveNo;
    li.textContent = played.color === 'w' ? played.san : `… ${played.san}`;
    if (played.color === 'b') li.dataset.complete = '1';
    els.movelist.appendChild(li);
  }
  // Keep the newest move visible by scrolling the list itself — never the
  // page (scrollIntoView yanked the viewport down on mobile).
  els.movelist.scrollTop = els.movelist.scrollHeight;
}

function finish(game) {
  const player = state.puzzle.player;
  const playerName = player === 'w' ? 'White' : 'Black';
  let win = false;
  let title, detail;

  if (game.isCheckmate()) {
    const winner = game.turn() === 'w' ? 'b' : 'w';
    win = winner === player;
    if (win && knownVerdict() === 'loss') {
      // The reveal called this square a loss, but the live playout won:
      // the player out-did the precomputed analysis.
      title = 'Unbelievable — you win! 🤯🏆';
      detail = 'You found a winning line outside of the precalculated solutions — ' +
        `${playerName} delivered mate anyway. Take a bow.`;
    } else {
      title = win ? 'Checkmate — you win! 🏆' : 'Checkmate — you lose';
      detail = win
        ? `Your construction was lethal: ${playerName} delivered mate.`
        : `Your position collapsed and ${winner === 'w' ? 'White' : 'Black'} delivered mate.`;
    }
  } else if (game.isDraw()) {
    title = 'Drawn — not a win';
    detail = drawReason(game) + ' A draw doesn’t count: the position has to actually win.';
  } else {
    title = 'Playout ended';
    detail = 'The engines stopped early — try playing it out again.';
  }

  state.phase = 'done';
  els.banner.className = `banner ${win ? 'win' : 'loss'}`;
  els.banner.innerHTML = '';
  els.banner.appendChild(win ? buildConfettiRain() : buildWaves());
  const h2 = document.createElement('h2');
  // Letters animate in one by one, grouped into unbreakable words so the
  // title never wraps mid-word on narrow screens.
  let i = 0;
  for (const word of title.split(' ')) {
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    for (const ch of word) {
      const span = document.createElement('span');
      span.className = 'ltr';
      span.textContent = ch;
      span.style.animationDelay = `${i * 40}ms`;
      wordSpan.appendChild(span);
      i++;
    }
    h2.append(wordSpan, ' ');
    i++; // count the space so the stagger rhythm carries across words
  }
  const p = document.createElement('p');
  p.textContent = detail;
  els.banner.append(h2, p);

  els.stopBtn.classList.add('hidden');
  els.retryBtn.classList.remove('hidden');
  // Reset stays hidden until the player is back in the setup phase.
  setStatus(win
    ? 'You built a winning position. Try the next puzzle!'
    : 'Adjust your piece placement and try again.', !win);
}

/** Gentle confetti rain over the whole board for the win banner. */
function buildConfettiRain() {
  const wrap = document.createElement('div');
  wrap.className = 'confetti-rain';
  const colors = ['#95bb4a', '#ffd24d', '#7fa650', '#ffffff', '#e8a33d'];
  for (let i = 0; i < 55; i++) {
    const bit = document.createElement('span');
    const size = 5 + Math.random() * 5;
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.width = `${size}px`;
    bit.style.height = `${size * (0.6 + Math.random() * 0.8)}px`;
    bit.style.opacity = String(0.55 + Math.random() * 0.45);
    bit.style.animationDuration = `${2.8 + Math.random() * 2.6}s`;
    bit.style.animationDelay = `${Math.random() * 3}s`;
    wrap.appendChild(bit);
  }
  return wrap;
}

/** Layered dark-red waves rolling along the bottom of the loss banner. */
function buildWaves() {
  const wrap = document.createElement('div');
  wrap.className = 'banner-waves';
  for (const cls of ['w1', 'w2', 'w3']) {
    const wave = document.createElement('div');
    wave.className = `wave ${cls}`;
    wrap.appendChild(wave);
  }
  return wrap;
}

function drawReason(game) {
  if (game.isStalemate()) return 'The game ended in stalemate.';
  if (game.isInsufficientMaterial()) return 'Neither side had enough material to mate.';
  if (game.isThreefoldRepetition()) return 'The position repeated three times.';
  return 'The game was drawn by the fifty-move rule.';
}

function stopPlayout() {
  whiteEngine.stop();
  blackEngine.stop();
  resetPlacements(); // stopping also resets the board in one press
  setStatus('Playout stopped and board reset. Place your pieces and try again.');
}

function backToSetup() {
  state.phase = 'setup';
  els.banner.classList.add('hidden');
  els.progress.classList.add('hidden');
  els.movelist.innerHTML = '';
  setEvalBar(state.baseCp ?? 0);
  refreshSetup();
}

// ---- Misc UI ----

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function setEvalBar(whiteCp) {
  // Sigmoid squashing of centipawns into a 0–100% white share.
  const share = 100 / (1 + Math.exp(-whiteCp / 350));
  els.evalFill.style.height = `${share}%`;
}

function pieceName(type) {
  return { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }[type];
}

// ---- Wiring ----

function setPrototype(proto) {
  state.proto = proto;
  localStorage.setItem('chessauto-proto', String(proto));
  for (const btn of document.querySelectorAll('#proto-switch button')) {
    btn.classList.toggle('active', Number(btn.dataset.proto) === proto);
  }
  activePuzzles = puzzlesForProto(proto);
  els.puzzleSelect.innerHTML = '';
  activePuzzles.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i + 1}. ${p.name} (${p.player === 'w' ? 'White' : 'Black'})`;
    els.puzzleSelect.appendChild(opt);
  });
  loadPuzzle(0);
}

for (const btn of document.querySelectorAll('#proto-switch button')) {
  btn.addEventListener('click', () => setPrototype(Number(btn.dataset.proto)));
}
els.speedSlider.value = localStorage.getItem('chessauto-speed') || String(DEFAULT_ANIM_MS);
els.speedValue.textContent = `${els.speedSlider.value} ms`;
els.speedSlider.addEventListener('input', () => {
  els.speedValue.textContent = `${els.speedSlider.value} ms`;
  localStorage.setItem('chessauto-speed', els.speedSlider.value);
});
els.puzzleSelect.addEventListener('change', () => loadPuzzle(Number(els.puzzleSelect.value)));
els.prevPuzzle.addEventListener('click', () => {
  loadPuzzle((Number(els.puzzleSelect.value) + activePuzzles.length - 1) % activePuzzles.length);
});
els.nextPuzzle.addEventListener('click', () => {
  loadPuzzle((Number(els.puzzleSelect.value) + 1) % activePuzzles.length);
});
els.playBtn.addEventListener('click', play);
els.stopBtn.addEventListener('click', stopPlayout);
els.retryBtn.addEventListener('click', backToSetup);
els.resetBtn.addEventListener('click', resetPlacements);

setPrototype(state.proto);

Promise.all([whiteEngine.init(), blackEngine.init()])
  .then(() => {
    state.enginesReady = true;
    if (state.phase === 'setup') refreshSetup();
  })
  .catch((err) => {
    console.error(err);
    setStatus('Failed to load the chess engines. Try reloading the page.', true);
  });
