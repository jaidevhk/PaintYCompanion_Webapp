# PaintYCompanion

A clean touch & pen painting app for Android tablets and phones. Paint over a map of Panaji.
Plain HTML/CSS/JS with no build step and no dependencies.

## Run it from GitHub Pages
1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open `https://<you>.github.io/<repo>/` on the tablet.
4. Chrome menu → **Add to Home screen** and it opens full screen like an app.

Local test: `python -m http.server` in this folder, then open `http://localhost:8000`.

## Using your own Panaji outline map
- **Easiest for many devices:** put the image in `assets/` (e.g. `assets/panaji-outline.png`), push, then
  Settings → Background → **Image file** → type `assets/panaji-outline.png`.
- Or overwrite `assets/panjim-outline.svg` with your own map. It is the built-in default.
- **One device only:** Settings → Background → **Upload** stores the image on that device.

The board takes the shape of the map image. Black-on-white outline maps work best with
**Keep outlines on top of paint** turned on: the lines stay visible over the colour, like a colouring book.

## Settings (gear, top-right)
Background, map opacity, palette position (bottom / top / left / right), colours (name + hex, add/remove),
brush size, pen pressure, pen-only mode (fingers ignored on the canvas), save painting as PNG, full screen.
Settings are saved per device.

## Files
- `index.html`: markup
- `style.css`: styles
- `app.js`: painting, undo/redo (30 steps), settings
- `assets/panjim-outline.svg`: outline of the City of Panaji boundary; coastline from OpenStreetMap (© OpenStreetMap contributors, ODbL)
