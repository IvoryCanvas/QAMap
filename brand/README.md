# QAMap Brand Assets

This directory contains the reusable source kit for QAMap maintainers and
contributors. It is kept in the GitHub repository and is not part of the npm
runtime package.

## Choose The Right Asset

| Use | Asset |
| --- | --- |
| Editable full-color symbol | [`source/qamap-mark.svg`](source/qamap-mark.svg) |
| Editable one-color symbol | [`source/qamap-mark-monochrome.svg`](source/qamap-mark-monochrome.svg) |
| Editable square app icon | [`source/qamap-app-icon.svg`](source/qamap-app-icon.svg) |
| Transparent symbol exports | [`png/`](png/) |
| Square app icon exports | [`png/`](png/) |
| Favicons, touch icon, and PWA icons | [`web/`](web/) |
| GitHub repository social preview, 1280 x 640 | [`../docs/assets/qamap-github-social-preview-1280x640.png`](../docs/assets/qamap-github-social-preview-1280x640.png) |
| General social card, 1200 x 630 | [`../docs/assets/qamap-social-card.png`](../docs/assets/qamap-social-card.png) |
| English README cover, 1600 x 800 | [`../docs/assets/qamap-cover.png`](../docs/assets/qamap-cover.png) |
| Korean README cover, 1600 x 800 | [`../docs/assets/qamap-cover-ko.png`](../docs/assets/qamap-cover-ko.png) |
| OpenAI plugin upload images | [`../plugin/assets/`](../plugin/assets/) |
| Portable skill icon | [`../skills/qamap-pr-qa/assets/qamap-logo.png`](../skills/qamap-pr-qa/assets/qamap-logo.png) |

Do not resize a screenshot or crop a presentation image when one of these
production assets already fits the target surface.

## Identity Rules

- Use `#07111F` for deep navy, `#20BCEB` for the evidence route,
  `#FFB31A` for verified proof, and `#F4F7FB` for high-contrast detail.
- Keep at least two trace widths of clear space around the visible symbol.
- Use the full-color mark at 48 px or larger. Use the supplied favicon files
  for smaller sizes.
- Preserve the approved node positions, return curve, and proof check.
- Keep the spelling and capitalization exactly as `QAMap`.

Do not stretch, rotate, mirror, recolor, redraw, or decorate the mark. Do not
add gradients, shadows, glow, texture, generic AI motifs, or extra branches.

## Updating Public Surfaces

When the identity changes, review every deployed copy rather than replacing
only the README image:

1. README covers in `docs/assets/`
2. GitHub repository social preview
3. General social card
4. OpenAI light and dark upload images
5. Portable skill icon
6. Web icon exports in this directory

The release checklist and repository tests enforce the expected production
dimensions. GitHub repository settings still require a maintainer to upload
the social preview image manually.
