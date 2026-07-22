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
const DEFAULT_ANIM_MS = 100; // piece-slide duration (user-adjustable via slider)

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
  puzzleSelect: $('puzzle-select'),
  prevPuzzle: $('prev-puzzle'),
  nextPuzzle: $('next-puzzle'),
  puzzleName: $('puzzle-name'),
  materialLine: $('material-line'),
  matW: $('mat-w'),
  matB: $('mat-b'),
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
  howTo: $('how-to'),
  progress: $('progress'),
  speedSlider: $('speed-slider'),
  speedValue: $('speed-value'),
};

/** Piece-slide duration in ms, from the user-adjustable slider. */
function moveAnimMs() {
  return Number(els.speedSlider.value) || DEFAULT_ANIM_MS;
}

// ---- Played history (drives the • unplayed markers) ----
const played = new Set(JSON.parse(localStorage.getItem('chessauto-played') ?? '[]'));

function markPlayed(id) {
  if (played.has(id)) return;
  played.add(id);
  localStorage.setItem('chessauto-played', JSON.stringify([...played]));
  renderPuzzleOptions();
}

// ---- Material counter ----
// Total piece value per side, shown above the puzzle and kept live during
// playouts. In setup it includes the player's still-unplayed tray pieces,
// so the number reflects the full army the position will start with.
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

let lastMaterial = { id: null, w: null, b: null };

/** Jump the counter to a scaled, colored peak, then decay slowly back to
 * its normal size and color. A new pulse restarts the decay from the peak;
 * nothing else interrupts it (the spans are persistent, so re-renders of
 * the numbers don't touch the transition). */
function pulseCounter(span, good) {
  span.style.transition = 'none';
  span.style.transform = 'scale(1.5)';
  span.style.color = good ? '#6edc64' : '#e65041';
  void span.offsetWidth; // commit the peak before enabling the decay
  span.style.transition = 'transform 2.4s ease-out, color 2.4s ease-out';
  span.style.transform = 'scale(1)';
  span.style.color = ''; // decays back to the stylesheet color
}

function resetCounter(span) {
  span.style.transition = 'none';
  span.style.transform = '';
  span.style.color = '';
}

