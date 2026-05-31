/* ============================================================================
   sim-worker.js — Monte Carlo simulation engine (Web Worker)
   ----------------------------------------------------------------------------
   Runs OFF the main thread so the chessboard stays perfectly responsive while
   thousands of random games are simulated. Uses chess.js for game logic.

   Message protocol
   ----------------
   Main -> Worker:
     { cmd: 'sim',     id, fen, nGames, progressEvery }
     { cmd: 'analyze', id, jobs:[{key,from,to,san,fen}], nGames }

   Worker -> Main:
     { type: 'progress',        id, done, total }
     { type: 'result',          id, pWhite, pDraw, pBlack, whiteWins, blackWins, draws }
     { type: 'analyzeProgress', id, index, total, san }
     { type: 'analyzeResult',   id, results: [ {key,from,to,san,pWhite,pDraw,pBlack}, ... ] }

   MIT License.
   ========================================================================== */

// chess.js inside the worker. importScripts may load cross-origin (CDN) scripts.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.2/chess.min.js');

var RANDOM_PLY_CAP = 300; // safety cap so random playouts always terminate

/**
 * Play ONE fully random game from `fen` to termination.
 * Returns 1 (white wins), -1 (black wins) or 0 (draw / cap reached).
 */
function playRandomGame(fen) {
  var g = new Chess(fen);
  var ply = 0;
  while (!g.game_over() && ply < RANDOM_PLY_CAP) {
    var moves = g.moves();
    if (moves.length === 0) break;
    g.move(moves[(Math.random() * moves.length) | 0]);
    ply++;
  }
  if (g.in_checkmate()) {
    // The side to move is checkmated -> the OTHER side won.
    return g.turn() === 'w' ? -1 : 1;
  }
  return 0;
}

/**
 * Simulate `n` random games from `fen`.
 * If `id`/`progressEvery` are given, posts periodic progress messages.
 */
function simulate(fen, n, id, progressEvery) {
  var w = 0, b = 0, d = 0;
  for (var i = 0; i < n; i++) {
    var r;
    try { r = playRandomGame(fen); } catch (e) { r = 0; }
    if (r === 1) w++;
    else if (r === -1) b++;
    else d++;

    if (progressEvery && id != null && (i % progressEvery === 0)) {
      postMessage({ type: 'progress', id: id, done: i, total: n });
    }
  }
  return {
    whiteWins: w, blackWins: b, draws: d,
    pWhite: w / n, pDraw: d / n, pBlack: b / n
  };
}

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.cmd === 'sim') {
    var res = simulate(msg.fen, msg.nGames, msg.id, msg.progressEvery);
    postMessage({
      type: 'result', id: msg.id,
      pWhite: res.pWhite, pDraw: res.pDraw, pBlack: res.pBlack,
      whiteWins: res.whiteWins, blackWins: res.blackWins, draws: res.draws
    });

  } else if (msg.cmd === 'analyze') {
    // Simulate every candidate move and return the full win/draw/loss split for
    // the position AFTER that move. The main thread decides how to display it.
    var out = [];
    for (var i = 0; i < msg.jobs.length; i++) {
      var job = msg.jobs[i];
      postMessage({
        type: 'analyzeProgress', id: msg.id,
        index: i, total: msg.jobs.length, san: job.san
      });
      var r = simulate(job.fen, msg.nGames, null, 0);
      out.push({
        key: job.key, from: job.from, to: job.to, san: job.san,
        pWhite: r.pWhite, pDraw: r.pDraw, pBlack: r.pBlack
      });
    }
    postMessage({ type: 'analyzeResult', id: msg.id, results: out });
  }
};
