# IG Feed Watcher — Presentation

Self-contained HTML report/presentation about the **IG Feed Watcher** project, with three
interactive Archify workflow graphics embedded.

## Open it

- `index.html` — the presentation deck (13 slides). Open directly in a browser or serve it:
  ```bash
  cd /home/bsdev/ig-feed-watcher/presentation
  python3 -m http.server 8091        # → http://localhost:8091
  ```
  Navigation: arrow keys / PageUp-PageDown / the dots at the bottom / touch swipe.

## Contents

| File | What it is |
|---|---|
| `index.html` | The deck: what the system does, architecture, watcher run, interest groups + Telegram routing, posting API, data model, explorer, **real system screenshots**, deployment, live stats, risks, file map |
| `assets/` | Real screenshots from the live system (2× Web Explorer, 1× Telegram) — embedded on the “Real system screenshots” slide, click to open full size |
| `diagrams/architecture.html` | Interactive architecture diagram (components, boundaries, guided views, trace animation) |
| `diagrams/watcher-workflow.html` | Lane-based workflow of one 5-minute watcher run (main path + rate-limit exception lane) |
| `diagrams/posting-sequence.html` | Sequence diagram of `POST /post` → Instagram create-post automation |
| `specs/*.json` | The Archify specifications that generate each diagram |
| `*.visual-check.*` | Automated containment evidence (PNG screenshots, contact sheets, receipts) |

Every diagram is a standalone explorable page too — pan/zoom, light/dark theme, guided
views, search, relationship tracing, and export. They were generated with the
[Archify](https://github.com/tt-a1i/archify) pipeline at `showcase` quality
(9/9 composition checks, 0 errors, 0 warnings for each).
