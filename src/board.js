// Renders the chessboard and forwards user interaction (clicks and
// drag-and-drop from the piece tray) back to the app.
//
// Pieces are drawn with the cburnett SVG set (see src/assets/pieces/) via
// `pc-*` CSS classes shared with the tray.

const FILES = 'abcdefgh';

/** CSS class that paints a piece image, e.g. pieceClass('w', 'q') -> 'pc-wq'. */
export function pieceClass(color, type) {
  return `pc-${color}${type}`;
}

export class Board {
  /**
   * @param {HTMLElement} el
   * @param {{ onSquareClick?: (sq: string) => void,
   *           onDropPiece?: (trayIndex: number, sq: string) => void }} handlers
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
      cell.addEventListener('dragover', (e) => e.preventDefault());
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        const idx = e.dataTransfer.getData('text/tray-index');
        if (idx !== '' && cell.dataset.square) {
          this.handlers.onDropPiece?.(Number(idx), cell.dataset.square);
        }
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
   * Victory reveal on the placed piece: green flash, a scale pulse, and a
   * little confetti burst. Resolves when the show is over (~1s).
   */
  revealWin(square) {
    const cell = this.squares.get(square);
    if (!cell) return Promise.resolve();
    const anims = [];
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
    const boardRect = this.el.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const cx = rect.left - boardRect.left + rect.width / 2;
    const cy = rect.top - boardRect.top + rect.height / 2;
    const colors = ['#95bb4a', '#ffd24d', '#7fa650', '#ffffff'];
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
    return Promise.all(anims).then(() => cell.classList.remove('reveal-win'));
  }

  /**
   * Defeat reveal: the placed piece's square flashes red and the whole board
   * shakes its head. Resolves when the show is over (~0.9s).
   */
  revealLoss(square) {
    const cell = this.squares.get(square);
    if (!cell) return Promise.resolve();
    cell.classList.add('reveal-loss');
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
    return Promise.all([shake, hold]).then(() => cell.classList.remove('reveal-loss'));
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