function showMaterial(map, { includeTray = false } = {}) {
  const total = { w: 0, b: 0 };
  for (const piece of Object.values(map)) total[piece.color] += PIECE_VALUES[piece.type];
  if (includeTray) {
    for (const t of state.tray) if (!t.square) total[state.puzzle.player] += PIECE_VALUES[t.type];
  }
  const spans = { w: els.matW, b: els.matB };
  const samePuzzle = lastMaterial.id === state.puzzle.id;
  for (const [side, label] of [['w', 'White'], ['b', 'Black']]) {
    spans[side].textContent = `${label} ${total[side]}`;
    if (!samePuzzle) {
      resetCounter(spans[side]);
    } else if (lastMaterial[side] !== total[side]) {
      // Green when the swing favors the player (opponent lost material, or
      // the player promoted), red when it hurts them.
      const delta = total[side] - lastMaterial[side];
      const good = (side === state.puzzle.player) === (delta > 0);
      pulseCounter(spans[side], good);
    }
  }
  lastMaterial = { id: state.puzzle.id, ...total };
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

// Engine ownership model: every engine has exactly ONE caller, so two
// searches can never overlap on the same worker (an overlapping 'go'
// wedges this WASM build permanently — it stops answering everything).
//  - evalEngine: persistent, owned solely by showBaseEval, which awaits
//    its own previous search — serialized by construction.
//  - playout: a FRESH disposable engine per run (it plays both sides),
//    terminated on any cancellation. A dead worker can't leak state.
const evalEngine = new Engine('eval');
let playoutEngine = null;

function killPlayoutEngine() {
  playoutEngine?.terminate();
  playoutEngine = null;
}

const board = new Board(els.board, { onSquareClick: handleSquareClick });

// ---- Setup phase ----

function loadPuzzle(index) {
  state.runId++; // cancels any playout in flight
  killPlayoutEngine(); // …and its engine with it — dead workers can't leak
  const puzzle = activePuzzles()[index];
  state.puzzle = puzzle;
  state.phase = 'setup';
  state.baseMap = fenToMap(puzzle.fen);
  state.tray = puzzle.place.map((type) => ({ type, square: null }));
  state.selectedTray = -1;
  undoStack.length = 0;

  els.puzzleSelect.value = String(index);
  els.puzzleName.textContent = `Puzzle ${index + 1}`;
  const playerName = puzzle.player === 'w' ? 'White' : 'Black';
  const moverName = turnFor(puzzle) === 'w' ? 'White' : 'Black';
  const winners = puzzle.solutions?.length ?? 1;
  const winnersWord = ['zero', 'one', 'two', 'three', 'four'][winners] ?? String(winners);
  els.howTo.textContent = `Place the missing pieces on the board so the position is winning for ${playerName}. `
    + `Then watch the game play out between two Stockfish engines. `
    + `Most combinations lose or draw; at most only ${winnersWord} combination${winners === 1 ? ' is' : 's are'} winning for ${playerName}. `
    + `${moverName} to move.`;
  // Show only the task instructions — the source-game provenance sentence
  // ("From a Lichess game (…), around move N.") stays in the data, not the UI.
  els.puzzleDesc.textContent = puzzle.description
    .replace(/^From a Lichess game \([^)]*\), around move \d+\.\s*/, '')
    .replace(/(?:Exactly one arrangement wins|Only \d+ of the \d+ arrangements win), and the opponent moves first\.\s*$/, '')
    .replace(/\s*The opponent moves first\.\s*$/, '');
  els.ruleChips.innerHTML = '';
  for (const chip of ruleChips(puzzle)) {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = chip;
    els.ruleChips.appendChild(span);
  }
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
    await evalEngine.init();
    if (state.baseEvalSearch) await state.baseEvalSearch.catch(() => {});
    if (token !== baseEvalToken || state.phase !== 'setup') return;
    state.baseEvalSearch = evalEngine.search(fen, 250);
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
  board.clearHighlights('hint', 'bad', 'last-move', 'selected', 'option', 'excluded', 'illegal');
  showMaterial(currentMap(), { includeTray: true });
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
  // Selecting a pawn dims the back ranks it can never stand on.
  const selectedItem0 = state.tray[state.selectedTray];
  const selectedType = selectedItem0?.type;
  if (selectedType === 'p') {
    for (const file of 'abcdefgh') {
      for (const rank of [1, 8]) {
        if (!map[file + rank]) board.highlight(file + rank, 'illegal');
      }
    }
  }
  // Selecting a bishop dims every square of a shade a friendly bishop
  // already holds — same-shade bishop pairs are not allowed.
  if (selectedType === 'b') {
    const takenShades = new Set();
    for (const [sq, piece] of Object.entries(map)) {
      if (piece.type === 'b' && piece.color === puzzle.player && sq !== selectedItem0?.square) {
        takenShades.add(squareShade(sq));
      }
    }
    if (takenShades.size) {
      for (const file of 'abcdefgh') {
        for (let rank = 1; rank <= 8; rank++) {
          const sq = file + rank;
          if (!map[sq] && takenShades.has(squareShade(sq))) board.highlight(sq, 'illegal');
        }
      }
    }
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
    hint = `Place your ${piece} on a highlighted square${remaining > 1 ? ` — ${remaining} pieces to go` : ''}.`;
  } else if (puzzle.placement?.blocked) {
    hint = `Place your ${piece} anywhere except the ✕ squares.`;
  } else if (puzzle.place.length > 1) {
    hint = `Place ${remaining} more piece${remaining > 1 ? 's' : ''}.`;
  } else {
    hint = `Place your ${piece} anywhere.`;
  }
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
    div.dataset.index = String(i); // the pointer-drag engine reads this
    div.title = `Place your ${pieceName(item.type)}`;
    if (i === state.selectedTray) div.classList.add('selected');
    div.addEventListener('click', () => {
      state.selectedTray = state.selectedTray === i ? -1 : i;
      refreshSetup();
      if (state.selectedTray >= 0) {
        setStatus(`Now click an empty square for your ${pieceName(item.type)}.`);
      }
    });
    els.tray.appendChild(div);
  });
}

