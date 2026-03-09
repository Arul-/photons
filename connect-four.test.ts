// Inlined helpers from connect-four.photon.ts (not exported from module)
type Cell = 0 | 1 | 2;
type Board = Cell[][];
const ROWS = 6;
const COLS = 7;

function createEmptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0) as Cell[]);
}

function renderBoard(board: Board): string {
  const symbols: Record<number, string> = { 0: '·', 1: '🔴', 2: '🟡' };
  const lines: string[] = [];
  lines.push('  1   2   3   4   5   6   7');
  for (let r = 0; r < ROWS; r++) {
    lines.push('| ' + board[r].map(c => symbols[c]).join(' | ') + ' |');
    if (r < ROWS - 1) lines.push('+---+---+---+---+---+---+---+');
  }
  lines.push('+---+---+---+---+---+---+---+');
  return lines.join('\n');
}

function checkWin(board: Board, piece: Cell): boolean {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      if (board[r][c] === piece && board[r][c + 1] === piece &&
          board[r][c + 2] === piece && board[r][c + 3] === piece) return true;
    }
  }
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c] === piece && board[r + 1][c] === piece &&
          board[r + 2][c] === piece && board[r + 3][c] === piece) return true;
    }
  }
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      if (board[r][c] === piece && board[r + 1][c + 1] === piece &&
          board[r + 2][c + 2] === piece && board[r + 3][c + 3] === piece) return true;
    }
  }
  for (let r = 3; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      if (board[r][c] === piece && board[r - 1][c + 1] === piece &&
          board[r - 2][c + 2] === piece && board[r - 3][c + 3] === piece) return true;
    }
  }
  return false;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

export async function testEmptyBoardRendering(photon: any) {
  const board = createEmptyBoard();
  const rendered = renderBoard(board);

  if (rendered.includes('⚫')) {
    throw new Error('Board uses ⚫ which is invisible on dark backgrounds — should use ·');
  }
  if (!rendered.includes('·')) {
    throw new Error('Empty board should contain · markers for empty cells');
  }
  if (!rendered.includes('1') || !rendered.includes('7')) {
    throw new Error('Board should show column numbers 1-7');
  }
  const cellRows = rendered.split('\n').filter(line => line.startsWith('|'));
  if (cellRows.length !== ROWS) {
    throw new Error(`Expected ${ROWS} cell rows, got ${cellRows.length}`);
  }
}

export async function testBoardWithPieces(photon: any) {
  const board = createEmptyBoard();
  board[5][3] = 1;
  board[4][3] = 2;
  const rendered = renderBoard(board);

  if (!rendered.includes('🔴')) {
    throw new Error('Player piece 🔴 not found in rendered board');
  }
  if (!rendered.includes('🟡')) {
    throw new Error('AI piece 🟡 not found in rendered board');
  }
}

export async function testNewGameReturnsValidBoard(photon: any) {
  const result = await photon.start({ difficulty: 'easy', playerName: 'TestPlayer' });

  if (!result.gameId) {
    throw new Error('start should return a gameId');
  }
  if (!result.board) {
    throw new Error('start should return a board string');
  }
  if (!result.board.includes('·')) {
    throw new Error('New game board should contain empty cell markers (·)');
  }
  if (result.board.includes('🔴') || result.board.includes('🟡')) {
    throw new Error('New game board should have no pieces placed');
  }
  if (result.difficulty !== 'easy') {
    throw new Error(`Expected difficulty easy, got ${result.difficulty}`);
  }

  // Cleanup
  const data = (photon as any).loadData();
  data.games = data.games.filter((g: any) => g.id !== result.gameId);
  await (photon as any).saveData(data);
}

