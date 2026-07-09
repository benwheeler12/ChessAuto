// Puzzle definitions.
//
// Each puzzle is a "semicomplete" chess position: a legal position from which
// a few of the player's pieces have been removed. The player must place the
// missing pieces (listed in `place`) on empty squares so that the resulting
// position is winning for their color, then let the engines play it out.
//
//   fen    - the semicomplete position, with the player's side to move
//   player - which color the user is constructing a win for ('w' | 'b')
//   place  - piece types (lowercase) the player must put back on the board

export const PUZZLES = [
  {
    id: 'queens-entrance',
    name: "Queen's Entrance",
    description:
      'Your queen has gone missing and Black is up a rook. Put her somewhere ' +
      'that turns the tables.',
    fen: 'r5k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1',
    player: 'w',
    place: ['q'],
  },
  {
    id: 'heavy-support',
    name: 'Heavy Support',
    description:
      'Black has both rooks connected. Place your queen and rook to overpower them.',
    fen: '2r2rk1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1',
    player: 'w',
    place: ['q', 'r'],
  },
  {
    id: 'minor-details',
    name: 'Minor Details',
    description:
      'A rook, a bishop and a knight are waiting to come back. Coordinate all ' +
      'three against the black rook.',
    fen: '3r2k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1',
    player: 'w',
    place: ['r', 'b', 'n'],
  },
  {
    id: 'turning-tables',
    name: 'Turning Tables',
    description:
      'You are Black this time, staring down a white rook. Drop your queen on ' +
      'the right square and take over.',
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1',
    player: 'b',
    place: ['q'],
  },
  {
    id: 'silence-the-knight',
    name: 'Silence the Knight',
    description:
      'Black’s knight is hopping around your position. Your queen returns — ' +
      'make her placement count.',
    fen: '6k1/pp4pp/8/5n2/8/8/PP4PP/6K1 w - - 0 1',
    player: 'w',
    place: ['q'],
  },
  {
    id: 'crowded-house',
    name: 'Crowded House',
    description:
      'A real middlegame. Your queen and kingside rook were lifted off the ' +
      'board — find them squares that win the game.',
    fen: 'r1bq2k1/pppp1ppp/2n2n2/4p3/8/8/PPPP1PPP/RNB1KBN1 w - - 0 1',
    player: 'w',
    place: ['q', 'r'],
  },
  {
    id: 'fortress-builder',
    name: 'Fortress Builder',
    description:
      'Playing Black against a lone white queen. Place your queen and rook so ' +
      'the attack plays itself.',
    fen: '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 b - - 0 1',
    player: 'b',
    place: ['q', 'r'],
  },
  {
    id: 'grand-finale',
    name: 'Grand Finale',
    description:
      'Three pieces to place against a developed black army. Build the attack, ' +
      'then watch it land.',
    fen: 'r5k1/ppp2ppp/2n1bn2/8/8/8/PPP2PPP/2B1K1N1 w - - 0 1',
    player: 'w',
    place: ['q', 'r', 'b'],
  },
];