function handleSquareClick(square) {
  if (state.phase !== 'setup') return;
  const placedIdx = state.tray.findIndex((t) => t.square === square);
  if (placedIdx >= 0) {
    if (state.selectedTray === placedIdx) {
      state.selectedTray = -1; // clicking the selected piece deselects it
      refreshSetup();
      return;
    }
    if (state.selectedTray >= 0) {
      placeSelected(square); // onto another placed piece = swap/exchange
      return;
    }
    // Nothing selected: select the placed piece IN PLACE.
    state.selectedTray = placedIdx;
    refreshSetup();
    setStatus(`Now click a new square for your ${pieceName(state.tray[placedIdx].type)} — `
      + 'click another placed piece to swap, or drag it anywhere.');
    return;
  }
  if (state.selectedTray >= 0) placeSelected(square);
}

/** 0 = dark square, 1 = light square. */
const squareShade = (sq) => (sq.charCodeAt(0) - 97 + Number(sq[1])) % 2;

/** Bishops must stand on opposite shades: placing `type` on `square` is
 * refused when a friendly bishop already holds that shade. */
function bishopShadeError(type, square, occupied) {
  if (type !== 'b') return null;
  for (const [sq, piece] of Object.entries(occupied)) {
    if (piece.type === 'b' && piece.color === state.puzzle.player
      && squareShade(sq) === squareShade(square)) {
      return 'A friendly bishop already covers that square color — bishops must stand on opposite shades.';
    }
  }
  return null;
}

/** Board occupancy as placementError expects it, minus the given pieces. */
function occupiedExcept(...items) {
  const map = { ...state.baseMap };
  for (const p of state.tray) {
    if (!items.includes(p) && p.square) map[p.square] = { type: p.type, color: state.puzzle.player, placed: true };
  }
  return map;
}

// ---- Placement undo (Ctrl/Cmd+Z) ----
const undoStack = [];
function pushUndo() {
  undoStack.push(state.tray.map((t) => t.square));
  if (undoStack.length > 60) undoStack.shift();
}
function undoPlacement() {
  const prev = undoStack.pop();
  if (!prev || state.phase !== 'setup') return;
  prev.forEach((sq, i) => { state.tray[i].square = sq; });
  state.selectedTray = -1;
  refreshSetup();
}

/**
 * Place the selected piece on `square`. If another PLACED piece is there,
 * the two exchange: it takes the mover's old square (a swap), or returns to
 * the tray when the mover came from the tray. Click-moves of an already-
 * placed piece slide (animate); drag-drops land instantly.
 */
async function placeSelected(square, { animate = true } = {}) {
  const item = state.tray[state.selectedTray];
  if (!item || state.phase !== 'setup') return;
  const fromSquare = item.square;
  if (square === fromSquare) {
    state.selectedTray = -1;
    refreshSetup();
    return;
  }
  const target = state.tray.find((t) => t !== item && t.square === square) ?? null;
  // Validate against the board without the pieces that are moving.
  const occupied = occupiedExcept(item, ...(target ? [target] : []));
  const error = placementError(state.puzzle, square, item.type, occupied)
    ?? bishopShadeError(item.type, square, occupied);
  if (error) {
    setStatus(error, true);
    return;
  }
  if (target && fromSquare) {
    const swapError = placementError(state.puzzle, fromSquare, target.type, occupied)
      ?? bishopShadeError(target.type, fromSquare, occupied);
    if (swapError) {
      setStatus(`Can’t swap those pieces: ${swapError}`, true);
      return;
    }
  }
  pushUndo();
  if (target) target.square = fromSquare; // null → back to the tray
  item.square = square;
  state.selectedTray = -1;
  if (animate && fromSquare) {
    // Slide the click-move (and its swap partner) for visual continuity.
    const slides = [{ from: fromSquare, to: square }];
    if (target?.square === fromSquare) slides.push({ from: square, to: fromSquare });
    await board.animateMoves(slides, currentMap(), 140);
  }
  refreshSetup();
  if (!fromSquare) board.dropIn(square);
  if (allPlaced() && startPositionError(state.puzzle, placements())) {
    board.highlight(square, 'bad');
  }
}

