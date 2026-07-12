// Renders the chessboard and forwards square clicks back to the app
// (pointer-based piece dragging lives in main.js and reads data-square).
//
// Pieces are drawn with the cburnett SVG set (see src/assets/pieces/) via
// `pc-*` CSS classes shared with the tray.

const FILES = 'abcdefgh';

/** CSS class that paints a piece image, e.g. pieceClass('w', 'q') -> 'pc-wq'. */
export function pieceClass(color, type) {
  return `pc-${color}${type}`;
}

/**
 * Trace the boundary of a set of unit cells (Set of "col,row" strings) into
 * closed loops of [x, y] lattice points, clockwise in screen coordinates.
 * Exported for tests.
 */
export function traceOutlines(cells) {
  const has = (c, r) => cells.has(`${c},${r}`);
  const edges = new Map(); // "x,y" of edge start -> [{from, to, used}]
  const addEdge = (x1, y1, x2, y2) => {
    const key = `${x1},${y1}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push({ from: [x1, y1], to: [x2, y2], used: false });
  };
  for (const key of cells) {
    const [c, r] = key.split(',').map(Number);
    if (!has(c, r - 1)) addEdge(c, r, c + 1, r); // top, left → right
    if (!has(c + 1, r)) addEdge(c + 1, r, c + 1, r + 1); // right, down
    if (!has(c, r + 1)) addEdge(c + 1, r + 1, c, r + 1); // bottom, right → left
    if (!has(c - 1, r)) addEdge(c, r + 1, c, r); // left, up
  }

  const loops = [];
  for (const list of edges.values()) {
    for (const first of list) {
      if (first.used) continue;
      const points = [first.from];
      let edge = first;
      while (!edge.used) {
        edge.used = true;
        points.push(edge.to);
        const dir = [edge.to[0] - edge.from[0], edge.to[1] - edge.from[1]];
        const outs = (edges.get(`${edge.to[0]},${edge.to[1]}`) ?? []).filter((e) => !e.used);
        if (!outs.length) break;
        // At pinch points (two islands touching corners) prefer the sharpest
        // clockwise turn so each loop stays on its own island.
        outs.sort((a, b) => {
          const cross = (e) => dir[0] * (e.to[1] - e.from[1]) - dir[1] * (e.to[0] - e.from[0]);
          return cross(b) - cross(a);
        });
        edge = outs[0];
      }
      // Drop collinear midpoints and the duplicated closing point.
      const clean = [];
      for (let i = 0; i < points.length - 1; i++) {
        const prev = points[(i + points.length - 2) % (points.length - 1)];
        const next = points[i + 1];
        if ((prev[0] === points[i][0] && points[i][0] === next[0])
          || (prev[1] === points[i][1] && points[i][1] === next[1])) continue;
        clean.push(points[i]);
      }
      loops.push(clean);
    }
  }
  return loops;
}

export class Board {
  /**
   * @param {HTMLElement} el
   * @param {{ onSquareClick?: (sq: string) => void }} handlers
   */
  constructor(el, handlers = {}) {
    this.el = el;
    this.handlers = handlers;
    this.orientation = 'w';
    this.squares = new Map(); // square name -> element
    this.build();
  }

  build() {
    this.el.innerHTML = '';
    this.squares.clear();
    for (let i = 0; i < 64; i++) {
      const cell = document.createElement('div');
      cell.className = 'square';
      cell.addEventListener('click', () => {
        if (cell.dataset.square) this.handlers.onSquareClick?.(cell.dataset.square);
      });
      this.el.appendChild(cell);
    }
    this.assignSquares();
  }

  setOrientation(color) {
    if (this.orientation === color) return;
    this.orientation = color;
    this.assignSquares();
  }

  /**
   * Outline groups of squares on the board. Each island (an array of
   * squares, e.g. [['d3','d4','e3'], ['g6']]) gets one traced border that
   * hugs its exact shape. Replaces any previous zones.
   */
  showZones(islands) {
    this.clearZones();
    if (!islands?.length) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('zone-layer');
    for (const island of islands) {
      const cells = new Set(island.map((sq) => {
        const file = sq.charCodeAt(0) - 97;
        const rank = Number(sq[1]);
        return this.orientation === 'w'
          ? `${file},${8 - rank}`
          : `${7 - file},${rank - 1}`;
      }));
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('zone');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', traceOutlines(cells)
        .map((loop) => `M ${loop.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`)
        .join(' '));
      svg.appendChild(path);
    }
    this.el.appendChild(svg);
    this.zoneEl = svg;
  }

  clearZones() {
    this.zoneEl?.remove();
    this.zoneEl = null;
  }

  /**
   * Quick expanding ring on a square when a capture lands there.
   * kind: 'good' (green, our side captured) | 'bad' (red, we got captured).
   */
  captureFlash(square, kind) {
    const cell = this.squares.get(square);
    if (!cell) return;
    const burst = document.createElement('div');
    burst.className = `capture-burst ${kind}`;
    cell.appendChild(burst);
    burst.addEventListener('animationend', () => burst.remove(), { once: true });
  }

  assignSquares() {
    this.squares.clear();
    const cells = this.el.children;
    for (let i = 0; i < 64; i++) {
      const row = Math.floor(i / 8);
      const col = i % 8;
      const file = this.orientation === 'w' ? col : 7 - col;
      const rank = this.orientation === 'w' ? 8 - row : row + 1;
      const name = FILES[file] + rank;
      const cell = cells[i];
      cell.dataset.square = name;
      cell.classList.toggle('light', (file + rank) % 2 === 1);
      cell.classList.toggle('dark', (file + rank) % 2 === 0);
      // Coordinate labels along the left and bottom edges.
      cell.dataset.rankLabel = col === 0 ? String(rank) : '';
      cell.dataset.fileLabel = row === 7 ? FILES[file] : '';
      this.squares.set(name, cell);
    }
  }

  /** @param {Record<string, {type: string, color: string, placed?: boolean}>} position */
  setPosition(position) {
    // Any redraw invalidates in-flight move animations: bump the epoch so a
    // finishing animation doesn't overwrite this position, and clear its
    // floating pieces (fixes Stop mid-slide leaving the game position up).
    this.epoch = (this.epoch ?? 0) + 1;
    for (const float of this.el.querySelectorAll('.piece.floating')) float.remove();
    for (const [name, cell] of this.squares) {
      const piece = position[name];
      let span = cell.querySelector('.piece');
      if (!piece) {
        span?.remove();
        continue;
      }
      if (!span) {
        span = document.createElement('span');
        cell.appendChild(span);
      }
      span.className = `piece ${pieceClass(piece.color, piece.type)}${piece.placed ? ' placed' : ''}`;
    }
  }

  /**
   * Slide pieces from their squares to their destinations, then apply the
   * final position. `moves` may hold several movements (castling moves two
   * pieces at once); captured pieces stay visible until the slide completes.
   *
   * Uses the Web Animations API rather than CSS transitions: transitions can
   * skip their starting frame at very short durations (pieces appear to
   * teleport below ~100ms), while element.animate() is frame-accurate.
   * @param {{from: string, to: string}[]} moves
   * @param {Record<string, {type: string, color: string}>} newPosition
   */
  animateMoves(moves, newPosition, duration = 50) {
    const boardRect = this.el.getBoundingClientRect();
    const animations = [];
    const floats = [];
    for (const { from, to } of moves) {
      const fromCell = this.squares.get(from);
      const toCell = this.squares.get(to);
      const pieceEl = fromCell?.querySelector('.piece');
      if (!pieceEl || !toCell) continue;
      const f = fromCell.getBoundingClientRect();
      const t = toCell.getBoundingClientRect();
      const float = pieceEl.cloneNode(true);
      float.classList.add('floating');
      float.style.width = `${f.width}px`;
      float.style.height = `${f.height}px`;
      const start = `translate(${f.left - boardRect.left}px, ${f.top - boardRect.top}px)`;
      const end = `translate(${t.left - boardRect.left}px, ${t.top - boardRect.top}px)`;
      float.style.transform = start;
      pieceEl.remove();
      this.el.appendChild(float);
      floats.push(float);
      animations.push(
        float.animate(
          [{ transform: start }, { transform: end }],
          { duration, easing: 'ease-out', fill: 'forwards' },
        ).finished.catch(() => {}),
      );
    }
    if (!floats.length) {
      this.setPosition(newPosition);
      return Promise.resolve();
    }
    const epoch = this.epoch ?? 0;
    return Promise.all(animations).then(() => {
      if ((this.epoch ?? 0) !== epoch) {
        // The board was redrawn while we were sliding (e.g. Stop reset it) —
        // don't stomp the new position.
        for (const float of floats) float.remove();
        return;
      }
      this.setPosition(newPosition);
      for (const float of floats) float.remove();
    });
  }

  /**
   * Victory reveal on the placed piece(s): green flash, a scale pulse, and a
   * little confetti burst per square. Resolves when the show is over (~1s).
   */
  revealWin(squares) {
    const cells = [].concat(squares).map((sq) => this.squares.get(sq)).filter(Boolean);
    if (!cells.length) return Promise.resolve();
    const anims = [];
    const boardRect = this.el.getBoundingClientRect();
    const colors = ['#95bb4a', '#ffd24d', '#7fa650', '#ffffff'];
    for (const cell of cells) {
      cell.classList.add('reveal-win');
      const piece = cell.querySelector('.piece');
      if (piece) {
        anims.push(piece.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(1.3)', offset: 0.3 },
            { transform: 'scale(1)' },
          ],
          { duration: 650, easing: 'ease-out' },
        ).finished.catch(() => {}));
      }
      const rect = cell.getBoundingClientRect();
      const cx = rect.left - boardRect.left + rect.width / 2;
      const cy = rect.top - boardRect.top + rect.height / 2;
      for (let i = 0; i < 18; i++) {
        const bit = document.createElement('div');
        bit.className = 'confetti';
        bit.style.background = colors[i % colors.length];
        bit.style.left = `${cx}px`;
        bit.style.top = `${cy}px`;
        this.el.appendChild(bit);
        const angle = (i / 18) * Math.PI * 2 + Math.random() * 0.5;
        const dist = 34 + Math.random() * 55;
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist - 30; // launch upward-ish, then fall
        anims.push(bit.animate(
          [
            { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 1 },
            { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 55}px)) rotate(${200 + Math.random() * 340}deg)`, opacity: 0 },
          ],
          { duration: 800 + Math.random() * 250, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)' },
        ).finished.catch(() => {}).then(() => bit.remove()));
      }
    }
    return Promise.all(anims).then(() => {
      for (const cell of cells) cell.classList.remove('reveal-win');
    });
  }

  /**
   * Defeat reveal: the placed piece squares flash red and the whole board
   * shakes its head once. Resolves when the show is over (~0.9s).
   */
  revealLoss(squares) {
    const cells = [].concat(squares).map((sq) => this.squares.get(sq)).filter(Boolean);
    if (!cells.length) return Promise.resolve();
    for (const cell of cells) cell.classList.add('reveal-loss');
    const shake = this.el.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-10px)' },
        { transform: 'translateX(9px)' },
        { transform: 'translateX(-7px)' },
        { transform: 'translateX(5px)' },
        { transform: 'translateX(-3px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 500, easing: 'ease-out' },
    ).finished.catch(() => {});
    const hold = new Promise((resolve) => setTimeout(resolve, 900));
    return Promise.all([shake, hold]).then(() => {
      for (const cell of cells) cell.classList.remove('reveal-loss');
    });
  }

  /** Play a quick drop-in animation on the piece at `square` (used when placing). */
  dropIn(square) {
    const piece = this.squares.get(square)?.querySelector('.piece');
    if (!piece) return;
    piece.classList.add('drop-in');
    piece.addEventListener('animationend', () => piece.classList.remove('drop-in'), { once: true });
  }

  setPlacing(placing) {
    this.el.classList.toggle('placing', placing);
  }

  clearHighlights(...classes) {
    for (const cell of this.squares.values()) cell.classList.remove(...classes);
  }

  highlight(square, cls) {
    this.squares.get(square)?.classList.add(cls);
  }
}
