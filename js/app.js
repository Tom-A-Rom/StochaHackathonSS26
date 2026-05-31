/* ============================================================================
   app.js — UI, game modes (bot/human), parallel Monte Carlo, heatmap, tree
   ----------------------------------------------------------------------------
   Simulation runs across a POOL of Web Workers (one per core, capped) so it is
   fast and never blocks the board.

   MIT License.
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     SECTION: CONFIG & STATE
     ====================================================================== */
  var SIM_GAMES     = 800;  // Monte Carlo games for the top-right probability
  var HEATMAP_GAMES = 120;  // games per candidate move for the heatmap
  var CRACK_RATE    = 1e9;  // assumed brute-force guesses / second
  var BOT_DEPTH     = 2;    // minimax search depth
  var BOT_DELAY_MS  = 350;  // pause before a bot move (so you can watch)
  var PIECE_VALUE   = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  var POOL_SIZE     = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4)));

  var MODE = 'hvb';          // 'hvh' | 'hvb' (human=White) | 'bvb'

  var game, board, treeView;
  var gen = 0;               // generation token; bumped whenever the position changes
  var fullHeatmap = false;   // "Gesamte Heatmap" toggle

  var heatmapList = [];      // [ {from,to,san,pWhite,pDraw,pBlack,pSide} ] for current pos
  var heatmapByFrom = {};
  var heatmapReady = false;

  var probHistory = [];          // probHistory[k] = White win% of position after k plies
  var candidateSnapshots = [];   // candidateSnapshots[k] = [{san,pSide}] for position k

  function isHuman(color) {
    if (MODE === 'hvh') return true;
    if (MODE === 'bvb') return false;
    return color === 'w'; // hvb: human plays White
  }

  /* ======================================================================
     SECTION: WORKER POOL (parallel Monte Carlo)
     ====================================================================== */
 var pool = [];
var msgId = 0;
var waiting = {}; // id -> { resolve, reject }

function buildPool() {
  teardownPool();  // sicherheitshalber vorher alles killen
  for (var i = 0; i < POOL_SIZE; i++) {
    var w = new Worker('js/sim-worker.js');
    w.onmessage = onPoolMessage;
    w.onerror = function (err) { showError('Worker: ' + (err.message || 'siehe Konsole')); };
    pool.push(w);
  }
}
function teardownPool() {
  // alle offenen Promises mit einem Abbruch-Fehler beenden
  Object.keys(waiting).forEach(function (id) {
    waiting[id].reject(new Error('Cancelled'));
  });
  waiting = {};
  pool.forEach(function (w) { w.terminate(); });
  pool = [];
}
function onPoolMessage(e) {
  var m = e.data, slot = waiting[m.id];
  if (!slot) return;
  if (m.type === 'result') { delete waiting[m.id]; slot.resolve(m); }
  else if (m.type === 'analyzeResult') { delete waiting[m.id]; slot.resolve(m.results); }
}
function post(worker, msg) {
  return new Promise(function (resolve, reject) {
    var id = ++msgId;
    msg.id = id;
    waiting[id] = { resolve: resolve, reject: reject };
    worker.postMessage(msg);
  });
}