/** Move a placed piece by drag (validated and swapped like a click-move). */
function movePlaced(fromSquare, toSquare, { animate = false } = {}) {
  if (state.phase !== 'setup' || fromSquare === toSquare) return;
  const idx = state.tray.findIndex((t) => t.square === fromSquare);
  if (idx < 0) return;
  state.selectedTray = idx;
  placeSelected(toSquare, { animate });
  if (state.tray[idx].square === fromSquare) {
    // The move was refused: drop the selection the drag implied, but leave
    // the refusal message on screen (nothing was rendered as selected).
    state.selectedTray = -1;
    refreshSetup();
    board.setPosition(currentMap()); // snap the dragged piece home
  }
}

/** Return a placed piece to the tray (drag it there or off the board). */
function returnToTray(fromSquare) {
  if (state.phase !== 'setup') return;
  const idx = state.tray.findIndex((t) => t.square === fromSquare);
  if (idx < 0) return;
  pushUndo();
  state.tray[idx].square = null;
  state.selectedTray = -1;
  refreshSetup();
}

// ---- Pointer-based dragging (one code path for mouse AND touch) ----
// HTML5 drag-and-drop never fires on touchscreens, so pieces use pointer
// events instead: a floating clone follows the pointer, the hovered square
// lights up, the source dims, and dropping resolves by position.
const drag = { payload: null, sourceEl: null, moved: false, clone: null, hoverSq: null };

function beginPieceDrag(e, payload, sourceEl) {
  if (state.phase !== 'setup' || !e.isPrimary || e.button > 0) return;
  drag.payload = payload;
  drag.sourceEl = sourceEl;
  drag.moved = false;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  document.body.classList.add('dragging'); // suppress text selection while dragging
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', cancelDrag);
}

function startDragVisuals(e) {
  const size = els.board.getBoundingClientRect().width / 8;
  const type = drag.payload.kind === 'tray'
    ? state.tray[drag.payload.index]?.type
    : state.tray.find((t) => t.square === drag.payload.from)?.type;
  const clone = document.createElement('div');
  clone.className = `drag-float ${pieceClass(state.puzzle.player, type)}`;
  clone.style.width = `${size}px`;
  clone.style.height = `${size}px`;
  document.body.appendChild(clone);
  drag.clone = clone;
  drag.sourceEl.classList.add('drag-source');
  positionDragClone(e);
}

function positionDragClone(e) {
  drag.clone.style.transform = `translate(${e.clientX - drag.clone.offsetWidth / 2}px, ${e.clientY - drag.clone.offsetHeight / 2}px)`;
}

function onDragMove(e) {
  if (!drag.payload) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
    drag.moved = true;
    startDragVisuals(e);
  }
  positionDragClone(e);
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const sq = under?.closest?.('.square')?.dataset.square ?? null;
  if (sq !== drag.hoverSq) {
    board.clearHighlights('drop-hover');
    if (sq) board.highlight(sq, 'drop-hover');
    drag.hoverSq = sq;
  }
  els.tray.classList.toggle('drop-hover',
    drag.payload.kind === 'board' && Boolean(under && els.tray.contains(under)));
}

function onDragEnd(e) {
  const { payload, moved } = drag;
  const wasDrag = payload && moved;
  if (wasDrag) {
    // Swallow the click the browser fires after pointerup so it doesn't
    // toggle a selection on whatever the piece was dropped on.
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 150);

    const under = document.elementFromPoint(e.clientX, e.clientY);
    const sq = under?.closest?.('.square')?.dataset.square ?? null;
    const overTray = Boolean(under && (els.tray.contains(under) || els.trayLabel.contains(under)));
    cleanupDrag();
    if (payload.kind === 'tray') {
      if (sq) {
        state.selectedTray = payload.index;
        placeSelected(sq, { animate: false });
      } else {
        refreshSetup(); // dropped nowhere: piece stays in the tray
      }
    } else if (sq) {
      movePlaced(payload.from, sq, { animate: false });
    } else if (overTray || !sq) {
      returnToTray(payload.from); // tray or off-board = unplace
    }
  } else {
    cleanupDrag(); // no movement: let the normal click do its thing
  }
}

function cancelDrag() {
  const hadVisuals = drag.moved;
  cleanupDrag();
  if (hadVisuals) refreshSetup();
}

function cleanupDrag() {
  document.body.classList.remove('dragging');
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', cancelDrag);
  drag.clone?.remove();
  drag.sourceEl?.classList.remove('drag-source');
  board.clearHighlights('drop-hover');
  els.tray.classList.remove('drop-hover');
  drag.payload = null;
  drag.sourceEl = null;
  drag.clone = null;
  drag.hoverSq = null;
  drag.moved = false;
}

