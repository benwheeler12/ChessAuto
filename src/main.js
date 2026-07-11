import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import { Chess, validateFen } from 'chess.js';
import { COLLECTIONS } from './puzzles/index.js';
import { Engine, scoreToWhiteCp } from './engine.js';
import { Board, pieceClass } from './board.js';
import { fenToMap, buildFen } from './fen.js';
import {
  turnFor, signature, startFen, placementError, startPositionError,
  expectedVerdict, lineFor, ruleChips, allowedIslands,
} from './puzzle-contract.js';

const MOVETIME_MS = 300; // per engine move during the playout
const DEFAULT_ANIM_MS = 50; // piece-slide duration (user-adjustable via slider)

/** Board slides for a move (castling moves the rook too). */
function slidesFor(mv) {
  const slides = [{ from: mv.from, to: mv.to }];
  const homeRank = mv.color === 'w' ? 1 : 8;
  if (mv.flags.includes('k')) slides.push({ from: `h${homeRank}`, to: `f${homeRank}` });
  if (mv.flags.includes('q')) slides.push({ from: `a${homeRank}`, to: `d${homeRank}` });
  return slides;
}

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
  collectionSelect: $('collection-select'),
  puzzleSelect: $('puzzle-select'),
  prevPuzzle: $('prev-puzzle'),
  nextPuzzle: $('next-puzzle'),
  puzzleName: $('puzzle-name'),
  puzzleDesc: $('puzzle-desc'),
  ruleChips: $('rule-chips'),
  status: $('status'),
  tray: $('tray'),
  trayLabel: $('tray-label'),
  resetBtn: $('reset-btn'),
  playBtn: $('play-btn'),
  stopBtn: $('stop-btn'),
  backBtn: $('back-btn'),
  fwdBtn: $('fwd-btn'),
  continueBtn: $('continue-btn'),
  retryBtn: $('retry-btn'),
  lichessBtn: $('lichess-btn'),
  progress: $('progress'),
  movelist: $('movelist'),
  speedSlider: $('speed-slider'),
  speedValue: $('speed-value'),
};

/** Piece-slide duration in ms, from the user-adjustable slider. */
function moveAnimMs() {
  return Number(els.speedSlider.value) || DEFAULT_ANIM_MS;
}

// ---- Played / rating history (drives NEW badges and the fun-research loop) ----
const played = new Set(JSON.parse(localStorage.getItem('chessauto-played') ?? '[]'));
const ratings = JSON.parse(localStorage.getItem('chessauto-ratings') ?? '{}');

function markPlayed(id) {
  if (played.has(id)) return;
  played.add(id);
  localStorage.setItem('chessauto-played', JSON.stringify([...played]));
  renderCollectionOptions();
  renderPuzzleOptions();
}

function ratePuzzle(id, value) {
  ratings[id] = ratings[id] === value ? undefined : value;
  if (ratings[id] === undefined) delete ratings[id];
  localStorage.setItem('chessauto-ratings', JSON.stringify(ratings));
}

// ---- State ----
const state = {
  collection: 0, // index into COLLECTIONS (0 = newest batch)
  puzzle: COLLECTIONS[0].puzzles[0],
  phase: 'setup', // 'setup' | 'playing' | 'done'
  baseMap: {},
  tray: [], // [{ type, square: string|null }]
  selectedTray: -1,
  enginesReady: false,
  runId: 0,
  baseCp: 0,
  playoutFen: null, // FEN currently shown on the board during/after a playout
  pauseControls: null, // ◀ ▶ Continue handlers while a playout is paused
};

const activePuzzles = () => COLLECTIONS[state.collection].puzzles;

/** Current placements from the tray (only pieces already on the board). */
function placements() {
  return state.tray.filter((t) => t.square).map((t) => ({ type: t.type, square: t.square }));
}

const allPlaced = () => state.tray.every((t) => t.square);

const whiteEngine = new Engine('white');
const blackEngine = new Engine('black');

const board = new Board(els.board, {
  onSquareClick: handleSquareClick,
  onDropPiece: (trayIndex, square) => {
    state.selectedTray = trayIndex;
    placeSelected(square);
  },
  onMovePiece: (from, to) => movePlaced(from, to),
});

// The tray doubles as a drop target: drag a placed piece back to unplace it.
els.tray.addEventListener('dragover', (e) => e.preventDefault());
els.tray.addEventListener('drop', (e) => {
  e.preventDefault();
  const from = e.dataTransfer.getData('text/from-square');
  if (from) returnToTray(from);
});

