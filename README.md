# Schach-Wahrscheinlichkeiten — Monte-Carlo-Simulation

An interactive chess **probability visualizer**. Play both sides (hot-seat) on a
drag-and-drop board while a **Monte Carlo simulation** estimates live
win/draw/loss probabilities for the current position. Pick up a piece to see a
**win-probability heatmap** of its moves, watch the **decision tree** grow, and
see the whole game encoded as a hash with an entropy-based **time-to-crack**.

All simulation runs in a **Web Worker**, so the board stays perfectly smooth.

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

## How it works

| Concept | What you see |
| --- | --- |
| **Monte Carlo** | N=1000 random playouts from the current position → win/draw/loss bar (top right). |
| **Move heatmap** | Pick up a piece → each destination gets a green→red circle with the win-% for the side to move (200 playouts per move). |
| **Decision tree** | The played move path plus the top candidate next moves with their probabilities. |
| **Game as a hash** | PGN/FEN of the game, its **sequence probability** (∏ 1/legal-moves per ply), the equivalent **entropy in bits**, a real **SHA-256**, and an estimated **time to crack** at that entropy. |

A rarer line has more branching → more entropy bits → would take longer to
brute-force. That link between **probability and crackability** is the point.

## Project layout

```
index.html        # markup
css/style.css     # dark theme
js/app.js         # UI, hot-seat flow, heatmap, decision tree, hash tile
js/sim-worker.js  # Monte Carlo engine (Web Worker)
serve.sh          # local server launcher
install.sh        # curl | bash one-line installer
```

## Libraries (open-source, via CDN)

- [chessboard.js](https://github.com/oakmac/chessboardjs) v1.0.0 (+ jQuery, its dependency)
- [chess.js](https://github.com/jhlywa/chess.js) v0.10.2

## License

MIT.