els.board.addEventListener('pointerdown', (e) => {
  const pieceEl = e.target.closest?.('.piece.placed');
  const square = pieceEl?.closest('.square')?.dataset.square;
  if (pieceEl && square) beginPieceDrag(e, { kind: 'board', from: square }, pieceEl);
});
els.tray.addEventListener('pointerdown', (e) => {
  const div = e.target.closest?.('.tray-piece');
  if (div?.dataset.index != null) beginPieceDrag(e, { kind: 'tray', index: Number(div.dataset.index) }, div);
});

function resetPlacements() {
  state.runId++;
  killPlayoutEngine();
  state.phase = 'setup';
  if (state.tray.some((t) => t.square)) pushUndo();
  for (const item of state.tray) item.square = null;
  state.selectedTray = -1;
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
    // Live path: a fresh engine for this run plays both sides and fills
    // the buffer as fast as it can think. The WASM is cached after the
    // first spawn, and the reveal animation below hides the startup.
    killPlayoutEngine();
    const engine = new Engine('playout');
    playoutEngine = engine;
    await engine.init();
    await engine.newGame();
    if (runId !== state.runId) { engine.terminate(); return; }
    (async () => {
      try {
        while (!game.isGameOver()) {
          const side = game.turn();
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
    showMaterial(fenToMap(item.fen));
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
      showMaterial(fenToMap(shown ? shown.fen : fen));
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
      showMaterial(fenToMap(item.fen));
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
  killPlayoutEngine(); // run over — free the worker (and its hash) now
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
  els.banner.append(h2, p);

  els.stopBtn.classList.add('hidden');
  els.backBtn.classList.add('hidden');
  els.fwdBtn.classList.add('hidden');
  els.continueBtn.classList.add('hidden');
  els.retryBtn.classList.remove('hidden');
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
  if (game.isDrawByFiftyMoves()) {
    return 'Fifty consecutive moves passed without a capture or a pawn move — ' +
      'drawn by the fifty-move rule.';
  }
  return 'The game was drawn.';
}

function stopPlayout() {
  // Stop cancels the playout but KEEPS the placements, so the player can
  // nudge their construction instead of rebuilding it from scratch.
  killPlayoutEngine();
  state.runId++;
  backToSetup();
  setStatus('Playout stopped — adjust your pieces and play it out again.');
}

function backToSetup() {
  state.phase = 'setup';
  els.banner.classList.add('hidden');
  els.progress.classList.add('hidden');
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

function renderPuzzleOptions() {
  const current = els.puzzleSelect.value;
  els.puzzleSelect.innerHTML = '';
  activePuzzles().forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Puzzle ${i + 1}${played.has(p.id) ? '' : ' •'}`;
    els.puzzleSelect.appendChild(opt);
  });
  if (current !== '' && Number(current) < activePuzzles().length) els.puzzleSelect.value = current;
}

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
  if (state.pauseControls) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); state.pauseControls.back(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); state.pauseControls.fwd(); }
    return;
  }
  if (e.key === 'Escape') {
    if (drag.payload) { cancelDrag(); return; }
    if (state.phase === 'setup' && state.selectedTray >= 0) {
      state.selectedTray = -1;
      refreshSetup();
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && state.phase === 'setup') {
    e.preventDefault();
    undoPlacement();
  }
});
els.speedSlider.value = localStorage.getItem('chessauto-speed') || String(DEFAULT_ANIM_MS);
els.speedValue.textContent = `${els.speedSlider.value} ms`;
els.speedSlider.addEventListener('input', () => {
  els.speedValue.textContent = `${els.speedSlider.value} ms`;
  localStorage.setItem('chessauto-speed', els.speedSlider.value);
});

renderPuzzleOptions();
loadPuzzle(0);

// Booting the eval engine also warms the browser cache for the WASM, so
// per-run playout engines spawn fast afterwards.
evalEngine.init()
  .then(() => {
    state.enginesReady = true;
    if (state.phase === 'setup') refreshSetup();
  })
  .catch((err) => {
    console.error(err);
    setStatus('Failed to load the chess engines. Try reloading the page.', true);
  });