// ---- Setup phase ----

function loadPuzzle(index) {
  state.runId++; // cancels any playout in flight
  const puzzle = activePuzzles()[index];
  state.puzzle = puzzle;
  state.phase = 'setup';
  state.baseMap = fenToMap(puzzle.fen);
  state.tray = puzzle.place.map((type) => ({ type, square: null }));
  state.selectedTray = -1;

  els.puzzleSelect.value = String(index);
  els.puzzleName.textContent = puzzle.name;
  els.puzzleDesc.textContent = puzzle.description;
  els.ruleChips.innerHTML = '';
  for (const chip of ruleChips(puzzle)) {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = chip;
    els.ruleChips.appendChild(span);
  }
  els.movelist.innerHTML = '';
  els.banner.classList.add('hidden');
  els.progress.classList.add('hidden');
  board.setOrientation(puzzle.player);
  showBaseEval();
  refreshSetup();
}

// ---- Base-position evaluation for the eval bar ----
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
  const fen = buildFen(state.baseMap, turnFor(state.puzzle));
  try {
    await whiteEngine.init();
    if (state.baseEvalSearch) await state.baseEvalSearch.catch(() => {});
    if (token !== baseEvalToken || state.phase !== 'setup') return;
    state.baseEvalSearch = whiteEngine.search(fen, 250);
    const { score } = await state.baseEvalSearch;
    state.baseEvalSearch = null;
    if (token !== baseEvalToken || state.phase !== 'setup') return;
    state.baseCp = scoreToWhiteCp(score, fen.split(' ')[1]);
    setEvalBar(state.baseCp);
  } catch {
    // Engines unavailable — leave the bar neutral.
  }
}

function currentMap() {
  const map = { ...state.baseMap };
  for (const p of placements()) {
    map[p.square] = { type: p.type, color: state.puzzle.player, placed: true };
  }
  return map;
}

function refreshSetup() {
  const puzzle = state.puzzle;
  board.setPosition(currentMap());
  board.clearHighlights('hint', 'bad', 'last-move', 'selected', 'option', 'excluded');
  renderTray();

  const remaining = state.tray.filter((t) => !t.square).length;

  // Single-piece puzzles: auto-select the piece so one click places it.
  if (puzzle.place.length === 1 && remaining > 0 && state.selectedTray === -1) {
    state.selectedTray = 0;
    renderTray();
  }
  board.setPlacing(state.selectedTray >= 0);

  // Constraint markers come straight from the contract: every island of
  // cardinally adjacent allowed squares gets one traced border (isolated
  // squares get their own). The 'option' class keeps hover/click affordance.
  const map = currentMap();
  board.showZones(allowedIslands(puzzle));
  for (const sq of puzzle.placement?.allowed ?? []) {
    if (!map[sq]) board.highlight(sq, 'option');
  }
  for (const sq of puzzle.placement?.blocked ?? []) {
    board.highlight(sq, 'excluded');
  }
  // A placed piece selected in place keeps a visible ring until it moves.
  const selectedItem = state.tray[state.selectedTray];
  if (selectedItem?.square) board.highlight(selectedItem.square, 'selected');

  let error = null;
  if (remaining === 0) error = startPositionError(puzzle, placements());

  const canRun = state.enginesReady || Boolean(allPlaced() && lineFor(puzzle, placements()));
  els.playBtn.disabled = !(canRun && remaining === 0 && !error);
  els.playBtn.classList.remove('hidden');
  els.stopBtn.classList.add('hidden');
  els.backBtn.classList.add('hidden');
  els.fwdBtn.classList.add('hidden');
  els.continueBtn.classList.add('hidden');
  els.retryBtn.classList.add('hidden');
  els.resetBtn.classList.remove('hidden');
  els.resetBtn.disabled = false;
  els.trayLabel.classList.remove('hidden');
  els.tray.classList.remove('hidden');

  if (!state.enginesReady && !puzzle.lines) {
    setStatus('Loading engines… you can start placing pieces meanwhile.');
  } else if (error) {
    setStatus(error, true);
  } else if (remaining > 0) {
    setStatus(setupHint(puzzle, remaining));
  } else {
    setStatus(puzzle.place.length === 1
      ? 'Piece placed — press “Play it out”, or click/drag it to a different square.'
      : 'Position set! Press “Play it out” — or click/drag a piece to rearrange.');
  }
}

