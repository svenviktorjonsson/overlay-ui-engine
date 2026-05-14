# overlay-ui-engine

Language-neutral browser/WASM/WebGPU UI engine for overlay-hosted Vektor Flow
programs and other future language adapters.

Browser-side **floating frame** chrome: **`vf-frame.js`** / **`vf-frame.css`** (`VfFrame.mount`, drag header, minimize, resize, close, **`expandToFitContent`**). VKF scene types currently live in `vektor-flow`.

## Run the GUI (Windows)

**Shell:** **`vf-overlay.exe`** from `transparent-overlay` — WebView2 +
**DirectComposition**. In `vektor-flow`, build it with
**`.\scripts\build-vf-overlay.ps1`**, then run **`.\scripts\run-vf-ui.ps1`**.

`vkf` / first **`add_frame`** can auto-start **`vf-overlay.exe`** if it is built (`vektorflow.ui.launch`).

Serves from **`http://127.0.0.1:<port>/`** → **`index.html`** (redirects to scene / demos as configured).

## Browser (quick file edit loop)

```bash
python -m http.server 8877 --directory web/vf-ui
```

- **`example-gui.html`** — form demo (**expandToFitContent**, **Log form**).
- **`demo.html`** — minimal panel.
