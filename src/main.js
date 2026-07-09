import { Chess, validateFen } from 'chess.js';
import { PUZZLES } from './puzzles.js';
import { Engine, scoreToWhiteCp } from './engine.js';
import { Board, pieceClass } from './board.js';
import { fenToMap, buildFen, flipTurn, rankOf } from './fen.js';

const MOVETIME_MS = 300; // per engine move during the playout
const DEFAULT_ANIM_MS = 140; // piece-slide duration (user-adjustable via slider)

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

/** Prototype 4: open placement, opponent first, nothing blocked. */
function usingP4() {
  return state.proto === 4 && Boolean(state.puzzle.p4);
}

/** Prototypes 3 and 4 flip the side to move: the opponent replies first. */
function currentTurn() {
  const baseTurn = state.puzzle.fen.split(' ')[1];
  if ((state.proto === 3 && state.puzzle.p3) || usingP4()) {
    return baseTurn === 'w' ? 'b' : 'w';
  }
  return baseTurn;
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
  setEvalBar(0);
  refreshSetup();
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

  els.playBtn.disabled = !(state.enginesReady && remaining === 0 && !error);
  els.playBtn.classList.remove('hidden');
  els.stopBtn.classList.add('hidden');
  els.retryBtn.classList.add('hidden');
  els.resetBtn.disabled = false;
  els.trayLabel.classList.remove('hidden');
  els.tray.classList.remove('hidden');

  if (!state.enginesReady) {
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
  setEvalBar(0);
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
  els.resetBtn.disabled = true;
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

  await Promise.all([whiteEngine.newGame(), blackEngine.newGame()]);
  if (runId !== state.runId) return;

  setStatus('Engines are playing… ♜ vs ♜');
  let lastWhiteCp = 0;

  while (!game.isGameOver()) {
    const sideToMove = game.turn();
    const engine = sideToMove === 'w' ? whiteEngine : blackEngine;
    const { move, score } = await engine.search(startFen, MOVETIME_MS, uciMoves);
    if (runId !== state.runId) return; // playout was cancelled

    if (!move || move === '(none)') break;
    const played = game.move({
      from: move.slice(0, 2),
      to: move.slice(2, 4),
      promotion: move[4],
    });
    uciMoves.push(move);
    plies++;

    lastWhiteCp = scoreToWhiteCp(score, sideToMove);
    setEvalBar(lastWhiteCp);
    board.clearHighlights('last-move');
    board.highlight(played.from, 'last-move');
    board.highlight(played.to, 'last-move');
    // Castling slides the rook along with the king.
    const slides = [{ from: played.from, to: played.to }];
    const homeRank = played.color === 'w' ? 1 : 8;
    if (played.flags.includes('k')) slides.push({ from: `h${homeRank}`, to: `f${homeRank}` });
    if (played.flags.includes('q')) slides.push({ from: `a${homeRank}`, to: `d${homeRank}` });
    await board.animateMoves(slides, fenToMap(game.fen()), moveAnimMs());
    if (runId !== state.runId) return;
    appendMove(played, game);
    els.progress.textContent = `Move ${Math.ceil(plies / 2)}`;
  }

  if (runId !== state.runId) return;
  finish(game);
}

function appendMove(played, game) {
  const moveNo = played.color === 'w' ? game.moveNumber() : game.moveNumber() - 1;
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
    title = win ? 'Checkmate — you win! 🏆' : 'Checkmate — you lose';
    detail = win
      ? `Your construction was lethal: ${playerName} delivered mate.`
      : `Your position collapsed and ${winner === 'w' ? 'White' : 'Black'} delivered mate.`;
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
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  els.banner.append(h2, p);

  els.stopBtn.classList.add('hidden');
  els.retryBtn.classList.remove('hidden');
  els.resetBtn.disabled = false;
  setStatus(win
    ? 'You built a winning position. Try the next puzzle!'
    : 'Adjust your piece placement and try again.', !win);
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
  setEvalBar(0);
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
