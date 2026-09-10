# Tripo Mesh Utility

> ### ⚠️  Unofficial — not a Tripo product
>
> This is an **independent, community-built** browser extension. It is **not**
> made by, affiliated with, endorsed by, or supported by **Tripo AI**, and it
> is not an official Tripo product in any form.
>
> The name "Tripo" appears here only to say which website the extension works
> on. All Tripo trademarks belong to their owner.
>
> **Please do not report problems with this extension to Tripo.** They did not
> write it and cannot help with it. Open an issue in this repository instead.

A browser extension that checks Tripo-generated meshes for defects while they load, so you find out whether a generation is worth keeping before you spend time on it.

When a mesh arrives it is analysed in place, and a chip in the corner shows the call — **Clean**, **Minor defects**, **Re-roll** or **Inside out**. Nothing is uploaded anywhere, and nothing has to be downloaded to be checked.

Chromium and Firefox, Manifest V3.

## Features

**Automatic checking.** Meshes are picked up as the page loads them. You can also drag a file onto the panel.

**A verdict, not just numbers.** Every finding is measured against the size of the mesh: two non-manifold edges out of 2.9 million are a rounding error, two out of eighteen are a broken cube. The thresholds are editable under *Preferences* in the panel — a background prop and a hero asset don't deserve the same bar.

**What it measures**

- *Surface* — holes, each with the size of its boundary loop; inverted triangles; non-manifold edges
- *Geometry* — connected pieces and stray fragments, sliver triangles, duplicate faces, zero-area triangles, orphaned vertices
- *Texturing* — UVs per part, how much of the atlas is used, overlap that would break a bake, texture count and resolution
- *Scale* — bounding box, pivot offset, whether the model rests on the ground

**Only the holes you can see.** A three-edge hole is a defect in the file but not one anybody notices. Holes below a threshold — six boundary edges by default — are reported separately instead of inflating the count, and the **All holes** toggle shows them anyway in a dimmed tone.

**A viewport that shows the defects.** Front faces render grey, back faces red, open edges cyan with depth testing off, so a hole on the far side registers without orbiting to it. Left-drag orbits, right-drag pans, the wheel zooms toward the cursor, a double-click restores the framing, and a turntable can be switched on.

**Repair.** *Download repaired .glb* fixes winding by permuting the index buffer and nothing else — materials, UVs, textures and skins survive untouched. Meshopt-compressed files come back out uncompressed. Holes are reported, never filled: filling one means inventing geometry, which is a modelling decision rather than a repair.

**Formats.** GLB including meshopt-compressed, binary FBX, OBJ and STL. The format is decided by the file header rather than by the extension, because Tripo does not always name a file after what is inside it.

## Install

No build step and no dependencies — the files in the folder are what the browser loads.

**Chrome, Edge, Brave, Opera, Vivaldi**

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked**, and select this folder

**Firefox 121+**

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on**, and select `manifest.json`
3. **Then open the puzzle-piece icon in the toolbar and set "Always allow on tripo3d.ai".**

Step 3 is not optional. In Firefox, MV3 host permissions stay optional even when the manifest declares them, and loading through `about:debugging` never asks. Without it the extension stays silent and nothing points at the reason.

Temporary add-ons are cleared on restart. For a permanent install, sign the package through [addons.mozilla.org](https://addons.mozilla.org/developers/) — self-distribution signing is free and does not require a public listing.

**Packaging it yourself**

```
node build.js
```

Writes a `.zip` into `dist/` with `manifest.json` at the archive root, which is the layout both stores require. One package serves both browsers.

## Disclaimer

This project is not affiliated with Tripo AI in any way. It reads files that
your own browser has already downloaded and analyses them locally; it does not
use any Tripo API, and it uploads nothing anywhere.

Because it attaches to a website it does not control, a redesign on Tripo's
side can stop parts of it from working. The software is provided as is, without
warranty of any kind — see `LICENSE`.