/** Setup instruction derived from the contract. */
function setupHint(puzzle, remaining) {
  const piece = pieceName(state.tray.find((t) => !t.square)?.type);
  let hint;
  if (puzzle.placement?.allowed) {
    hint = `Place your ${piece} on one of the ${puzzle.placement.allowed.length} highlighted squares.`;
  } else if (puzzle.placement?.blocked) {
    hint = `Place your ${piece} anywhere except the ✕ squares — those win too obviously.`;
  } else if (puzzle.place.length > 1) {
    hint = `Place ${remaining} more piece${remaining > 1 ? 's' : ''}. Click a placed piece to pick it back up.`;
  } else {
    hint = `Place your ${piece} anywhere.`;
  }
  if (puzzle.solutions) {
    hint += puzzle.solutions.length === 1
      ? ' Exactly one placement wins.'
      : ` ${puzzle.solutions.length} placements win.`;
  }
  if (puzzle.firstMove === 'opponent') hint += ' Careful: your opponent moves first!';
  return hint;
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
  const placedIdx = state.tray.findIndex((t) => t.square === square);
  if (placedIdx >= 0) {
    // Clicking a placed piece selects it IN PLACE (click again to deselect,
    // click another placed piece to switch); the next square click moves it.
    state.selectedTray = state.selectedTray === placedIdx ? -1 : placedIdx;
    refreshSetup();
    if (state.selectedTray >= 0) {
      setStatus(`Now click a new square for your ${pieceName(state.tray[placedIdx].type)} — or drag it there.`);
    }
    return;
  }
  if (state.selectedTray >= 0) placeSelected(square);
}

/** Board occupancy as placementError expects it, minus one moving piece. */
function occupiedExcept(item) {
  const map = { ...state.baseMap };
  for (const p of state.tray) {
    if (p !== item && p.square) map[p.square] = { type: p.type, color: state.puzzle.player, placed: true };
  }
  return map;
}

function placeSelected(square) {
  const item = state.tray[state.selectedTray];
  if (!item || state.phase !== 'setup') return;
  // Validate against the board WITHOUT the moving piece, so relocating a
  // placed piece isn't blocked by its own old square's constraints.
  const error = placementError(state.puzzle, square, item.type, occupiedExcept(item));
  if (error) {
    setStatus(error, true);
    return;
  }
  item.square = square;
  state.selectedTray = -1;
  refreshSetup();
  board.dropIn(square);
  if (allPlaced() && startPositionError(state.puzzle, placements())) {
    board.highlight(square, 'bad');
  }
}

/** Drag a placed piece to another square (validated like a click-move). */
function movePlaced(fromSquare, toSquare) {
  if (state.phase !== 'setup' || fromSquare === toSquare) return;
  const idx = state.tray.findIndex((t) => t.square === fromSquare);
  if (idx < 0) return;
  state.selectedTray = idx;
  placeSelected(toSquare);
  if (state.tray[idx].square === fromSquare) {
    // The move was refused: drop the selection the drag implied, but leave
    // the refusal message on screen (nothing was rendered as selected).
    state.selectedTray = -1;
  }
}

