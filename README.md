# Vektor Flow — `vf-ui` (host shell)

Browser-side **floating frame** chrome: **`vf-frame.js`** / **`vf-frame.css`** (`VfFrame.mount`, drag header, minimize, resize, close, **`expandToFitContent`**). Python scene types: **`vektorflow/ui/ir.py`**.

## Run the GUI (Windows)

**Shell:** **`vf-overlay.exe`** under **`native/VfOverlay/build/...`** — WebView2 + **DirectComposition** (typical WebView2 overlay). Build: **`.\scripts\build-vf-overlay.ps1`**, then **`.\scripts\run-vf-ui.ps1`**. See **`native/VfOverlay/README.md`**.

`vkf` / first **`add_frame`** can auto-start **`vf-overlay.exe`** if it is built (`vektorflow.ui.launch`).

Serves from **`http://127.0.0.1:<port>/`** → **`index.html`** (redirects to scene / demos as configured).

## Browser (quick file edit loop)

```bash
python -m http.server 8877 --directory web/vf-ui
```

- **`example-gui.html`** — form demo (**expandToFitContent**, **Log form**).
- **`demo.html`** — minimal panel.
