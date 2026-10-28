# PaintYCompanion

A clean touch & pen painting app for Android tablets and phones. Paint over a map of Panaji.
Plain HTML/CSS/JS with no build step and no dependencies.

## Run it from GitHub Pages
1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open `https://<you>.github.io/<repo>/` on the tablet.
4. Chrome menu → **Add to Home screen** and it opens full screen like an app.

Local test: `python -m http.server` in this folder, then open `http://localhost:8000`.

## The map
The built-in background is `assets/panjim-outline.svg`, the outline of the City of Panaji.
To change it, overwrite that file, or put another image in `assets/` and type its path under
Settings → Background → **Image file**.
- **One device only:** Settings → Background → **Upload** stores the image on that device.

The canvas fills the screen in portrait and landscape; the map is scaled as large as fits, and a painting survives rotation. Black-on-white outline maps work best with
**Keep outlines on top of paint** turned on: the lines stay visible over the colour, like a colouring book.

## Settings (gear, top-right)
Background, map opacity, map rotation and size, palette position (bottom / top / left / right), colours (name + hex, add/remove),
brush size, pen pressure, pen-only mode (fingers ignored on the canvas), save painting as PNG, full screen.
Settings are saved per device.

## Files
- `index.html`: markup
- `style.css`: styles
- `app.js`: painting, undo/redo (30 steps), settings
- `assets/panjim-outline.svg`: outline of the City of Panaji boundary; coastline from OpenStreetMap (© OpenStreetMap contributors, ODbL)
