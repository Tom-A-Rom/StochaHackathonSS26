/* ============================================================================
   app.js — UI, game modes, and a switchable WIN/DRAW/LOSS data source
   ----------------------------------------------------------------------------
   Three interchangeable sources feed the top-right probability, the per-move
   heatmap and the decision tree (pick one with the "Datenquelle" selector):

     1. lichess-live  — fetch precomputed real-game stats from the open Lichess
                        opening-explorer API (CC0). Instant, huge coverage.
     2. lichess-file  — same data, pre-downloaded into data/lichess-tree.json
                        by tools/fetch-lichess-tree.js. Fully offline.
     3. mc-live       — our own LIVE Monte-Carlo simulation in a Web Worker pool
                        (truncated random playouts). Slower, but it is real,
                        on-the-fly stochastic simulation.

   Every source resolves to the same shape so the rest of the app doesn't care:
     { ok:true, sim:{pWhite,pDraw,pBlack}, moves:[{san,uci,from,to,pWhite,pDraw,pBlack}] }
   or { ok:false, reason:'nodata'|'unavailable', message? }.

   MIT License.
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     CONFIG & STATE
     ====================================================================== */
  var SIM_GAMES     = 600;   // Monte-Carlo games for the position (mc-live)
  var HEATMAP_GAMES = 80;    // games per candidate move for the heatmap (mc-live)
  var CRACK_RATE    = 1e9;   // assumed brute-force guesses / second
  var BOT_DEPTH     = 2;     // minimax search depth
  var BOT_DELAY_MS  = 350;   // pause before a bot move (so you can watch)
  var PIECE_VALUE   = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  var POOL_SIZE     = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4)));

  var MODE   = 'hvb';          // 'hvh' | 'hvb' (human=White) | 'bvb'
  var SOURCE = 'lichess-live'; // 'lichess-live' | 'lichess-file' | 'mc-live'
                               // lichess-live = Stockfish cloud-eval on lichess.org (instant, cached).
                               // mc-live = our own simulation, works for ANY position with no external API.
  var SOURCE_LABEL = {
    'lichess-live': 'Lichess · live',
    'lichess-file': 'Lichess · Datei',
    'mc-live':      'Monte-Carlo · live'
  };

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
  function posKey(fen) { return fen.split(' ').slice(0, 4).join(' '); }
  function split(w, d, b) { var t = (w + d + b) || 1; return { pWhite: w / t, pDraw: d / t, pBlack: b / t }; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ======================================================================
     WORKER POOL — only used by the mc-live source
     ====================================================================== */
  var pool = [], msgId = 0, waiting = {};

  function ensurePool() {
    if (pool.length) return;
    for (var i = 0; i < POOL_SIZE; i++) {
      var w = new Worker('js/sim-worker.js');
      w.onmessage = onPoolMessage;
      w.onerror = function (err) { showError('Worker: ' + (err.message || 'siehe Konsole')); };
      pool.push(w);
    }
  }
  function teardownPool() {
    Object.keys(waiting).forEach(function (id) { waiting[id].reject(new Error('Cancelled')); });
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
      var id = ++msgId; msg.id = id;
      waiting[id] = { resolve: resolve, reject: reject };
      worker.postMessage(msg);
    });
  }
  function parallelSim(fen, nGames) {
    var k = pool.length, base = Math.floor(nGames / k), rem = nGames % k, proms = [];
    for (var i = 0; i < k; i++) {
      var n = base + (i < rem ? 1 : 0);
      if (n > 0) proms.push(post(pool[i], { cmd: 'sim', fen: fen, nGames: n }));
    }
    return Promise.all(proms).then(function (rs) {
      var w = 0, b = 0, d = 0;
      rs.forEach(function (r) { w += r.whiteWins; b += r.blackWins; d += r.draws; });
      var t = w + b + d || 1;
      return { whiteWins: w, blackWins: b, draws: d, pWhite: w / t, pDraw: d / t, pBlack: b / t, total: t };
    });
  }
  function parallelAnalyze(jobs, gamesPerJob) {
    var k = pool.length, buckets = [], i;
    for (i = 0; i < k; i++) buckets.push([]);
    for (i = 0; i < jobs.length; i++) buckets[i % k].push(jobs[i]);
    var proms = buckets.map(function (b, idx) {
      return b.length ? post(pool[idx], { cmd: 'analyze', jobs: b, nGames: gamesPerJob })
                      : Promise.resolve([]);
    });
    return Promise.all(proms).then(function (rs) { return Array.prototype.concat.apply([], rs); });
  }

  /* ======================================================================
     DATA SOURCES
     ====================================================================== */
  // --- Lichess cloud evaluation (Stockfish, cached) → win chances ---
  // explorer.lichess.ovh is a separate host (often network-blocked); the
  // cloud-eval endpoint lives on lichess.org itself and returns a cached engine
  // evaluation (centipawns / mate) plus the top lines, which we convert into a
  // white/draw/black split and a per-move heatmap. Only cached positions exist,
  // so off-book positions return 'nodata'.
  function evalToWhiteScore(pv) {              // -> White's expected score in [0,1]
    if (typeof pv.mate === 'number') return pv.mate > 0 ? 0.995 : 0.005;
    return 1 / (1 + Math.exp(-0.00368208 * (pv.cp || 0)));
  }
  function scoreToWDL(E) {                      // split expected score into W/D/L
    var adv = Math.abs(2 * E - 1);             // 0 = balanced, 1 = decisive
    var d = 0.45 * Math.pow(1 - adv, 1.3);     // more draws when balanced
    var w = Math.max(0, E - d / 2), b = Math.max(0, (1 - E) - d / 2);
    var t = w + b + d || 1;
    return { pWhite: w / t, pDraw: d / t, pBlack: b / t };
  }

  var lichessCache = {};
  function lichessLiveGet(fen) {
    var key = posKey(fen);
    if (lichessCache[key]) return Promise.resolve(lichessCache[key]);
    var url = 'https://lichess.org/api/cloud-eval?multiPv=5&fen=' + encodeURIComponent(fen);
    return fetch(url).then(function (r) {
      if (r.status === 404) return null;       // not in the cloud cache
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.pvs || !j.pvs.length) {
        var nod = { ok: false, reason: 'nodata' }; lichessCache[key] = nod; return nod;
      }
      var g = new Chess(fen);
      var moves = j.pvs.map(function (pv) {
        var uci = (pv.moves || '').split(' ')[0] || '';
        var from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci.slice(4) || undefined;
        var wdl = scoreToWDL(evalToWhiteScore(pv));
        var san = uci;
        try { var mv = g.move({ from: from, to: to, promotion: promo }); if (mv) { san = mv.san; g.undo(); } } catch (e) {}
        return { san: san, uci: uci, from: from, to: to,
                 pWhite: wdl.pWhite, pDraw: wdl.pDraw, pBlack: wdl.pBlack };
      });
      var res = { ok: true, sim: scoreToWDL(evalToWhiteScore(j.pvs[0])),
                  moves: moves, depth: j.depth };
      lichessCache[key] = res;
      return res;
    }).catch(function (e) {
      return { ok: false, reason: 'unavailable', message: e.message };
    });
  }

  // --- Bundled JSON file (Lichess tree). Loaded once, looked up by key. ---
  var fileTables = {};
  function loadFile(url) {
    var t = fileTables[url];
    if (t) return t.loading;
    t = fileTables[url] = { table: null, meta: null, err: null, loading: null };
    t.loading = fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      t.table = j.positions || {}; t.meta = j.meta || {};
    }).catch(function (e) { t.err = e; t.table = {}; });
    return t.loading;
  }
  function fileGet(url, fen) {
    return loadFile(url).then(function () {
      var t = fileTables[url];
      if (t.err) return { ok: false, reason: 'unavailable',
        message: 'Datei fehlt — bitte tools/fetch-lichess-tree.js ausführen' };
      var p = t.table[posKey(fen)];
      if (!p) return { ok: false, reason: 'nodata' };
      return { ok: true, sim: p.sim, moves: p.moves || [], depth: p.depth };
    });
  }

  // --- Live Monte-Carlo via the worker pool ---
  function mcLiveGet(fen, opts) {
    ensurePool();
    var simP = parallelSim(fen, SIM_GAMES);
    if (!opts || !opts.wantMoves) {
      return simP.then(function (s) {
        return { ok: true, total: s.total, sim: { pWhite: s.pWhite, pDraw: s.pDraw, pBlack: s.pBlack }, moves: [] };
      });
    }
    var g = new Chess(fen), verbose = g.moves({ verbose: true });
    var jobs = verbose.map(function (mv) {
      g.move(mv); var f = g.fen(); g.undo();
      var uci = mv.from + mv.to + (mv.promotion || '');
      return { key: uci, from: mv.from, to: mv.to, san: mv.san, uci: uci, fen: f };
    });
    return Promise.all([simP, parallelAnalyze(jobs, HEATMAP_GAMES)]).then(function (arr) {
      var s = arr[0], results = arr[1], byKey = {};
      results.forEach(function (r) { byKey[r.key] = r; });
      var moves = jobs.map(function (j) {
        var r = byKey[j.key] || { pWhite: 0, pDraw: 0, pBlack: 0 };
        return { san: j.san, uci: j.uci, from: j.from, to: j.to,
                 pWhite: r.pWhite, pDraw: r.pDraw, pBlack: r.pBlack };
      });
      return { ok: true, total: s.total, sim: { pWhite: s.pWhite, pDraw: s.pDraw, pBlack: s.pBlack }, moves: moves };
    });
  }

  // --- Dispatch ---
  function getPosition(fen, opts) {
    if (SOURCE === 'lichess-live') return lichessLiveGet(fen);
    if (SOURCE === 'lichess-file') return fileGet('data/lichess-tree.json', fen);
    return mcLiveGet(fen, opts);
  }

  /* ======================================================================
     DOM HELPERS
     ====================================================================== */
  var $ = {};
  function cacheDom() {
    ['progress','status-msg','prob-text','seg-white','seg-draw','seg-black',
     'explain','legend','turn-pill','board-hint','heatmap-state',
     'btn-heatmap','btn-reset','btn-tree-reset','mode-select','source-select','tree-canvas',
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
  function setProbUnknown() {
    $['seg-white'].style.width = '33.33%'; $['seg-draw'].style.width = '33.34%'; $['seg-black'].style.width = '33.33%';
    $['seg-white'].textContent = ''; $['seg-draw'].textContent = '?'; $['seg-black'].textContent = '';
    $['prob-text'].innerHTML = '<span class="pw">—</span> | <span class="pd">keine Daten</span> | <span class="pb">—</span>';
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
     BOT (minimax depth 2, material only) — independent of the data source
     ====================================================================== */
  function evaluateMaterial(g) {
    var placement = g.fen().split(' ')[0], score = 0;
    for (var i = 0; i < placement.length; i++) {
      var ch = placement.charAt(i), lower = ch.toLowerCase();
      if (PIECE_VALUE.hasOwnProperty(lower)) score += (ch === lower ? -1 : 1) * PIECE_VALUE[lower];
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
     GAME-OVER
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
     HEATMAP OVERLAY — soft, glowing, animated discs
     ====================================================================== */
  function probToColor(p) { return 'hsl(' + (p * 120).toFixed(0) + ', 78%, 48%)'; }

  function clearOverlay() {
    document.getElementById('analysis-overlay').innerHTML = '';
    $['legend'].classList.remove('show');
  }
  function placeCircle(square, prob, isBest, idx) {
    var boardEl = document.getElementById('board');
    var sqEl = boardEl.querySelector('[data-square="' + square + '"]');
    if (!sqEl) return;
    var bRect = boardEl.getBoundingClientRect(), sqRect = sqEl.getBoundingClientRect();
    var base = Math.min(sqRect.width, sqRect.height);
    var size = base * (0.5 + 0.28 * prob);             // stronger moves grow larger
    var color = probToColor(prob);
    var c = document.createElement('div');
    c.className = 'mc-circle' + (isBest ? ' best' : '');
    c.style.width = size + 'px'; c.style.height = size + 'px';
    c.style.left = ((sqRect.left - bRect.left) + (sqRect.width - size) / 2) + 'px';
    c.style.top  = ((sqRect.top - bRect.top) + (sqRect.height - size) / 2) + 'px';
    c.style.setProperty('--c', color);
    c.style.fontSize = Math.max(10, Math.round(base * 0.17)) + 'px';
    c.style.animationDelay = ((idx || 0) * 16) + 'ms';
    c.innerHTML = '<span class="pct">' + Math.round(prob * 100) + '</span>';
    document.getElementById('analysis-overlay').appendChild(c);
  }
  function renderCircles(pairs) {           // pairs: [{sq, p}]
    if (!pairs.length) return;
    $['legend'].classList.add('show');
    var best = -1; pairs.forEach(function (e) { if (e.p > best) best = e.p; });
    pairs.forEach(function (e, i) { placeCircle(e.sq, e.p, e.p === best, i); });
  }
  function showPickupHeatmap(fromSquare) {
    clearOverlay();
    if (!heatmapReady) return;
    var entries = heatmapByFrom[fromSquare];
    if (!entries || !entries.length) return;
    renderCircles(entries.map(function (e) { return { sq: e.to, p: e.pSide }; }));
  }
  function showFullHeatmap() {
    clearOverlay();
    if (!heatmapList.length) return;
    var best = {};
    heatmapList.forEach(function (e) { if (best[e.to] === undefined || e.pSide > best[e.to]) best[e.to] = e.pSide; });
    renderCircles(Object.keys(best).map(function (sq) { return { sq: sq, p: best[sq] }; }));
  }
  function refreshOverlay() { if (fullHeatmap) showFullHeatmap(); else clearOverlay(); }

  /* ======================================================================
     DECISION TREE DATA
     ====================================================================== */
  function buildTreeLevels() {
    var g = new Chess(), hist = game.history({ verbose: true }), levels = [];
    for (var k = 0; k <= hist.length; k++) {
      var legal = g.moves();
      var chosenSan = (k < hist.length) ? hist[k].san : null;
      var snap = candidateSnapshots[k], probBySan = {};
      if (snap) snap.forEach(function (c) { probBySan[c.san] = c.pSide; });
      var moves = legal.map(function (san) {
        return { san: san, chosen: san === chosenSan, pSide: probBySan[san] };
      });
      levels.push({ ply: k, pWhite: probHistory[k], moves: moves });
      if (k < hist.length) g.move({ from: hist[k].from, to: hist[k].to, promotion: hist[k].promotion });
    }
    return levels;
  }
  function renderTree() { treeView.setData(buildTreeLevels(), game.history().length); }

  /* ======================================================================
     GAME-AS-HASH (right tile)
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
     POSITION REFRESH (source-driven) + BOT LOOP
     ====================================================================== */
  function loadingLabel() {
    if (SOURCE === 'mc-live') return 'Simuliere live (' + (pool.length || POOL_SIZE) + ' Threads) …';
    if (SOURCE === 'lichess-live') return 'Lichess wird abgerufen …';
    return 'Lichess-Datei wird geladen …';
  }
  function doneLabel(res) {
    if (SOURCE === 'mc-live') return 'Fertig — ' + (res.total || SIM_GAMES) + ' Partien auf ' + pool.length + ' Threads.';
    var d = res.depth ? ' (Tiefe ' + res.depth + ')' : '';
    if (SOURCE === 'lichess-live') return 'Geladen — Lichess Cloud-Eval' + d + '.';
    return 'Geladen — Lichess Cloud-Eval, gebündelte Datei' + d + '.';
  }
  function explainText(res) {
    if (SOURCE === 'mc-live') {
      return 'Live-<strong>Monte-Carlo</strong>: aus dieser Stellung wurden <strong>' + (res.total || SIM_GAMES) +
        '</strong> zufällige Partien (nach 64 Halbzügen gekappt, dann Materialurteil) auf <strong>' + pool.length +
        '</strong> Threads gespielt. Die Häufigkeiten sind die Wahrscheinlichkeiten.';
    }
    var d = res.depth ? 'Tiefe <strong>' + res.depth + '</strong>' : 'gecachte Bewertung';
    return 'Quelle <strong>Lichess Cloud-Eval</strong> (Stockfish, ' +
      (SOURCE === 'lichess-file' ? 'gebündelte Datei' : 'live von lichess.org') +
      '): die Engine-Bewertung (' + d + ') wird in <strong>Gewinnchancen</strong> umgerechnet. ' +
      'Die Heatmap zeigt die Top-Züge der Engine.';
  }
  function heatmapStateText(human) {
    if (game.game_over()) return '—';
    if (!human) return 'Bot am Zug — Heatmap pausiert.';
    if (!heatmapReady) return 'Keine Zugdaten für diese Stellung (' + SOURCE_LABEL[SOURCE] + ').';
    return 'Heatmap bereit — Figur anfassen oder „Gesamte Heatmap".';
  }

  function refreshPosition() {
    var fen = game.fen(), myGen = gen, ply = game.history().length, whiteToMove = game.turn() === 'w';
    var human = isHuman(game.turn());
    var wantMoves = !(SOURCE === 'mc-live' && !human); // skip the costly live heatmap on bot turns
    setStatus('');
    setProgress(loadingLabel());

    getPosition(fen, { wantMoves: wantMoves }).then(function (res) {
      if (gen !== myGen) return;
      if (!res || !res.ok || !res.sim) { handleNoData(res, ply); renderTree(); return; }

      updateProbabilityUI(res.sim.pWhite, res.sim.pDraw, res.sim.pBlack);
      probHistory[ply] = res.sim.pWhite;

      heatmapList = (res.moves || []).map(function (m) {
        return { from: m.from, to: m.to, san: m.san, pWhite: m.pWhite, pDraw: m.pDraw, pBlack: m.pBlack,
                 pSide: whiteToMove ? m.pWhite : m.pBlack };
      });
      heatmapByFrom = {};
      heatmapList.forEach(function (e) { (heatmapByFrom[e.from] = heatmapByFrom[e.from] || []).push(e); });
      candidateSnapshots[ply] = heatmapList.length
        ? heatmapList.map(function (e) { return { san: e.san, pSide: e.pSide }; }) : undefined;

      heatmapReady = human && !game.game_over() && heatmapList.length > 0;
      setHeatmapState(heatmapStateText(human));
      setProgress(doneLabel(res));
      setExplain(explainText(res));
      renderTree();
      refreshOverlay();
    }).catch(function (err) { if (gen === myGen) showError(err); });
  }

  function handleNoData(res, ply) {
    setProbUnknown();
    heatmapList = []; heatmapByFrom = {}; heatmapReady = false;
    candidateSnapshots[ply] = undefined;
    clearOverlay();
    var reason = res && res.reason;
    if (reason === 'unavailable') {
      setProgress((res.message || 'Quelle nicht erreichbar') + ' — andere Datenquelle wählen.');
    } else {
      setProgress('Keine vorab berechneten Daten für diese Stellung (' + SOURCE_LABEL[SOURCE] + '). Tipp: Monte-Carlo · live wählen.');
    }
    setExplain('Diese Stellung liegt außerhalb der gewählten Quelle. Mit <strong>Monte-Carlo · live</strong> ' +
      'lässt sich jede Stellung simulieren; die Lichess-Quellen decken vor allem Eröffnung und frühes Mittelspiel ab.');
    setHeatmapState('—');
  }

  function onPositionChanged() {
    gen++;                  // soft-cancel any in-flight work
    var myGen = gen;
    clearOverlay();
    heatmapList = []; heatmapByFrom = {}; heatmapReady = false;

    updateTurnPill();
    renderTree();
    renderGameInfo();

    if (handleGameOver()) { renderTree(); return; }

    refreshPosition();

    if (!isHuman(game.turn())) {
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

  // Re-evaluate the current position without touching the game / bot loop.
  function reevaluate() {
    gen++;
    clearOverlay();
    heatmapList = []; heatmapByFrom = {}; heatmapReady = false;
    renderTree();
    if (handleGameOver()) { renderTree(); return; }
    refreshPosition();
  }

  /* ======================================================================
     BOARD EVENTS
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
     CONTROLS
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
  function onModeChange() { MODE = $['mode-select'].value; newGame(); }
  function onSourceChange() {
    SOURCE = $['source-select'].value;
    if (SOURCE === 'mc-live') ensurePool(); else teardownPool();
    reevaluate();
  }

  /* ======================================================================
     BOOTSTRAP
     ====================================================================== */
  function init() {
    try {
      cacheDom();
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
      $['source-select'].addEventListener('change', onSourceChange);
      $['source-select'].value = SOURCE;

      if (SOURCE === 'mc-live') ensurePool();

      window.addEventListener('resize', function () { board.resize(); refreshOverlay(); });

      onPositionChanged();
    } catch (e) { showError(e); }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