/** Drag a placed piece back to the tray to unplace it. */
function returnToTray(fromSquare) {
  if (state.phase !== 'setup') return;
  const idx = state.tray.findIndex((t) => t.square === fromSquare);
  if (idx < 0) return;
  state.tray[idx].square = null;
  state.selectedTray = -1;
  refreshSetup();
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
  const error = startPositionError(state.puzzle, placements());
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
  board.clearZones();

  const fen = startFen(state.puzzle, placements());
  state.playoutFen = fen;
  const game = new Chess(fen);
  const uciMoves = []; // full history so the engines can see repetitions
  let plies = 0;

  const queue = [];
  let producerDone = false;

  // Preferred path: a precomputed line ships with the puzzle.
  let line = lineFor(state.puzzle, placements());
  if (line) {
    try {
      const moves = line.m.split(' ');
      const evals = line.e.split(' ').map(Number);
      for (let i = 0; i < moves.length; i++) {
        const uci = moves[i];
        const playedMove = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        queue.push({
          played: playedMove,
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
      game.load(fen);
    }
  }

  if (!line) {
    // Live path: the engines fill the buffer as fast as they can think.
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
          const { move, score } = await engine.search(fen, MOVETIME_MS, uciMoves);
          if (runId !== state.runId) return;
          if (!move || move === '(none)') break;
          const playedMove = game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
          uciMoves.push(move);
          queue.push({
            played: playedMove,
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

  await playReveal();
  if (runId !== state.runId) return;

  /** Red/green pop on the landing square when a move captures something. */
  const flashCapture = (mv) => {
    if (!mv.flags.includes('c') && !mv.flags.includes('e')) return;
    board.captureFlash(mv.to, mv.color === state.puzzle.player ? 'good' : 'bad');
  };

  /** Animate one buffered move onto the board at the given pace. */
  async function applyMove(item, paceMs, animMs) {
    const stepStart = performance.now();
    const { played: mv } = item;
    plies++;

    setEvalBar(item.whiteCp);
    board.clearHighlights('last-move');
    board.highlight(mv.from, 'last-move');
    board.highlight(mv.to, 'last-move');
    await board.animateMoves(slidesFor(mv), fenToMap(item.fen), animMs);
    if (runId !== state.runId) return;
    flashCapture(mv);
    state.playoutFen = item.fen;
    appendMove(mv, item.moveNo);
    // Fifty-move rule watch: the FEN's halfmove clock counts plies since the
    // last capture or pawn move; at 100 the game is drawn. Surface it once a
    // draw is genuinely on the horizon so long grinds aren't a mystery.
    const quietPlies = Number(item.fen.split(' ')[4]);
    els.progress.textContent = quietPlies >= 60
      ? `Move ${Math.ceil(plies / 2)} · no captures or pawn moves for ${Math.floor(quietPlies / 2)} — drawn at 50`
      : `Move ${Math.ceil(plies / 2)}`;

    const rest = paceMs - (performance.now() - stepStart);
    if (rest > 0) await sleep(rest);
  }

  // ---- The playout, shaped by the verdict ----
  // A winning placement is a reward: play the whole game out immediately at
  // the user's speed. A losing placement is a lesson: don't auto-play at all —
  // hand over ◀ ▶ stepping right away so the player can inspect WHY it loses,
  // with an optional button to run the rest to completion.
  const verdict = allPlaced() ? expectedVerdict(state.puzzle, placements()) : null;
  const history = []; // stepped-through moves during a loss review
  let reviewIdx = -1; // -1 = the constructed start position

  if (verdict === 'loss') {
    state.phase = 'paused';
    els.backBtn.classList.remove('hidden');
    els.fwdBtn.classList.remove('hidden');
    els.continueBtn.classList.remove('hidden');
    setStatus('That placement doesn’t win. Step ▶ through the moves to see why, or play it out.', true);
    els.progress.textContent = 'Step ▶ to see the first move';

    let resume = false;
    let stepping = false;
    const syncButtons = () => {
      els.backBtn.disabled = stepping || reviewIdx <= -1;
      els.fwdBtn.disabled = stepping
        || (reviewIdx >= history.length - 1 && !queue.length && producerDone);
      els.continueBtn.disabled = stepping;
    };
    const progressText = () => {
      els.progress.textContent = reviewIdx >= 0
        ? `Move ${Math.ceil((reviewIdx + 1) / 2)} · ply ${reviewIdx + 1}`
        : 'The starting position — step ▶ to see the first move';
    };
    const showReview = () => {
      const shown = reviewIdx >= 0 ? history[reviewIdx] : null;
      board.setPosition(fenToMap(shown ? shown.fen : fen));
      board.clearHighlights('last-move');
      if (shown) {
        board.highlight(shown.played.from, 'last-move');
        board.highlight(shown.played.to, 'last-move');
      }
      setEvalBar(shown ? shown.whiteCp : (state.baseCp ?? 0));
      state.playoutFen = shown ? shown.fen : fen;
      progressText();
      syncButtons();
    };
    const stepForward = async () => {
      if (stepping || resume) return;
      if (reviewIdx < history.length - 1) {
        // Re-advancing over moves already seen.
        reviewIdx++;
        showReview();
        return;
      }
      if (!queue.length) {
        if (!producerDone) setStatus('The engines are still thinking — try again in a moment.', true);
        return;
      }
      stepping = true;
      syncButtons();
      const item = queue.shift();
      history.push(item);
      reviewIdx++;
      plies++;
      const mv = item.played;
      board.clearHighlights('last-move');
      board.highlight(mv.from, 'last-move');
      board.highlight(mv.to, 'last-move');
      await board.animateMoves(slidesFor(mv), fenToMap(item.fen), 150);
      if (runId !== state.runId) return;
      flashCapture(mv);
      setEvalBar(item.whiteCp);
      state.playoutFen = item.fen;
      appendMove(mv, item.moveNo);
      progressText();
      stepping = false;
      syncButtons();
      // Stepped all the way to the end of the game: show the verdict.
      if (producerDone && !queue.length) resume = true;
    };

    syncButtons();
    state.pauseControls = {
      back: () => { if (!stepping && reviewIdx > -1) { reviewIdx--; showReview(); } },
      fwd: () => { stepForward(); },
      cont: () => { if (!stepping) resume = true; },
    };
    while (!resume) {
      await sleep(60);
      if (runId !== state.runId) { state.pauseControls = null; return; }
    }
    state.pauseControls = null;
    state.phase = 'playing';
    els.backBtn.classList.add('hidden');
    els.fwdBtn.classList.add('hidden');
    els.continueBtn.classList.add('hidden');
    if (history.length && reviewIdx < history.length - 1) {
      // Snap forward to the furthest stepped position before playing on.
      const last = history[history.length - 1];
      board.setPosition(fenToMap(last.fen));
      board.clearHighlights('last-move');
      board.highlight(last.played.from, 'last-move');
      board.highlight(last.played.to, 'last-move');
      setEvalBar(last.whiteCp);
      state.playoutFen = last.fen;
    }
  }

  // ---- Play (the rest of) the game at the user's pace ----
  setStatus('Engines are playing… ♜ vs ♜');
  while (true) {
    if (!queue.length) {
      if (producerDone) break;
      await sleep(25);
      if (runId !== state.runId) return;
      continue;
    }
    const item = queue.shift();
    await applyMove(item, movePaceMs(), moveAnimMs());
    if (runId !== state.runId) return;
  }

  if (runId !== state.runId) return;
  finish(game);
}

/** The ~1s win/loss reveal on the placed piece(s); doubles as buffer-fill time. */
async function playReveal() {
  const verdict = allPlaced() ? expectedVerdict(state.puzzle, placements()) : null;
  const squares = placements().map((p) => p.square);
  if (verdict === 'win' && squares.length) {
    setStatus('Direct hit! Now watch it play out…');
    await board.revealWin(squares);
  } else if (verdict === 'loss' && squares.length) {
    setStatus('That placement doesn’t win… watch what happens.', true);
    await board.revealLoss(squares);
  } else {
    // No verdict data — a short pause still primes the buffer.
    await sleep(600);
  }
}

function appendMove(mv, fenMoveNo) {
  const moveNo = mv.color === 'w' ? fenMoveNo : fenMoveNo - 1;
  const last = els.movelist.lastElementChild;
  if (mv.color === 'b' && last && Number(last.value) === moveNo && !last.dataset.complete) {
    last.textContent += `  ${mv.san}`;
    last.dataset.complete = '1';
  } else {
    const li = document.createElement('li');
    li.value = moveNo;
    li.textContent = mv.color === 'w' ? mv.san : `… ${mv.san}`;
    if (mv.color === 'b') li.dataset.complete = '1';
    els.movelist.appendChild(li);
  }
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
    const verdict = allPlaced() ? expectedVerdict(state.puzzle, placements()) : null;
    if (win && verdict === 'loss') {
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
  markPlayed(state.puzzle.id);
  els.banner.className = `banner ${win ? 'win' : 'loss'}`;
  els.banner.innerHTML = '';
  els.banner.appendChild(win ? buildConfettiRain() : buildWaves());
  const h2 = document.createElement('h2');
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
    i++;
  }
  const p = document.createElement('p');
  p.textContent = detail;
  els.banner.append(h2, p, buildRatingRow());

  els.stopBtn.classList.add('hidden');
  els.backBtn.classList.add('hidden');
  els.fwdBtn.classList.add('hidden');
  els.continueBtn.classList.add('hidden');
  els.retryBtn.classList.remove('hidden');
  setStatus(win
    ? 'You built a winning position. Try the next puzzle!'
    : 'Adjust your piece placement and try again.', !win);
}

/** 👍/👎 row on the results banner — the fun-research feedback signal. */
function buildRatingRow() {
  const row = document.createElement('div');
  row.className = 'rating-row';
  const label = document.createElement('span');
  label.textContent = 'Fun puzzle?';
  row.appendChild(label);
  for (const [value, glyph] of [[1, '👍'], [-1, '👎']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = glyph;
    btn.classList.toggle('active', ratings[state.puzzle.id] === value);
    btn.addEventListener('click', () => {
      ratePuzzle(state.puzzle.id, value);
      for (const b of row.querySelectorAll('button')) b.classList.remove('active');
      if (ratings[state.puzzle.id] === value) btn.classList.add('active');
    });
    row.appendChild(btn);
  }
  return row;
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
  if (game.isDrawByFiftyMoves()) {
    return 'Fifty consecutive moves passed without a capture or a pawn move — ' +
      'drawn by the fifty-move rule.';
  }
  return 'The game was drawn.';
}

function stopPlayout() {
  whiteEngine.stop();
  blackEngine.stop();
  resetPlacements();
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

/** The FEN of whatever the board is showing right now. */
function viewFen() {
  if (state.phase !== 'setup' && state.playoutFen) return state.playoutFen;
  return buildFen(currentMap(), turnFor(state.puzzle));
}

/**
 * Open the current position in the Lichess analysis board. Positions that
 * aren't legal chess yet (e.g. a king puzzle before the king is placed) go
 * to the board editor instead.
 */
function openInLichess() {
  const fen = viewFen();
  const path = validateFen(fen).ok ? 'analysis/standard' : 'editor';
  window.open(`https://lichess.org/${path}/${fen.replace(/ /g, '_')}`, '_blank', 'noopener');
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function setEvalBar(whiteCp) {
  const share = 100 / (1 + Math.exp(-whiteCp / 350));
  els.evalFill.style.height = `${share}%`;
}

function pieceName(type) {
  return { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }[type];
}

// ---- Collections & wiring ----

function renderCollectionOptions() {
  const current = els.collectionSelect.value;
  els.collectionSelect.innerHTML = '';
  COLLECTIONS.forEach((collection, i) => {
    const fresh = collection.puzzles.filter((p) => !played.has(p.id)).length;
    const date = new Date(collection.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${collection.label} — ${date}${fresh ? ` (${fresh} new)` : ''}`;
    els.collectionSelect.appendChild(opt);
  });
  els.collectionSelect.value = current !== '' && Number(current) < COLLECTIONS.length ? current : String(state.collection);
}

function renderPuzzleOptions() {
  const current = els.puzzleSelect.value;
  els.puzzleSelect.innerHTML = '';
  activePuzzles().forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i + 1}. ${p.name}${played.has(p.id) ? '' : ' •'}`;
    els.puzzleSelect.appendChild(opt);
  });
  if (current !== '' && Number(current) < activePuzzles().length) els.puzzleSelect.value = current;
}

function setCollection(index) {
  state.collection = index;
  els.collectionSelect.value = String(index);
  renderPuzzleOptions();
  loadPuzzle(0);
}

els.collectionSelect.addEventListener('change', () => setCollection(Number(els.collectionSelect.value)));
els.puzzleSelect.addEventListener('change', () => loadPuzzle(Number(els.puzzleSelect.value)));
els.prevPuzzle.addEventListener('click', () => {
  loadPuzzle((Number(els.puzzleSelect.value) + activePuzzles().length - 1) % activePuzzles().length);
});
els.nextPuzzle.addEventListener('click', () => {
  loadPuzzle((Number(els.puzzleSelect.value) + 1) % activePuzzles().length);
});
els.playBtn.addEventListener('click', play);
els.stopBtn.addEventListener('click', stopPlayout);
els.retryBtn.addEventListener('click', backToSetup);
els.resetBtn.addEventListener('click', resetPlacements);
els.lichessBtn.addEventListener('click', openInLichess);
els.backBtn.addEventListener('click', () => state.pauseControls?.back());
els.fwdBtn.addEventListener('click', () => state.pauseControls?.fwd());
els.continueBtn.addEventListener('click', () => state.pauseControls?.cont());
document.addEventListener('keydown', (e) => {
  if (!state.pauseControls) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); state.pauseControls.back(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); state.pauseControls.fwd(); }
});
els.speedSlider.value = localStorage.getItem('chessauto-speed') || String(DEFAULT_ANIM_MS);
els.speedValue.textContent = `${els.speedSlider.value} ms`;
els.speedSlider.addEventListener('input', () => {
  els.speedValue.textContent = `${els.speedSlider.value} ms`;
  localStorage.setItem('chessauto-speed', els.speedSlider.value);
});

renderCollectionOptions();
setCollection(0); // newest batch is always the default view

Promise.all([whiteEngine.init(), blackEngine.init()])
  .then(() => {
    state.enginesReady = true;
    if (state.phase === 'setup') refreshSetup();
  })
  .catch((err) => {
    console.error(err);
    setStatus('Failed to load the chess engines. Try reloading the page.', true);
  });
