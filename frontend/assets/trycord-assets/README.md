# Trycord brand assets

The source of truth for the interface: the mark and its lockups, the app icon,
the UI and status icons, the motion set, the bundled typefaces, and the design
tokens that every surface reads. The product and the public site load these
files directly; they are not a starter pack and there is no second copy of the
palette or the geometry.

## Identity
- Flame orange: `#FF4D24`
- Charcoal: `#18191D`, `#22242A`
- Light canvas: `#F5F6F8`
- Typeface: Manrope (UI/display); JetBrains Mono (technical/code)
- Icon style: consistent 24px outline SVGs inspired by common Lucide-style conventions
- Logo: the integrated geometric mark in `brand/trycord-symbol.svg`

## Folder map
- `brand/`: primary lockups, compact symbol, monochrome variants, the animated symbol reveal
- `app/`: app icon, favicon, web manifest, the app-icon pulse
- `icons/ui/`: individual UI SVG icons
- `icons/status/`: presence status symbols
- `icons/communities/`: geometric fallback community avatars
- `motion/`: the SVG and CSS indicators used in the product, plus their raster companions
- `fonts/`: the bundled Manrope and JetBrains Mono subsets and their licences
- `tokens/`: CSS and JSON design tokens
- `docs/`: brand guidelines

## Usage
- SVG files are editable vector artwork. Adjust color through SVG fill/stroke values or `currentColor` where supported.
- For UI icons, use 24×24 viewboxes and CSS width/height to scale them.
- Prefer the primary logo lockup on branded surfaces; use the compact symbol for app icons and small placements. Use the same geometry as `brand/trycord-symbol.svg`; do not redraw or recombine it.
- Keep orange for key actions and brand moments rather than using it for every surface.
- Use semantic status labels as well as color.
- Honor `prefers-reduced-motion`.
- In product UI, prefer the SVG and CSS motion files: they stay sharp, follow the theme, and respect reduced motion. The GIFs in `motion/` are raster companions for social, fallback and embed contexts.
- The Manrope and JetBrains Mono subsets in `fonts/` are bundled. Load them locally; the font files and their notices travel with the interface.

## Licensing and attribution
- Original assets in this package are part of Trycord and are distributed under the repository's MIT licence.
- UI SVGs are original simple outline implementations drawn for this pack, inspired by conventional interface iconography. They are not copies of a bundled third-party icon package.
- Manrope and JetBrains Mono are third-party typefaces under the SIL Open Font License 1.1. The copyright notice and the licence text are in `fonts/NOTICE.txt` and `fonts/OFL.txt` and travel with the font files.
