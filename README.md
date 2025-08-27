# demo-compositor-cli

Script a web flow with Playwright, then replay it in a Three.js isometric sky scene to output:

- `raw.webm` direct capture
- `composed.webm` cinematic push-in with sky + grid
- `cover.png` first-half-second frame for thumbnail usage

## Quick Start

```bash
npm i
npx playwright install chromium
npx tsx src/index.ts --flow flows/example.yml --out out --width 1920 --height 1080 --theme sky --title "Your Product" --subtitle "Cinematic UI teaser"
```

Artifacts appear in `out/`.

## Flow YAML schema

```yaml
name: My Flow
viewport:
  width: 1280
  height: 720
steps:
  - action: goto
    url: https://example.com
  - action: click
    selector: 'a.more'
  - action: type
    selector: 'input[name="q"]'
    text: 'search query'
    delay: 40
  - action: wait
    selector: '#results'
  - action: scroll
    y: 1200
    smooth: true
  - action: broll
    duration: 4000
```

Supported actions: `goto`, `click`, `type`, `wait (ms|selector)`, `scroll (y|selector)`, `sleep`, `broll`.

Action nuances / tips:

- goto: Always first; waits for DOMContentLoaded.
- wait: Use `selector:` to wait for visibility or `ms:` for a fixed delay. Prefer selector waits where possible.
- click: Cursor animates to center of element, highlight + ripple effect, then performs the click.
- type: Clears the field, then types char-by-char (each emits a minor flow event) with configurable delay.
- scroll: Either smooth to an absolute `y` or scroll an element into view via `selector`. `smooth: true` enables eased animation.
- sleep: Pure timing gap (no element association) useful for framing / breathing room.
- broll: Passive capture period; camera compositor can add motion while UI stays still.

Optional steps: add `optional: true` inside any step to allow the flow to continue if that step's selector / action fails (useful for brittle selectors or variant layouts).

For longer demos chain short scroll + brief broll + interaction clusters (type / click) to create rhythm.

## Speed multiplier

Use `--speed 1` (default). Values >1 accelerate timings (less wait / type delay). Values <1 slow everything.

## Interactive example
See `flows/interactive-wikipedia.yml` for a richer scripted path: landing, search, article load, multi-stage scrolls, mid‑page hold, refinement typing, and hero b‑roll. This showcases pacing patterns (sleep → scroll → broll) and cursor choreography.
## Notes

- Duration estimation currently naive; composed video stops when raw video ends.
- If you need audio, remove `video.muted = true` and ensure user gesture simulation.
- For higher quality, post-process `raw.webm` in ffmpeg and then re-run compositor pointing to processed file.

## License

MIT