// cancelAllWork – jetzt radikal
function cancelAllWork() {
  gen++;
  teardownPool();
  buildPool();
}

  // Split nGames across the whole pool and aggregate.
  function parallelSim(fen, nGames) {
    var k = pool.length, base = Math.floor(nGames / k), rem = nGames % k, proms = [];
    for (var i = 0; i < k; i++) {
      var n = base + (i < rem ? 1 : 0);
      if (n > 0) proms.push(post(pool[i], { cmd: 'sim', fen: fen, nGames: n, progressEvery: 0 }));
    }
    return Promise.all(proms).then(function (rs) {
      var w = 0, b = 0, d = 0;
      rs.forEach(function (r) { w += r.whiteWins; b += r.blackWins; d += r.draws; });
      var t = w + b + d || 1;
      return { whiteWins: w, blackWins: b, draws: d, pWhite: w / t, pDraw: d / t, pBlack: b / t, total: t };
    });
  }

  // Distribute candidate-move jobs across the pool.
  function parallelAnalyze(jobs, gamesPerJob) {
    var k = pool.length, buckets = [], i;
    for (i = 0; i < k; i++) buckets.push([]);
    for (i = 0; i < jobs.length; i++) buckets[i % k].push(jobs[i]);
    var proms = buckets.map(function (b, idx) {
      return b.length ? post(pool[idx], { cmd: 'analyze', jobs: b, nGames: gamesPerJob })
                      : Promise.resolve([]);
    });
    return Promise.all(proms).then(function (rs) {
      return Array.prototype.concat.apply([], rs);
    });
  }

  // Soft-cancel in-flight work: bump the generation so any results that come
  // back are ignored by their gen guards. The (small, fast) stale jobs simply
  // drain in the background — far cheaper than tearing down 8 workers each move.
  function cancelAllWork() { gen++; }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ======================================================================
     SECTION: DOM HELPERS
     ====================================================================== */
  var $ = {};
  function cacheDom() {
    ['progress','status-msg','prob-text','seg-white','seg-draw','seg-black',
     'explain','legend','turn-pill','board-hint','heatmap-state',
     'btn-heatmap','btn-reset','btn-tree-reset','mode-select','tree-canvas',
     'game-pgn','game-fen','game-prob','game-entropy','game-hash','game-crack','crack-note']
      .forEach(function (id) { $[id] = document.getElementById(id); });
  }

  function updateProbabilityUI(pWhite, pDraw, pBlack) {
    var w = pWhite * 100, d = pDraw * 100, b = pBlack * 100;
    $['seg-white'].style.width = w.toFixed(2) + '%';
    $['seg-draw'].style.width  = d.toFixed(2) + '%';
    $['seg-black'].style.width = b.toFixed(2) + '%';
    $['seg-white'].textContent = w >= 12 ? w.toFixed(0) + '%' : '';
    $['seg-draw'].textContent  = d >= 12 ? d.toFixed(0) + '%' : '';
    $['seg-black'].textContent = b >= 12 ? b.toFixed(0) + '%' : '';
    $['prob-text'].innerHTML =
      '<span class="pw">White wins: ' + w.toFixed(1) + '%</span> | ' +
      '<span class="pd">Draw: ' + d.toFixed(1) + '%</span> | ' +
      '<span class="pb">Black wins: ' + b.toFixed(1) + '%</span>';
  }

  function setProgress(t) { $['progress'].textContent = t; }
  function setExplain(html) { $['explain'].innerHTML = html; }
  function setHeatmapState(t) { $['heatmap-state'].textContent = t; }
  function setStatus(t, cls) {
    $['status-msg'].textContent = t || '';
    $['status-msg'].className = 'status-msg' + (cls ? ' ' + cls : '');
  }
  function showError(err) {
    console.error(err);
    setStatus('Fehler: ' + (err && err.message ? err.message : err), 'err');
  }
  function updateTurnPill() {
    var p = $['turn-pill'];
    if (game.game_over()) { p.textContent = 'Spiel beendet'; p.className = 'turn-pill'; return; }
    var who = isHuman(game.turn()) ? 'Mensch' : 'Bot';
    if (game.turn() === 'w') { p.textContent = 'Weiß am Zug · ' + who; p.className = 'turn-pill white'; }
    else { p.textContent = 'Schwarz am Zug · ' + who; p.className = 'turn-pill black'; }
  }

  /* ======================================================================
     SECTION: BOT (minimax depth 2, material only)
     ====================================================================== */
  // Material balance from the FEN piece placement (uppercase = White).
  // We parse the FEN instead of g.board(), which isn't exposed in this build.
  function evaluateMaterial(g) {
    var placement = g.fen().split(' ')[0], score = 0;
    for (var i = 0; i < placement.length; i++) {
      var ch = placement.charAt(i), lower = ch.toLowerCase();
      if (PIECE_VALUE.hasOwnProperty(lower)) {
        score += (ch === lower ? -1 : 1) * PIECE_VALUE[lower];
      }
    }
    return score;
  }
  function minimax(g, depth, maximizing) {
    if (depth === 0 || g.game_over()) {
      if (g.in_checkmate()) return g.turn() === 'w' ? -1000 : 1000;
      return evaluateMaterial(g);
    }
    var moves = g.moves(), i, best;
    if (maximizing) {
      best = -Infinity;
      for (i = 0; i < moves.length; i++) { g.move(moves[i]); best = Math.max(best, minimax(g, depth - 1, false)); g.undo(); }
    } else {
      best = Infinity;
      for (i = 0; i < moves.length; i++) { g.move(moves[i]); best = Math.min(best, minimax(g, depth - 1, true)); g.undo(); }
    }
    return best;
  }
  function chooseBotMove() {
    var moves = game.moves({ verbose: true });
    if (!moves.length) return null;
    var whiteToMove = game.turn() === 'w';
    var bestScore = whiteToMove ? -Infinity : Infinity, bestMoves = [];
    for (var i = 0; i < moves.length; i++) {
      game.move(moves[i]);
      var score = minimax(game, BOT_DEPTH - 1, !whiteToMove);
      game.undo();
      var better = whiteToMove ? (score > bestScore) : (score < bestScore);
      if (better) { bestScore = score; bestMoves = [moves[i]]; }
      else if (score === bestScore) bestMoves.push(moves[i]);
    }
    return bestMoves[(Math.random() * bestMoves.length) | 0];
  }

  /* ======================================================================
     SECTION: GAME-OVER
     ====================================================================== */
  function handleGameOver() {
    if (!game.game_over()) return false;
    if (game.in_checkmate()) {
      if (game.turn() === 'w') { updateProbabilityUI(0, 0, 1); setStatus('Checkmate! Black wins.', 'lose'); }
      else { updateProbabilityUI(1, 0, 0); setStatus('Checkmate! White wins.', 'win'); }
    } else if (game.in_stalemate()) { updateProbabilityUI(0, 1, 0); setStatus('Stalemate — draw.', 'draw'); }
    else if (game.insufficient_material()) { updateProbabilityUI(0, 1, 0); setStatus('Draw — insufficient material.', 'draw'); }
    else if (game.in_threefold_repetition()) { updateProbabilityUI(0, 1, 0); setStatus('Draw — threefold repetition.', 'draw'); }
    else { updateProbabilityUI(0, 1, 0); setStatus('Draw (50-move rule).', 'draw'); }
    setProgress('Spiel beendet.');
    setHeatmapState('—');
    updateTurnPill();
    return true;
  }

  /* ======================================================================
     SECTION: HEATMAP OVERLAY
     ====================================================================== */
  function probToColor(p) { return 'hsl(' + (p * 120).toFixed(0) + ', 70%, 50%)'; }

  function clearOverlay() {
    document.getElementById('analysis-overlay').innerHTML = '';
    $['legend'].classList.remove('show');
  }
  function placeCircle(square, prob) {
  var sqEl = document.getElementById(square);
  if (!sqEl) return;
  var bRect = document.getElementById('board').getBoundingClientRect();
  var sqRect = sqEl.getBoundingClientRect();
  var size = Math.min(sqRect.width, sqRect.height) * 0.6;
  var c = document.createElement('div');
  c.className = 'mc-circle';
  c.style.width = size + 'px'; c.style.height = size + 'px';
  c.style.left = ((sqRect.left - bRect.left) + (sqRect.width - size) / 2) + 'px';
  c.style.top  = ((sqRect.top - bRect.top) + (sqRect.height - size) / 2) + 'px';
  c.style.background = probToColor(prob);
  c.textContent = (prob * 100).toFixed(0);
  document.getElementById('analysis-overlay').appendChild(c);
}
  function showPickupHeatmap(fromSquare) {
  clearOverlay();
  if (!heatmapReady) return;   // ← neu: nichts zeigen, wenn Heatmap noch nicht bereit
  var entries = heatmapByFrom[fromSquare];
  if (!entries || !entries.length) return;
  $['legend'].classList.add('show');
  entries.forEach(function (e) { placeCircle(e.to, e.pSide); });
}
  function showFullHeatmap() {
    clearOverlay();
    if (!heatmapList.length) return;
    $['legend'].classList.add('show');
    var best = {};
    heatmapList.forEach(function (e) { if (best[e.to] === undefined || e.pSide > best[e.to]) best[e.to] = e.pSide; });
    Object.keys(best).forEach(function (sq) { placeCircle(sq, best[sq]); });
  }
  function refreshOverlay() { if (fullHeatmap) showFullHeatmap(); else clearOverlay(); }

  /* ======================================================================
     SECTION: DECISION TREE DATA (for the canvas)
     ====================================================================== */
  function buildTreeLevels() {
    var g = new Chess();
    var hist = game.history({ verbose: true });
    var levels = [];
    for (var k = 0; k <= hist.length; k++) {
      var legal = g.moves();                         // SAN list at position k
      var chosenSan = (k < hist.length) ? hist[k].san : null;
      var snap = candidateSnapshots[k];
      var probBySan = {};
      if (snap) snap.forEach(function (c) { probBySan[c.san] = c.pSide; });
      var moves = legal.map(function (san) {
        return { san: san, chosen: san === chosenSan, pSide: probBySan[san] };
      });
      levels.push({ ply: k, pWhite: probHistory[k], moves: moves });
      if (k < hist.length) g.move({ from: hist[k].from, to: hist[k].to, promotion: hist[k].promotion });
    }
    return levels;
  }
  function renderTree() {
    treeView.setData(buildTreeLevels(), game.history().length);
  }

  /* ======================================================================
     SECTION: GAME-AS-HASH (right tile)
     ====================================================================== */
  function computeEntropyBits() {
    var g = new Chess(), hist = game.history({ verbose: true }), bits = 0;
    for (var i = 0; i < hist.length; i++) {
      var n = g.moves().length;
      if (n > 0) bits += Math.log2(n);
      g.move({ from: hist[i].from, to: hist[i].to, promotion: hist[i].promotion });
    }
    return bits;
  }
  function oneInFromBits(bits) {
    if (bits <= 0) return '1 in 1';
    var log10 = bits * Math.LN2 / Math.LN10;
    if (log10 < 15) return '1 in ' + Math.round(Math.pow(10, log10)).toLocaleString('de-DE');
    return '1 in 10^' + log10.toFixed(1);
  }
  function humanizeSeconds(s) {
    var units = [['Jahre', 31557600], ['Tage', 86400], ['Stunden', 3600], ['Minuten', 60], ['Sekunden', 1]];
    for (var i = 0; i < units.length; i++) {
      if (s >= units[i][1]) {
        var v = s / units[i][1];
        return (v >= 100 ? Math.round(v).toLocaleString('de-DE') : v.toFixed(1)) + ' ' + units[i][0];
      }
    }
    return s.toFixed(2) + ' Sekunden';
  }
  function crackEstimate(bits) {
    var log10sec = (bits - 1) * Math.LN2 / Math.LN10 - Math.log10(CRACK_RATE);
    var log10yr = log10sec - Math.log10(31557600);
    var universeLog10Years = 10.14;
    if (log10yr > universeLog10Years) {
      return { text: '≈ 10^' + log10yr.toFixed(1) + ' Jahre — praktisch unknackbar',
        note: 'Übersteigt das Alter des Universums (~1,4×10¹⁰ Jahre) um Faktor 10^' + (log10yr - universeLog10Years).toFixed(1) + '.' };
    }
    if (log10sec < 0) return { text: '< 1 Sekunde', note: '' };
    return { text: humanizeSeconds(Math.pow(10, log10sec)), note: '' };
  }
  function sha256Hex(str) {
    if (!(window.crypto && window.crypto.subtle)) return Promise.resolve(null);
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      var bytes = new Uint8Array(buf), hex = '';
      for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    });
  }
  function renderGameInfo() {
    var pgn = game.pgn() || '(noch keine Züge)', fen = game.fen();
    $['game-pgn'].textContent = pgn;
    $['game-fen'].textContent = fen;
    var bits = computeEntropyBits();
    $['game-prob'].textContent = oneInFromBits(bits) + '  (P = ' + (bits === 0 ? '1' : '2^-' + bits.toFixed(1)) + ')';
    $['game-entropy'].textContent = bits.toFixed(1) + ' bit';
    var est = crackEstimate(bits);
    $['game-crack'].textContent = est.text;
    $['crack-note'].textContent = 'Annahme: ' + CRACK_RATE.toLocaleString('de-DE') + ' Versuche/Sekunde. ' +
      (est.note || 'Mehr Entropie (seltenere Zugfolge) ⇒ schwerer zu erraten.');
    var myGen = gen;
    $['game-hash'].textContent = '…';
    sha256Hex(pgn + '|' + fen).then(function (hex) {
      if (gen !== myGen) return;
      $['game-hash'].textContent = hex || 'nicht verfügbar (kein https/localhost?)';
    });
  }

  /* ======================================================================
     SECTION: SIMULATION DRIVERS
     ====================================================================== */
  function simulateTopRight() {
  var fen = game.fen(), myGen = gen, ply = game.history().length;
  setStatus('');
  setProgress('Simuliere (' + pool.length + ' Threads) …');
  return parallelSim(fen, SIM_GAMES).then(function (res) {
    if (gen !== myGen) return;
    updateProbabilityUI(res.pWhite, res.pDraw, res.pBlack);
    probHistory[ply] = res.pWhite;
    setProgress('Fertig — ' + res.total + ' Partien auf ' + pool.length + ' Threads simuliert.');
    setExplain(
      'Aus der aktuellen Stellung wurden <strong>' + res.total + '</strong> zufällige Partien zu Ende ' +
      'gespielt (parallel auf <strong>' + pool.length + '</strong> Threads). Weiß gewann <strong>' +
      res.whiteWins + '</strong>, Schwarz <strong>' + res.blackWins + '</strong>, <strong>' + res.draws +
      '</strong> remis — das sind die <strong>Monte-Carlo-Wahrscheinlichkeiten</strong>.'
    );
    renderTree();
  }).catch(function (err) {
    if (err.message !== 'Cancelled') showError(err);
  });
}

