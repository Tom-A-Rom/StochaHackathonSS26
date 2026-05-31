/* ============================================================================
   app.js — UI, hot-seat game flow, heatmap, decision tree, game-as-hash
   ----------------------------------------------------------------------------
   Both colours are played by the human (hot-seat). The heavy Monte Carlo work
   lives in js/sim-worker.js (a Web Worker) so the board stays smooth.

   MIT License.
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     SECTION: CONFIG & STATE
     ====================================================================== */
  var SIM_GAMES     = 1000; // Monte Carlo games for the top-right probability
  var HEATMAP_GAMES = 200;  // games per candidate move for the heatmap
  var CRACK_RATE    = 1e9;  // assumed brute-force guesses / second
  var TOP_CANDIDATES = 5;   // candidate moves shown in the decision tree

  var game;                  // chess.js instance
  var board;                 // chessboard.js instance
  var gen = 0;               // generation token; bumped whenever the position changes
  var analyzing = false;     // heatmap computation in progress
  var fullHeatmap = false;   // "Gesamte Heatmap" toggle state

  // Heatmap data for the CURRENT position (computed in the background).
  var heatmapList = [];      // [ {from,to,san,pWhite,pDraw,pBlack,pSide} ]
  var heatmapByFrom = {};    // { fromSquare: [entries] }
  var heatmapReady = false;

  var probHistory = [];      // white-win prob after each ply (for the tree)

  /* ======================================================================
     SECTION: WEB WORKER WRAPPER (promise-based)
     ====================================================================== */
  var worker, reqId = 0, pending = {};

  function createWorker() {
    worker = new Worker('js/sim-worker.js');
    worker.onmessage = function (e) {
      var m = e.data, p = pending[m.id];
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.done, m.total); }
      else if (m.type === 'analyzeProgress') { if (p.onAnalyzeProgress) p.onAnalyzeProgress(m.index, m.total, m.san); }
      else if (m.type === 'result') { delete pending[m.id]; p.resolve(m); }
      else if (m.type === 'analyzeResult') { delete pending[m.id]; p.resolve(m.results); }
    };
    worker.onerror = function (err) { showError('Worker-Fehler: ' + (err.message || 'siehe Konsole')); };
  }

  function simulate(fen, nGames, onProgress) {
    return new Promise(function (resolve) {
      var id = ++reqId;
      pending[id] = { resolve: resolve, onProgress: onProgress };
      worker.postMessage({ cmd: 'sim', id: id, fen: fen, nGames: nGames,
        progressEvery: Math.max(1, Math.floor(nGames / 20)) });
    });
  }

  function analyze(jobs, nGames, onAnalyzeProgress) {
    return new Promise(function (resolve) {
      var id = ++reqId;
      pending[id] = { resolve: resolve, onAnalyzeProgress: onAnalyzeProgress };
      worker.postMessage({ cmd: 'analyze', id: id, jobs: jobs, nGames: nGames });
    });
  }

  // Hard-cancel everything in flight: terminate + recreate the worker.
  function cancelAllWork() {
    if (worker) worker.terminate();
    pending = {};
    createWorker();
  }

  /* ======================================================================
     SECTION: DOM HELPERS
     ====================================================================== */
  var $ = {};
  function cacheDom() {
    ['progress','status-msg','prob-text','seg-white','seg-draw','seg-black',
     'explain','legend','turn-pill','board-hint','heatmap-state',
     'btn-heatmap','btn-reset','decision-tree',
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
    if (game.turn() === 'w') { p.textContent = 'Weiß am Zug'; p.className = 'turn-pill white'; }
    else { p.textContent = 'Schwarz am Zug'; p.className = 'turn-pill black'; }
  }

  /* ======================================================================
     SECTION: GAME-OVER HANDLING
     ====================================================================== */
  function handleGameOver() {
    if (!game.game_over()) return false;
    if (game.in_checkmate()) {
      if (game.turn() === 'w') { updateProbabilityUI(0, 0, 1); setStatus('Checkmate! Black wins.', 'lose'); }
      else { updateProbabilityUI(1, 0, 0); setStatus('Checkmate! White wins.', 'win'); }
    } else if (game.in_stalemate()) {
      updateProbabilityUI(0, 1, 0); setStatus('Stalemate — draw.', 'draw');
    } else if (game.insufficient_material()) {
      updateProbabilityUI(0, 1, 0); setStatus('Draw — insufficient material.', 'draw');
    } else if (game.in_threefold_repetition()) {
      updateProbabilityUI(0, 1, 0); setStatus('Draw — threefold repetition.', 'draw');
    } else {
      updateProbabilityUI(0, 1, 0); setStatus('Draw (50-move rule).', 'draw');
    }
    setProgress('Spiel beendet.');
    $['heatmap-state'].textContent = 'Keine Züge mehr möglich.';
    updateTurnPill();
    return true;
  }

  /* ======================================================================
     SECTION: HEATMAP — colour helpers + rendering
     ====================================================================== */
  function probToColor(p) { return 'hsl(' + (p * 120).toFixed(0) + ', 70%, 50%)'; }

  function clearOverlay() {
    document.getElementById('analysis-overlay').innerHTML = '';
    $['legend'].classList.remove('show');
  }

  function placeCircle(square, prob, label) {
    var overlay = document.getElementById('analysis-overlay');
    // chessboard.js tags every square with data-square — robust selector.
    var sqEl = document.querySelector('#board [data-square="' + square + '"]');
    if (!sqEl) return;
    var bRect = document.getElementById('board').getBoundingClientRect();
    var sqRect = sqEl.getBoundingClientRect();
    var size = Math.min(sqRect.width, sqRect.height) * 0.6;
    var c = document.createElement('div');
    c.className = 'mc-circle';
    c.style.width = size + 'px';
    c.style.height = size + 'px';
    c.style.left = ((sqRect.left - bRect.left) + (sqRect.width - size) / 2) + 'px';
    c.style.top = ((sqRect.top - bRect.top) + (sqRect.height - size) / 2) + 'px';
    c.style.background = probToColor(prob);
    c.textContent = label != null ? label : (prob * 100).toFixed(0);
    overlay.appendChild(c);
  }

  // Show the heatmap circles for the moves of a single piece (on pickup).
  function showPickupHeatmap(fromSquare) {
    clearOverlay();
    var entries = heatmapByFrom[fromSquare];
    if (!entries || !entries.length) return;
    $['legend'].classList.add('show');
    entries.forEach(function (e) { placeCircle(e.to, e.pSide); });
  }

  // Show every legal move's heatmap at once (toggle button).
  function showFullHeatmap() {
    clearOverlay();
    if (!heatmapList.length) return;
    $['legend'].classList.add('show');
    // If two moves target the same square, keep the higher side-to-move prob.
    var best = {};
    heatmapList.forEach(function (e) {
      if (best[e.to] === undefined || e.pSide > best[e.to]) best[e.to] = e.pSide;
    });
    Object.keys(best).forEach(function (sq) { placeCircle(sq, best[sq]); });
  }

  function refreshOverlay() {
    if (fullHeatmap) showFullHeatmap(); else clearOverlay();
  }

  /* ======================================================================
     SECTION: DECISION TREE (left tile)
     ====================================================================== */
  function renderDecisionTree() {
    var host = $['decision-tree'];
    var hist = game.history({ verbose: true });

    var html = '<div class="node root"><span class="san">Start</span> ' +
               '<span class="ply">(Ausgangsstellung)</span></div>';

    // Spine: one node per played move, nested to look like a growing branch.
    for (var i = 0; i < hist.length; i++) {
      var mv = hist[i];
      var moveNo = Math.floor(i / 2) + 1;
      var dots = mv.color === 'w' ? '.' : '…';
      // probHistory[k] = White win-% of the position AFTER k plies.
      var pct = (probHistory[i + 1] != null)
        ? '<span class="pct">' + (probHistory[i + 1] * 100).toFixed(1) + '% W</span>' : '';
      html += '<div class="node">' +
                '<span class="ply">' + moveNo + dots + '</span> ' +
                '<span class="san ' + mv.color + '">' + mv.san + '</span> ' + pct +
              '</div>';
    }

    // Candidate next moves (leaves) from the heatmap, best first.
    if (heatmapReady && heatmapList.length && !game.game_over()) {
      var side = game.turn() === 'w' ? 'Weiß' : 'Schwarz';
      var cands = heatmapList.slice().sort(function (a, b) { return b.pSide - a.pSide; })
                             .slice(0, TOP_CANDIDATES);
      html += '<div class="cand-head">Kandidaten (' + side + ' am Zug)</div>';
      cands.forEach(function (c, idx) {
        html += '<div class="cand' + (idx === 0 ? ' best' : '') + '">' +
                  '<span class="dot" style="background:' + probToColor(c.pSide) + '"></span>' +
                  '<span class="san">' + c.san + '</span> — ' +
                  '<span class="pct">' + (c.pSide * 100).toFixed(1) + '%</span>' +
                '</div>';
      });
    } else if (!game.game_over()) {
      html += '<div class="cand-head">Kandidaten werden berechnet …</div>';
    }

    host.innerHTML = html;
  }

  /* ======================================================================
     SECTION: GAME-AS-HASH (right tile)
     ------------------------------------------------------------------------
     Sequence probability of this exact line = product over plies of
     1 / (#legal moves at that ply). The equivalent entropy in bits is
     sum of log2(#legal moves). We then treat the line as a secret of that
     entropy and estimate a brute-force "time to crack".
     ====================================================================== */

  // Replay the game from the start to get the branching factor at each ply.
  function computeEntropyBits() {
    var g = new Chess();
    var hist = game.history({ verbose: true });
    var bits = 0;
    for (var i = 0; i < hist.length; i++) {
      var n = g.moves().length;          // legal moves BEFORE this ply
      if (n > 0) bits += Math.log2(n);
      g.move({ from: hist[i].from, to: hist[i].to, promotion: hist[i].promotion });
    }
    return bits;
  }

  // Format a power-of-ten exponent into a readable "1 in N" string.
  function oneInFromBits(bits) {
    if (bits <= 0) return '1 in 1';
    var log10 = bits * Math.LN2 / Math.LN10;
    if (log10 < 15) {
      var n = Math.pow(10, log10);
      return '1 in ' + Math.round(n).toLocaleString('de-DE');
    }
    return '1 in 10^' + log10.toFixed(1);
  }

  // Estimate brute-force time from entropy bits. Returns {text, note}.
  function crackEstimate(bits) {
    // Average guesses to find a secret of `bits` entropy = 2^(bits-1).
    // log10(seconds) = (bits-1)*log10(2) - log10(rate)
    var log10sec = (bits - 1) * Math.LN2 / Math.LN10 - Math.log10(CRACK_RATE);
    var log10yr = log10sec - Math.log10(31557600); // seconds per year

    var universeLog10Years = 10.14; // ~13.8 billion years
    if (log10yr > universeLog10Years) {
      return {
        text: '≈ 10^' + log10yr.toFixed(1) + ' Jahre — praktisch unknackbar',
        note: 'Das übersteigt das Alter des Universums (~1,4×10¹⁰ Jahre) um den Faktor 10^' +
              (log10yr - universeLog10Years).toFixed(1) + '.'
      };
    }
    if (log10sec < 0) return { text: '< 1 Sekunde', note: '' };

    var seconds = Math.pow(10, log10sec);
    return { text: humanizeSeconds(seconds), note: '' };
  }

  function humanizeSeconds(s) {
    var units = [
      ['Jahre', 31557600], ['Tage', 86400], ['Stunden', 3600],
      ['Minuten', 60], ['Sekunden', 1]
    ];
    for (var i = 0; i < units.length; i++) {
      if (s >= units[i][1]) {
        var v = s / units[i][1];
        return (v >= 100 ? Math.round(v).toLocaleString('de-DE') : v.toFixed(1)) + ' ' + units[i][0];
      }
    }
    return s.toFixed(2) + ' Sekunden';
  }

  // SHA-256 of an arbitrary string -> hex (uses the Web Crypto API).
  function sha256Hex(str) {
    if (!(window.crypto && window.crypto.subtle)) return Promise.resolve(null);
    var data = new TextEncoder().encode(str);
    return window.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      var bytes = new Uint8Array(buf), hex = '';
      for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    });
  }

  function renderGameInfo() {
    var pgn = game.pgn() || '(noch keine Züge)';
    var fen = game.fen();
    $['game-pgn'].textContent = pgn;
    $['game-fen'].textContent = fen;

    var bits = computeEntropyBits();
    $['game-prob'].textContent = oneInFromBits(bits) +
      '  (P = ' + (bits === 0 ? '1' : '2^-' + bits.toFixed(1)) + ')';
    $['game-entropy'].textContent = bits.toFixed(1) + ' bit';

    var est = crackEstimate(bits);
    $['game-crack'].textContent = est.text;
    $['crack-note'].textContent =
      'Annahme: ' + CRACK_RATE.toLocaleString('de-DE') + ' Versuche/Sekunde. ' +
      (est.note || 'Mehr Entropie (seltenere Zugfolge) ⇒ schwerer zu erraten.');

    // The hash is of the game string — fill in asynchronously.
    var myGen = gen;
    $['game-hash'].textContent = '…';
    sha256Hex(pgn + '|' + fen).then(function (hex) {
      if (gen !== myGen) return;           // position changed meanwhile
      $['game-hash'].textContent = hex || 'nicht verfügbar (kein https/localhost?)';
    });
  }

  /* ======================================================================
     SECTION: MONTE CARLO DRIVERS
     ====================================================================== */
  function simulateTopRight(label) {
    var fen = game.fen(), myGen = gen;
    setStatus('');
    return simulate(fen, SIM_GAMES, function (done, total) {
      if (gen !== myGen) return;
      setProgress((label || 'Simulating...') + ' ' + done + '/' + total + ' games');
    }).then(function (res) {
      if (gen !== myGen) return;
      updateProbabilityUI(res.pWhite, res.pDraw, res.pBlack);
      probHistory[game.history().length] = res.pWhite; // snapshot for the tree
      setProgress('Fertig — ' + SIM_GAMES + ' zufällige Partien simuliert.');
      setExplain(
        'Aus der aktuellen Stellung wurden <strong>' + SIM_GAMES + '</strong> ' +
        'zufällige Partien zu Ende gespielt. Weiß gewann <strong>' + res.whiteWins +
        '</strong>, Schwarz <strong>' + res.blackWins + '</strong>, <strong>' +
        res.draws + '</strong> remis. Die Anteile sind die ' +
        '<strong>Monte-Carlo-Wahrscheinlichkeiten</strong>.'
      );
      renderDecisionTree();
    });
  }

  // Background heatmap for the side to move at the current position.
  function computeHeatmap() {
    if (game.game_over()) { heatmapReady = false; $['heatmap-state'].textContent = '—'; return; }
    var moves = game.moves({ verbose: true });
    if (!moves.length) return;

    analyzing = true;
    heatmapReady = false;
    $['heatmap-state'].textContent = 'Heatmap wird berechnet …';

    var whiteToMove = game.turn() === 'w';
    var jobs = moves.map(function (mv) {
      game.move(mv);
      var fen = game.fen();
      game.undo();
      return { key: mv.from + mv.to, from: mv.from, to: mv.to, san: mv.san, fen: fen };
    });

    var myGen = gen;
    analyze(jobs, HEATMAP_GAMES, function (index, total, san) {
      if (gen !== myGen) return;
      $['heatmap-state'].textContent = 'Heatmap: Zug ' + (index + 1) + ' von ' + total + ' (' + san + ') …';
    }).then(function (results) {
      if (gen !== myGen) return;
      heatmapList = results.map(function (r) {
        return {
          from: r.from, to: r.to, san: r.san,
          pWhite: r.pWhite, pDraw: r.pDraw, pBlack: r.pBlack,
          pSide: whiteToMove ? r.pWhite : r.pBlack
        };
      });
      heatmapByFrom = {};
      heatmapList.forEach(function (e) {
        (heatmapByFrom[e.from] = heatmapByFrom[e.from] || []).push(e);
      });
      heatmapReady = true;
      analyzing = false;
      $['heatmap-state'].textContent = 'Heatmap bereit — Figur anfassen oder „Gesamte Heatmap“.';
      renderDecisionTree();
      refreshOverlay();
    }).catch(function (e) { analyzing = false; showError(e); });
  }

  /* ======================================================================
     SECTION: POSITION-CHANGE PIPELINE
     ====================================================================== */
  function onPositionChanged() {
    gen++;                 // invalidate stale callbacks
    cancelAllWork();       // drop any running simulation/heatmap
    clearOverlay();
    heatmapList = []; heatmapByFrom = {}; heatmapReady = false;

    updateTurnPill();
    renderDecisionTree();
    renderGameInfo();

    if (handleGameOver()) { renderDecisionTree(); return; }

    setProgress('Simulating...');
    simulateTopRight('Simulating...');  // top-right probabilities
    computeHeatmap();                   // background heatmap for next move
  }

  /* ======================================================================
     SECTION: CHESSBOARD.JS EVENT HANDLERS (hot-seat: drag the side to move)
     ====================================================================== */
  function onDragStart(source, piece) {
    if (game.game_over()) return false;
    var turn = game.turn();
    if ((turn === 'w' && piece.charAt(0) === 'b') ||
        (turn === 'b' && piece.charAt(0) === 'w')) return false;
    // Reveal the heatmap for THIS piece's moves while dragging.
    showPickupHeatmap(source);
    return true;
  }

  function onDrop(source, target) {
    var move = null;
    try { move = game.move({ from: source, to: target, promotion: 'q' }); }
    catch (e) { showError(e); refreshOverlay(); return 'snapback'; }
    if (move === null) { refreshOverlay(); return 'snapback'; } // illegal -> restore overlay
    // Legal move: chessboard.js will redraw; then run the pipeline.
    window.setTimeout(onPositionChanged, 0);
  }

  function onSnapEnd() { board.position(game.fen()); }

  /* ======================================================================
     SECTION: BUTTONS
     ====================================================================== */
  function toggleFullHeatmap() {
    fullHeatmap = !fullHeatmap;
    $['btn-heatmap'].classList.toggle('active', fullHeatmap);
    refreshOverlay();
  }

  function resetGame() {
    try {
      gen++;
      cancelAllWork();
      game = new Chess();
      board.position('start');
      probHistory = [];
      fullHeatmap = false;
      $['btn-heatmap'].classList.remove('active');
      onPositionChanged();
    } catch (e) { showError(e); }
  }

  /* ======================================================================
     SECTION: BOOTSTRAP
     ====================================================================== */
  function init() {
    try {
      cacheDom();
      createWorker();
      game = new Chess();

      board = Chessboard('board', {
        draggable: true,
        position: 'start',
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd,
        pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'
      });

      $['btn-heatmap'].addEventListener('click', toggleFullHeatmap);
      $['btn-reset'].addEventListener('click', resetGame);

      // Heatmap circles are pixel-positioned; re-render them on resize.
      window.addEventListener('resize', function () {
        board.resize();
        refreshOverlay();
      });

      onPositionChanged(); // initial simulation + heatmap from the start position
    } catch (e) { showError(e); }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
