/** Hand-authored v3 boards for independent TypeScript tests (not Dart exports). */

export function pieceJson(
  shape = 'circle',
  direction = 'right',
): Record<string, string> {
  return { shape, direction };
}

export function offerPiece(
  shape = 'circle',
  direction = 'right',
): Record<string, string> {
  return { kind: 'piece', shape, direction };
}

export function v3Playable(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 2,
    moveLimit: 5,
    blocked: [],
    cells: [
      [null, null],
      [null, null],
    ],
    offers: [
      offerPiece(),
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'left'),
    ],
    futurePieces: [
      { shape: 'circle', direction: 'up' },
      { shape: 'diamond', direction: 'left' },
    ],
    turnsUsed: 0,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
  };
}

export function v3LastFuture(): Record<string, unknown> {
  const json = v3Playable();
  json.futurePieces = [{ shape: 'circle', direction: 'up' }];
  return json;
}

export function v3EmptyStreamPlayable(): Record<string, unknown> {
  const json = v3Playable();
  json.futurePieces = [];
  return json;
}

export function v3OneSpentPlayable(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 2,
    moveLimit: 5,
    blocked: [],
    cells: [
      [null, null],
      [null, null],
    ],
    offers: [
      { kind: 'spent' },
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'left'),
    ],
    futurePieces: [],
    turnsUsed: 1,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
  };
}

export function v3BoardFullEnded(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 1,
    moveLimit: 5,
    blocked: [],
    cells: [[pieceJson()]],
    offers: [
      { kind: 'spent' },
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'left'),
    ],
    futurePieces: [],
    turnsUsed: 1,
    score: 0,
    status: 'ended',
    terminalReason: 'no_legal_moves',
  };
}

export function v3MoveLimitReached(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 2,
    moveLimit: 1,
    blocked: [],
    cells: [
      [null, null],
      [null, null],
    ],
    offers: [
      offerPiece(),
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'left'),
    ],
    futurePieces: [],
    turnsUsed: 1,
    score: 0,
    status: 'ended',
    terminalReason: 'move_limit_reached',
  };
}

export function v3AlmostFull(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 1,
    moveLimit: 5,
    blocked: [],
    cells: [[null]],
    offers: [
      offerPiece(),
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'left'),
    ],
    futurePieces: [],
    turnsUsed: 0,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
  };
}

export function v3LastMovePlayable(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 2,
    moveLimit: 1,
    blocked: [],
    cells: [
      [null, null],
      [null, null],
    ],
    offers: [
      offerPiece(),
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'left'),
    ],
    futurePieces: [],
    turnsUsed: 0,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
  };
}

/** Hand-checkable: place circle-left at [0,2] → landing [0,2], clear 3 → score 300. */
export function v3MatchReady(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 3,
    moveLimit: 5,
    blocked: [],
    cells: [
      [
        { shape: 'circle', direction: 'up' },
        { shape: 'circle', direction: 'up' },
        null,
      ],
      [null, null, null],
      [null, null, null],
    ],
    offers: [
      offerPiece('circle', 'left'),
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'up'),
    ],
    futurePieces: [{ shape: 'diamond', direction: 'right' }],
    turnsUsed: 0,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
  };
}

export function v3CascadeReopen(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 3,
    moveLimit: 5,
    blocked: [],
    cells: [
      [
        { shape: 'circle', direction: 'up' },
        { shape: 'circle', direction: 'up' },
        null,
      ],
      [
        { shape: 'diamond', direction: 'down' },
        { shape: 'triangle', direction: 'left' },
        { shape: 'diamond', direction: 'up' },
      ],
      [
        { shape: 'triangle', direction: 'right' },
        { shape: 'diamond', direction: 'left' },
        { shape: 'triangle', direction: 'down' },
      ],
    ],
    offers: [
      offerPiece('circle', 'left'),
      offerPiece('diamond', 'down'),
      offerPiece('triangle', 'up'),
    ],
    futurePieces: [{ shape: 'diamond', direction: 'right' }],
    turnsUsed: 0,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
  };
}

export function v3AllSpentEmptyBoard(): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: 2,
    moveLimit: 5,
    blocked: [],
    cells: [
      [null, null],
      [null, null],
    ],
    offers: [{ kind: 'spent' }, { kind: 'spent' }, { kind: 'spent' }],
    futurePieces: [],
    turnsUsed: 2,
    score: 0,
    status: 'ended',
    terminalReason: 'no_legal_moves',
  };
}
