#!/usr/bin/env node
/* ============================================================================
   fetch-lichess-tree.js — build data/lichess-tree.json from the Lichess
   cloud-evaluation API (Stockfish, cached) on lichess.org.
   ----------------------------------------------------------------------------
   NOTE: this uses https://lichess.org/api/cloud-eval — NOT explorer.lichess.ovh
   (that is a separate host which is blocked on many networks). cloud-eval lives
   on lichess.org itself and returns a cached engine evaluation + top lines,
   which we convert to a white/draw/black split and a per-move heatmap (same
   schema as the app's live source, so the site loads either interchangeably).

   Walks the top engine moves to a given ply DEPTH (only following moves the
   engine actually returns, capped at TOPK per position). Cloud-eval has at most
   5 lines, so TOPK is clamped to 5. Positions not in the cloud cache are
   skipped.

   Usage:
     node tools/fetch-lichess-tree.js                 # DEPTH=8 TOPK=4
     DEPTH=10 TOPK=5 node tools/fetch-lichess-tree.js

   MIT License.
   ========================================================================== */
'use strict';
var path = require('path');
var fs = require('fs');
var https = require('https');

var mod = require(path.join(__dirname, 'chess.js'));
var Chess = mod.Chess || mod;

var DEPTH    = parseInt(process.env.DEPTH || '8', 10);
var TOPK     = Math.min(5, parseInt(process.env.TOPK || '4', 10));
var DELAY_MS = parseInt(process.env.DELAY || '600', 10);   // be gentle: cloud-eval rate-limits (429)
var OUT      = path.join(__dirname, '..', 'data', 'lichess-tree.json');

function posKey(fen) { return fen.split(' ').slice(0, 4).join(' '); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function round(x) { return Math.round(x * 1000) / 1000; }

function evalToWhiteScore(pv) {
  if (typeof pv.mate === 'number') return pv.mate > 0 ? 0.995 : 0.005;
  return 1 / (1 + Math.exp(-0.00368208 * (pv.cp || 0)));
}
function scoreToWDL(E) {
  var adv = Math.abs(2 * E - 1);
  var d = 0.45 * Math.pow(1 - adv, 1.3);
  var w = Math.max(0, E - d / 2), b = Math.max(0, (1 - E) - d / 2);
  var t = w + b + d || 1;
  return { pWhite: round(w / t), pDraw: round(d / t), pBlack: round(b / t) };
}

function cloudEvalOnce(fen) {
  var url = 'https://lichess.org/api/cloud-eval?multiPv=5&fen=' + encodeURIComponent(fen);
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'stocha-hackathon-precompute' } }, function (res) {
      if (res.statusCode === 404) { res.resume(); return resolve(null); }       // not cached
      if (res.statusCode === 429) { res.resume(); var e = new Error('HTTP 429'); e.rateLimited = true; return reject(e); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      var buf = '';
      res.on('data', function (d) { buf += d; });
      res.on('end', function () { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
// Retry on 429 with exponential backoff so a deep run survives rate-limiting.
async function cloudEval(fen) {
  for (var attempt = 0; ; attempt++) {
    try { return await cloudEvalOnce(fen); }
    catch (e) {
      if (e.rateLimited && attempt < 5) {
        var wait = 5000 * Math.pow(2, attempt);   // 5s, 10s, 20s, 40s, 80s
        process.stdout.write('\n  rate-limited (429), warte ' + (wait / 1000) + 's …');
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

var positions = {};
var visited = {};
var count = 0;

async function walk(fen, depth) {
  var key = posKey(fen);
  if (visited[key]) return;
  visited[key] = true;

  var j;
  try { j = await cloudEval(fen); }
  catch (e) { console.error('\n  skip', key, '-', e.message); return; }
  await sleep(DELAY_MS);
  if (!j || !j.pvs || !j.pvs.length) return;   // not in the cloud cache

  var g = new Chess(fen);
  var moves = j.pvs.map(function (pv) {
    var uci = (pv.moves || '').split(' ')[0] || '';
    var from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci.slice(4) || undefined;
    var wdl = scoreToWDL(evalToWhiteScore(pv));
    var san = uci, childFen = null;
    try { var mv = g.move({ from: from, to: to, promotion: promo }); if (mv) { san = mv.san; childFen = g.fen(); g.undo(); } } catch (e) {}
    return { san: san, uci: uci, from: from, to: to,
             pWhite: wdl.pWhite, pDraw: wdl.pDraw, pBlack: wdl.pBlack, childFen: childFen };
  });

  positions[key] = {
    sim: scoreToWDL(evalToWhiteScore(j.pvs[0])),
    depth: j.depth,
    moves: moves.map(function (m) {
      return { san: m.san, uci: m.uci, from: m.from, to: m.to, pWhite: m.pWhite, pDraw: m.pDraw, pBlack: m.pBlack };
    })
  };
  count++;
  process.stdout.write('\r[lichess] positions=' + count + '  depth<=' + depth + '   ');

  if (depth >= DEPTH) return;
  var follow = moves.slice(0, TOPK);
  for (var i = 0; i < follow.length; i++) {
    if (follow[i].childFen) await walk(follow[i].childFen, depth + 1);
  }
}

(async function () {
  console.log('[lichess] cloud-eval  DEPTH=%d TOPK=%d', DEPTH, TOPK);
  var started = Date.now();
  await walk(new Chess().fen(), 0);
  var out = { meta: { source: 'lichess-cloud-eval', depth: DEPTH, topK: TOPK,
                      generated: new Date().toISOString() }, positions: positions };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  var kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log('\n[lichess] wrote %s  (%d positions, %s KB, %ss)',
    path.relative(process.cwd(), OUT), count, kb, ((Date.now() - started) / 1000).toFixed(0));
})();
