// Renders the chessboard and forwards user interaction (clicks and
// drag-and-drop from the piece tray) back to the app.

const FILES = 'abcdefgh';
export const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

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
        span.className = 'piece';
        cell.appendChild(span);
      }
      span.textContent = GLYPHS[piece.type];
      span.classList.toggle('w', piece.color === 'w');
      span.classList.toggle('b', piece.color === 'b');
      span.classList.toggle('placed', Boolean(piece.placed));
    }
  }

  clearHighlights(...classes) {
    for (const cell of this.squares.values()) cell.classList.remove(...classes);
  }

  highlight(square, cls) {
    this.squares.get(square)?.classList.add(cls);
  }
}