function computeHeatmap() {
  if (game.game_over() || !isHuman(game.turn())) {
    heatmapReady = false;
    setHeatmapState(game.game_over() ? '—' : 'Bot am Zug — keine Heatmap.');
    return;
  }
  var moves = game.moves({ verbose: true });
  if (!moves.length) return;
  heatmapReady = false;
  setHeatmapState('Heatmap (' + pool.length + ' Threads) …');

  var whiteToMove = game.turn() === 'w', ply = game.history().length;
  var jobs = moves.map(function (mv) {
    game.move(mv); var fen = game.fen(); game.undo();
    return { key: mv.from + mv.to, from: mv.from, to: mv.to, san: mv.san, fen: fen };
  });

  var myGen = gen;
  parallelAnalyze(jobs, HEATMAP_GAMES).then(function (results) {
    if (gen !== myGen) return;
    heatmapList = results.map(function (r) {
      return { from: r.from, to: r.to, san: r.san, pWhite: r.pWhite, pDraw: r.pDraw, pBlack: r.pBlack,
               pSide: whiteToMove ? r.pWhite : r.pBlack };
    });
    heatmapByFrom = {};
    heatmapList.forEach(function (e) { (heatmapByFrom[e.from] = heatmapByFrom[e.from] || []).push(e); });
    candidateSnapshots[ply] = heatmapList.map(function (e) { return { san: e.san, pSide: e.pSide }; });
    heatmapReady = true;
    setHeatmapState('Heatmap bereit — Figur anfassen oder „Gesamte Heatmap“.');
    renderTree();
    refreshOverlay();
  }).catch(function (err) {
    if (err.message !== 'Cancelled') showError(err);
  });
}

  /* ======================================================================
     SECTION: POSITION-CHANGE PIPELINE + BOT LOOP
     ====================================================================== */
  function onPositionChanged() {
    cancelAllWork();        // bumps gen, rebuilds pool (drops stale work)
    var myGen = gen;
    clearOverlay();
    heatmapList = []; heatmapByFrom = {}; heatmapReady = false;

    updateTurnPill();
    renderTree();
    renderGameInfo();

    if (handleGameOver()) { renderTree(); return; }

    simulateTopRight();     // top-right probabilities (parallel)
    computeHeatmap();       // background heatmap (only if a human is to move)

    // If it's a bot's turn, play after a short, watchable delay.
    if (!isHuman(game.turn())) {
      var who = game.turn() === 'w' ? 'Weiß' : 'Schwarz';
      setProgress('Bot (' + who + ', Minimax Tiefe ' + BOT_DEPTH + ') denkt nach …');
      delay(BOT_DELAY_MS).then(function () {
        if (gen !== myGen || game.game_over()) return;
        try {
          var mv = chooseBotMove();
          if (mv) { game.move(mv); board.position(game.fen()); }
        } catch (e) { showError(e); return; }
        onPositionChanged();
      });
    }
  }

  /* ======================================================================
     SECTION: BOARD EVENTS (drag only the side to move, and only if human)
     ====================================================================== */
  function onDragStart(source, piece) {
    if (game.game_over()) return false;
    var turn = game.turn();
    if (!isHuman(turn)) return false;
    if ((turn === 'w' && piece.charAt(0) === 'b') || (turn === 'b' && piece.charAt(0) === 'w')) return false;
    showPickupHeatmap(source);
    return true;
  }
  function onDrop(source, target) {
    var move = null;
    try { move = game.move({ from: source, to: target, promotion: 'q' }); }
    catch (e) { showError(e); refreshOverlay(); return 'snapback'; }
    if (move === null) { refreshOverlay(); return 'snapback'; }
    window.setTimeout(onPositionChanged, 0);
  }
  function onSnapEnd() { board.position(game.fen()); }

  /* ======================================================================
     SECTION: CONTROLS
     ====================================================================== */
  function toggleFullHeatmap() {
    fullHeatmap = !fullHeatmap;
    $['btn-heatmap'].classList.toggle('active', fullHeatmap);
    refreshOverlay();
  }
  function newGame() {
    try {
      game = new Chess();
      board.position('start');
      probHistory = [];
      candidateSnapshots = [];
      fullHeatmap = false;
      $['btn-heatmap'].classList.remove('active');
      treeView.lastPlyCount = -1; // force re-center
      onPositionChanged();
    } catch (e) { showError(e); }
  }
  function onModeChange() {
    MODE = $['mode-select'].value;
    newGame();
  }

  /* ======================================================================
     SECTION: BOOTSTRAP
     ====================================================================== */
  function init() {
    try {
      cacheDom();
      buildPool();
      game = new Chess();
      treeView = new TreeView($['tree-canvas']);

      board = Chessboard('board', {
        draggable: true,
        position: 'start',
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd,
        pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'
      });

      $['btn-heatmap'].addEventListener('click', toggleFullHeatmap);
      $['btn-reset'].addEventListener('click', newGame);
      $['btn-tree-reset'].addEventListener('click', function () { treeView.resetView(); });
      $['mode-select'].addEventListener('change', onModeChange);
      $['mode-select'].value = MODE;

      window.addEventListener('resize', function () { board.resize(); refreshOverlay(); });

      onPositionChanged();
    } catch (e) { showError(e); }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
