# Schach-Wahrscheinlichkeiten — Monte-Carlo-Simulation

An interactive chess **probability visualizer**. Play both sides (hot-seat) on a
drag-and-drop board while win/draw/loss probabilities for the current position
update live. Pick up a piece to see a soft, glowing **win-probability heatmap**
of its moves, watch the **decision tree** grow, and see the whole game encoded
as a hash with an entropy-based **time-to-crack**.

## Three switchable data sources

The probabilities + heatmap can come from any of three sources (pick one with
the **Datenquelle** selector in the app):

| Source | What it is | Speed / coverage |
| --- | --- | --- |
| **Lichess · Cloud-Eval (live)** *(default)* | Cached Stockfish evaluation fetched from [`lichess.org/api/cloud-eval`](https://lichess.org/api#tag/Analysis), converted into win chances + a top-moves heatmap. | Instant · openings & main lines · needs `lichess.org` |
| **Lichess · Cloud-Eval (file)** | The same data, pre-downloaded into `data/lichess-tree.json` by `tools/fetch-lichess-tree.js`. | Instant · offline · limited to the downloaded tree |
| **Monte-Carlo · live** | Our own stochastic simulation: thousands of truncated random playouts in a **Web Worker pool**. | Real simulation · slower · works for *any* position |

> **Why cloud-eval and not the opening explorer?** The Lichess opening explorer
> lives on a *separate* host (`explorer.lichess.ovh`) that many networks block.
> The cloud-eval endpoint is on `lichess.org` itself, so it works where the
> explorer doesn't. It only has positions that are in Stockfish's cloud cache
> (deep opening theory and popular lines); off-book positions return "no data" —
> switch to **Monte-Carlo · live**, which can evaluate anything.

The two Lichess sources are precomputed (no live math), which is why they are
instant; Monte-Carlo is genuinely simulated on the fly across your CPU cores.

## Quick start (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/Tom-A-Rom/StochaHackathonSS26/main/install.sh | bash
```

This clones the repo and starts a local server, opening the app in your browser.

> Prefer to read before you pipe to bash? Open
> [`install.sh`](install.sh) first — it only clones the repo and runs
> [`serve.sh`](serve.sh).

## Run it yourself (already cloned)

```bash
git clone https://github.com/Tom-A-Rom/StochaHackathonSS26.git
cd StochaHackathonSS26
./serve.sh              # then open http://localhost:8000
# or choose a port:  PORT=9000 ./serve.sh
```

`serve.sh` auto-detects `python3`, `python`, `node`/`npx http-server`, or `php`.

> **A local server is required** — the app uses a Web Worker and the Web Crypto
> API (SHA-256), which browsers only allow over an `http://localhost` origin.
> Opening `index.html` directly via `file://` will not work.

## Requirements

- `git`
- One of: `python3`, `python`, Node.js (`npx`), or `php`
- A modern browser (Chrome/Firefox) and internet access on first load
  (libraries are fetched from a CDN).

## Generating the offline data files

The Lichess **file** source needs a one-time download from `lichess.org`:

```bash
node tools/fetch-lichess-tree.js                 # DEPTH=8 TOPK=4
DEPTH=10 TOPK=5 node tools/fetch-lichess-tree.js # deeper / wider tree
```

This writes `data/lichess-tree.json` (cloud-eval has at most 5 lines, so TOPK is
clamped to 5). Until it exists, the **Lichess · file** option reports "no data" —
the other two sources work without it.

Monte-Carlo is **not** precomputed: it runs live in `js/sim-worker.js`.

## How it works

| Concept | What you see |
| --- | --- |
| **Win/draw/loss bar** | Probabilities for the current position from the selected data source (top right). |
| **Move heatmap** | Pick up a piece → each destination gets a soft, glowing green→red disc with the win-% for the side to move; the strongest move pulses. |
| **Decision tree** | The played move path (top→bottom) plus candidate next moves with their probabilities; alternatives greyed out. |
| **Game as a hash** | PGN/FEN of the game, its **sequence probability** (∏ 1/legal-moves per ply), the equivalent **entropy in bits**, a real **SHA-256**, and an estimated **time to crack** at that entropy. |

A rarer line has more branching → more entropy bits → would take longer to
brute-force. That link between **probability and crackability** is the point.

## Project layout

```
index.html                   # markup
css/style.css                # dark theme + glowing heatmap
js/app.js                    # UI, hot-seat flow, data-source switch, heatmap, tree, hash
js/tree.js                   # zoom/pan decision-tree canvas (top→bottom)
js/sim-worker.js             # live Monte Carlo engine (Web Worker)
tools/fetch-lichess-tree.js  # build data/lichess-tree.json from the Lichess explorer
tools/chess.js               # chess.js, vendored for the Node tools
data/lichess-tree.json       # generated bundled Lichess data (not committed by default)
serve.sh                     # local server launcher
install.sh                   # curl | bash one-line installer
```

## Libraries (open-source, via CDN)

- [chessboard.js](https://github.com/oakmac/chessboardjs) v1.0.0 (+ jQuery, its dependency)
- [chess.js](https://github.com/jhlywa/chess.js) v0.10.2

## License

MIT.