export async function testDropPieceUpdatesBoard(photon: any) {
  const game = await photon.start({ difficulty: 'easy', playerName: 'TestPlayer' });
  const result = await photon.drop({ column: 4, gameId: game.gameId });

  if (!result.board.includes('🔴')) {
    throw new Error('Board should contain player piece after dropping');
  }
  if (result.yourMove !== 4) {
    throw new Error(`Expected yourMove=4, got ${result.yourMove}`);
  }
  if (result.status === 'Your turn' && !result.aiMove) {
    throw new Error('AI should have made a move');
  }
  if (result.aiMove && !result.board.includes('🟡')) {
    throw new Error('Board should contain AI piece after AI responds');
  }

  // Cleanup
  const data = (photon as any).loadData();
  data.games = data.games.filter((g: any) => g.id !== game.gameId);
  await (photon as any).saveData(data);
}

export async function testInvalidColumn(photon: any) {
  const game = await photon.start({ difficulty: 'easy', playerName: 'TestPlayer' });

  try {
    await photon.drop({ column: 0, gameId: game.gameId });
    const data = (photon as any).loadData();
    data.games = data.games.filter((g: any) => g.id !== game.gameId);
    await (photon as any).saveData(data);
    throw new Error('Should throw for column 0');
  } catch (e: any) {
    if (e.message === 'Should throw for column 0') throw e;
    if (!e.message.includes('Invalid column')) {
      const data = (photon as any).loadData();
      data.games = data.games.filter((g: any) => g.id !== game.gameId);
      await (photon as any).saveData(data);
      throw new Error(`Wrong error: ${e.message}`);
    }
  }

  try {
    await photon.drop({ column: 8, gameId: game.gameId });
    const data = (photon as any).loadData();
    data.games = data.games.filter((g: any) => g.id !== game.gameId);
    await (photon as any).saveData(data);
    throw new Error('Should throw for column 8');
  } catch (e: any) {
    if (e.message === 'Should throw for column 8') throw e;
    if (!e.message.includes('Invalid column')) {
      const data = (photon as any).loadData();
      data.games = data.games.filter((g: any) => g.id !== game.gameId);
      await (photon as any).saveData(data);
      throw new Error(`Wrong error for col 8: ${e.message}`);
    }
  }

  // Cleanup
  const data = (photon as any).loadData();
  data.games = data.games.filter((g: any) => g.id !== game.gameId);
  await (photon as any).saveData(data);
}

export async function testWinDetection(photon: any) {
  // Horizontal win
  const board = createEmptyBoard();
  board[5][0] = 1; board[5][1] = 1; board[5][2] = 1; board[5][3] = 1;
  if (!checkWin(board, 1)) {
    throw new Error('Failed to detect horizontal win');
  }

  // Vertical win
  const board2 = createEmptyBoard();
  board2[2][0] = 2; board2[3][0] = 2; board2[4][0] = 2; board2[5][0] = 2;
  if (!checkWin(board2, 2)) {
    throw new Error('Failed to detect vertical win');
  }

  // Diagonal win
  const board3 = createEmptyBoard();
  board3[5][0] = 1; board3[4][1] = 1; board3[3][2] = 1; board3[2][3] = 1;
  if (!checkWin(board3, 1)) {
    throw new Error('Failed to detect diagonal win');
  }

  // No win (only 3 in a row)
  const board4 = createEmptyBoard();
  board4[5][0] = 1; board4[5][1] = 1; board4[5][2] = 1;
  if (checkWin(board4, 1)) {
    throw new Error('False positive: detected win with only 3 in a row');
  }
}

export async function testStatsTracking(photon: any) {
  const stats = await photon.stats();

  if (typeof stats.wins !== 'number' || typeof stats.losses !== 'number' ||
      typeof stats.draws !== 'number' || typeof stats.gamesPlayed !== 'number') {
    throw new Error('Stats should have numeric wins, losses, draws, gamesPlayed');
  }
  if (!stats.winRate) {
    throw new Error('Stats should include winRate');
  }
  if (!stats.currentStreak || typeof stats.currentStreak.count !== 'number') {
    throw new Error('Stats should include currentStreak with count');
  }
}
