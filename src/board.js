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
    return Promise.all(animations).then(() => {
      this.setPosition(newPosition);
      for (const float of floats) float.remove();
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
