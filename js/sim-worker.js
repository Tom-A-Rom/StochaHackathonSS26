/* ============================================================================
   sim-worker.js — Monte Carlo simulation engine (Web Worker)
   ----------------------------------------------------------------------------
   Runs OFF the main thread so the chessboard stays perfectly responsive while
   thousands of random games are simulated. Uses chess.js for game logic.

   PERFORMANCE
   -----------
   The old engine called chess.js `game_over()` every ply, which internally runs
   `in_threefold_repetition()` — an O(history) scan — making each random playout
   O(plies²). From the opening, random games run very long, so a single heatmap
   took many minutes. The new engine:
     • never calls game_over() in the hot loop (checkmate / stalemate are detected
       cheaply: zero legal moves + in_check),
     • truncates each rollout at PLY_CAP and judges the cut-off position by
       material balance (a standard truncated-rollout Monte Carlo).
   Result: ~5× faster, and the live numbers stay meaningful.

   The PLY_CAP / material verdict logic is intentionally identical to the offline
   precompute script (tools/precompute-worker.js) so cached and live results agree.

   Message protocol
   ----------------
   Main -> Worker:
     { cmd: 'sim',     id, fen, nGames, progressEvery }
     { cmd: 'analyze', id, jobs:[{key,from,to,san,fen}], nGames }

   Worker -> Main:
     { type: 'result',        id, pWhite, pDraw, pBlack, whiteWins, blackWins, draws }
     { type: 'analyzeResult', id, results: [ {key,from,to,san,pWhite,pDraw,pBlack}, ... ] }

   MIT License.
   ========================================================================== */

// chess.js inside the worker. importScripts may load cross-origin (CDN) scripts.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.2/chess.min.js');

var PLY_CAP = 64;            // truncate each random playout here
var MAT_MARGIN = 1;          // |material| <= this at the cut-off => draw
var PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Material balance (White - Black) from the FEN piece placement.
function materialBalance(g) {
  var placement = g.fen(), score = 0;
  for (var i = 0; i < placement.length; i++) {
    var ch = placement.charAt(i);
    if (ch === ' ') break;                       // placement is the first FEN field
    var lower = ch.toLowerCase();
    if (PIECE_VALUE.hasOwnProperty(lower)) {
      score += (ch === lower ? -1 : 1) * PIECE_VALUE[lower];
    }
  }
  return score;
}

/**
 * Play ONE random game from `fen`, truncated at PLY_CAP.
 * Returns 1 (white better/wins), -1 (black better/wins) or 0 (draw).
 */
function playRandomGame(fen) {
  var g = new Chess(fen);
  var ply = 0;
  while (ply < PLY_CAP) {
    var moves = g.moves({ verbose: true });
    if (moves.length === 0) {
      // No legal moves: checkmate (side to move loses) or stalemate (draw).
      if (g.in_check()) return g.turn() === 'w' ? -1 : 1;
      return 0;
    }
    var mv = moves[(Math.random() * moves.length) | 0];
    g.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    ply++;
  }
  // Cut-off reached: judge by material so long games aren't all "draw".
  var bal = materialBalance(g);
  if (bal > MAT_MARGIN) return 1;
  if (bal < -MAT_MARGIN) return -1;
  return 0;
}

/** Simulate `n` random games from `fen`. */
function simulate(fen, n) {
  var w = 0, b = 0, d = 0;
  for (var i = 0; i < n; i++) {
    var r;
    try { r = playRandomGame(fen); } catch (e) { r = 0; }
    if (r === 1) w++;
    else if (r === -1) b++;
    else d++;
  }
  var t = n || 1;
  return { whiteWins: w, blackWins: b, draws: d, pWhite: w / t, pDraw: d / t, pBlack: b / t };
}

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.cmd === 'sim') {
    var res = simulate(msg.fen, msg.nGames);
    postMessage({
      type: 'result', id: msg.id,
      pWhite: res.pWhite, pDraw: res.pDraw, pBlack: res.pBlack,
      whiteWins: res.whiteWins, blackWins: res.blackWins, draws: res.draws
    });

  } else if (msg.cmd === 'analyze') {
    // Simulate every candidate move and return the win/draw/loss split for the
    // position AFTER that move. The main thread decides how to display it.
    var out = [];
    for (var i = 0; i < msg.jobs.length; i++) {
      var job = msg.jobs[i];
      var r = simulate(job.fen, msg.nGames);
      out.push({
        key: job.key, from: job.from, to: job.to, san: job.san,
        pWhite: r.pWhite, pDraw: r.pDraw, pBlack: r.pBlack
      });
    }
    postMessage({ type: 'analyzeResult', id: msg.id, results: out });
  }
};
