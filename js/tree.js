/* ============================================================================
   tree.js — zoomable / pannable decision-tree canvas (top-to-bottom)
   ----------------------------------------------------------------------------
   Renders the game as a decision tree growing DOWNWARDS:
     • the played line runs straight down the middle (bright "chosen" path),
     • every non-chosen legal move branches off and is greyed out,
     • the current position's candidate moves (live heatmap) fan out at the
       bottom tip, coloured green→red by win-probability for the side to move.

   Mouse wheel = zoom (around the cursor), drag = pan.

   API:
     var tv = new TreeView(canvasEl);
     tv.setData(levels, currentPly);
     tv.resetView();

   `levels`: one entry per position (ply 0..N):
     { ply, pWhite, moves:[ { san, chosen:Boolean, pSide:Number|undefined } ] }
   For the last (current) level no move is `chosen` — those are candidates.

   MIT License.
   ========================================================================== */

(function () {
  'use strict';

  // World-space layout (before zoom). Vertical tree: depth = Y, fan = X.
  var ROW_GAP = 74;    // vertical distance between plies
  var H_SLOT  = 74;    // horizontal spacing between sibling moves
  var NODE_W  = 60;    // move-node width
  var NODE_H  = 24;    // move-node height
  var MAX_FAN = 14;    // max non-chosen siblings drawn per node

  function probToColor(p, alpha) {
    return 'hsla(' + (p * 120).toFixed(0) + ', 70%, 50%, ' + (alpha == null ? 1 : alpha) + ')';
  }

  function TreeView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.levels = [];
    this.currentPly = 0;
    this.lastPlyCount = -1;

    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;

    this._bind();
    this.resize();
  }

  TreeView.prototype._bind = function () {
    var self = this;

    this.canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = self.canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      var newScale = Math.max(0.2, Math.min(4, self.scale * factor));
      var wx = (mx - self.offsetX) / self.scale;
      var wy = (my - self.offsetY) / self.scale;
      self.scale = newScale;
      self.offsetX = mx - wx * newScale;
      self.offsetY = my - wy * newScale;
      self.draw();
    }, { passive: false });

    this.canvas.addEventListener('mousedown', function (e) {
      self._dragging = true; self._lastX = e.clientX; self._lastY = e.clientY;
      self.canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      if (!self._dragging) return;
      self.offsetX += e.clientX - self._lastX;
      self.offsetY += e.clientY - self._lastY;
      self._lastX = e.clientX; self._lastY = e.clientY;
      self.draw();
    });
    window.addEventListener('mouseup', function () {
      self._dragging = false; self.canvas.style.cursor = 'grab';
    });

    window.addEventListener('resize', function () { self.resize(); });
  };

  TreeView.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    var cssW = this.canvas.clientWidth || 600;
    var cssH = this.canvas.clientHeight || 380;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this.draw();
  };

  TreeView.prototype.setData = function (levels, currentPly) {
    this.levels = levels || [];
    this.currentPly = currentPly || 0;
    // Re-center only when a move was actually played (ply count changed).
    if (levels.length !== this.lastPlyCount) {
      this.lastPlyCount = levels.length;
      this.resetView();
    } else {
      this.draw();
    }
  };

  TreeView.prototype.resetView = function () {
    this.scale = 1;
    // Spine is at world x=0 → keep it horizontally centered. Put the current
    // position ~40% down so the candidate fan below stays visible.
    this.offsetX = this.cssW * 0.5;
    this.offsetY = this.cssH * 0.40 - this.currentPly * ROW_GAP * this.scale;
    this.draw();
  };

  // World -> screen
  TreeView.prototype._sx = function (wx) { return wx * this.scale + this.offsetX; };
  TreeView.prototype._sy = function (wy) { return wy * this.scale + this.offsetY; };

  TreeView.prototype.draw = function () {
    var ctx = this.ctx, s = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = '#15171e';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    if (!this.levels.length) {
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '13px Segoe UI, sans-serif';
      ctx.fillText('Noch keine Züge.', 16, 24);
      return;
    }

    // Start node (top, centered)
    this._dot(0, 0, this.currentPly === 0);
    ctx.fillStyle = '#cfd5e2';
    ctx.font = (12 * s).toFixed(1) + 'px Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Start', this._sx(0) + 12 * s, this._sy(0));

    for (var k = 0; k < this.levels.length; k++) {
      var lvl = this.levels[k];
      var parentY = k * ROW_GAP;          // depth of position k
      var childRowY = (k + 1) * ROW_GAP;  // depth of the resulting moves

      var chosen = null, others = [];
      for (var i = 0; i < lvl.moves.length; i++) {
        if (lvl.moves[i].chosen) chosen = lvl.moves[i];
        else others.push(lvl.moves[i]);
      }
      others.sort(function (a, b) { return (b.pSide || 0) - (a.pSide || 0); });
      var truncated = others.length > MAX_FAN;
      if (truncated) others = others.slice(0, MAX_FAN);

      // Horizontal slots: chosen at center x=0, others alternate left/right.
      var placed = [];
      if (chosen) placed.push({ m: chosen, x: 0 });
      for (var j = 0; j < others.length; j++) {
        var sign = (j % 2 === 0) ? -1 : 1;
        var step = chosen ? (Math.floor(j / 2) + 1) : Math.floor((j + 1) / 2);
        placed.push({ m: others[j], x: sign * step * H_SLOT });
      }

      // Edges first, then nodes on top.
      for (var p = 0; p < placed.length; p++) {
        this._edge(0, parentY, placed[p].x, childRowY, placed[p].m.chosen);
      }
      for (var q = 0; q < placed.length; q++) {
        this._moveNode(placed[q].x, childRowY, placed[q].m, (k + 1) === this.currentPly);
      }

      if (truncated) {
        ctx.fillStyle = '#6b7280';
        ctx.font = (10 * s).toFixed(1) + 'px Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('+ weitere', this._sx((MAX_FAN / 2 + 1) * H_SLOT), this._sy(childRowY));
        ctx.textAlign = 'left';
      }
    }
  };

  TreeView.prototype._dot = function (wx, wy, current) {
    var ctx = this.ctx, r = (current ? 7 : 5) * this.scale;
    ctx.beginPath();
    ctx.arc(this._sx(wx), this._sy(wy), r, 0, Math.PI * 2);
    ctx.fillStyle = current ? '#5b8cff' : '#4a5266';
    ctx.fill();
    if (current) {
      ctx.lineWidth = 2 * this.scale;
      ctx.strokeStyle = 'rgba(91,140,255,0.4)';
      ctx.beginPath();
      ctx.arc(this._sx(wx), this._sy(wy), r + 4 * this.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  // Vertical bezier edge from the bottom of the parent to the top of the child.
  TreeView.prototype._edge = function (x1, y1, x2, y2, chosen) {
    var ctx = this.ctx;
    var sx1 = this._sx(x1), sy1 = this._sy(y1) + (NODE_H / 2) * this.scale;
    var sx2 = this._sx(x2), sy2 = this._sy(y2) - (NODE_H / 2) * this.scale;
    var midY = (sy1 + sy2) / 2;
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.bezierCurveTo(sx1, midY, sx2, midY, sx2, sy2);
    ctx.lineWidth = (chosen ? 2.4 : 1) * this.scale;
    ctx.strokeStyle = chosen ? 'rgba(91,140,255,0.9)' : 'rgba(120,130,150,0.28)';
    ctx.stroke();
  };

  TreeView.prototype._moveNode = function (wx, wy, m, isCurrentTip) {
    var ctx = this.ctx, s = this.scale;
    var w = NODE_W * s, h = NODE_H * s;
    var x = this._sx(wx) - w / 2, y = this._sy(wy) - h / 2;

    var hasProb = (typeof m.pSide === 'number');
    var fill = m.chosen ? '#2a3350' : (hasProb ? probToColor(m.pSide, 0.9) : '#262b36');
    var alpha = m.chosen ? 1 : (hasProb ? 0.95 : 0.5);

    ctx.globalAlpha = alpha;
    this._roundRect(x, y, w, h, 5 * s);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = (m.chosen ? 2 : 1) * s;
    ctx.strokeStyle = m.chosen ? '#5b8cff'
      : (isCurrentTip ? 'rgba(255,255,255,0.55)' : 'rgba(120,130,150,0.4)');
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = m.chosen ? '#eaf0ff' : (hasProb ? '#0b0d12' : '#aeb6c6');
    ctx.font = (m.chosen ? '700 ' : '600 ') + (11 * s).toFixed(1) + 'px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var label = m.san + (hasProb ? '  ' + (m.pSide * 100).toFixed(0) + '%' : '');
    ctx.fillText(label, this._sx(wx), this._sy(wy));
    ctx.textAlign = 'left';
  };

  TreeView.prototype._roundRect = function (x, y, w, h, r) {
    var ctx = this.ctx;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  window.TreeView = TreeView;
})();
