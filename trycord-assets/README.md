# Trycord Brand Assets v1.0

A starter pack of individual reusable assets for Trycord, an open-source, self-hostable community chat platform.

## Identity
- Flame orange: `#FF4D24`
- Charcoal: `#18191D`, `#22242A`
- Light canvas: `#F5F6F8`
- Typeface: Manrope (UI/display); JetBrains Mono (technical/code)
- Icon style: consistent 24px outline SVGs inspired by common Lucide-style conventions
- Logo concept: original integrated geometric ΔΓΟ-inspired monogram

## Folder map
- `brand/`: primary lockups, compact symbol, monochrome variants
- `app/`: app icon, favicon, web manifest
- `icons/ui/`: individual UI SVG icons
- `icons/status/`: presence status symbols
- `icons/communities/`: geometric fallback community avatars
- `motion/`: loading SVG and CSS indicators
- `tokens/`: CSS and JSON design tokens
- `docs/`: brand guidelines

## Usage
- SVG files are editable vector artwork. Adjust color through SVG fill/stroke values or `currentColor` where supported.
- For UI icons, use 24×24 viewboxes and CSS width/height to scale them.
- Prefer the primary logo lockup on branded surfaces; use the compact symbol for app icons and small placements.
- Keep orange for key actions and brand moments rather than using it for every surface.
- Use semantic status labels as well as color.
- Honor `prefers-reduced-motion`.
- Load Manrope locally or through your approved font delivery method for self-hosted installations. The font itself is not bundled in this package.

## Important design note
The monogram is a first-pass vector concept based on the agreed integrated ΔΓΟ direction. Review it at small sizes and refine its geometry before treating it as a trademark-ready final. SVG wordmark text uses a Manrope font stack and may be converted to paths for exact cross-platform rendering.

## Licensing and attribution
- Original assets in this package are provided as a Trycord-specific starter design; choose and add an explicit project license before distribution.
- UI SVGs are original simple outline implementations drawn for this pack, inspired by conventional interface iconography. They are not copies of a bundled third-party icon package.
- Manrope and JetBrains Mono are third-party typefaces; review their respective licenses and include appropriate notices when bundling font files.
- No font files are included.
