# Clawd for Cyrvis

Original animated pixel-art SVGs from [ccyrene/clawd](https://github.com/ccyrene/clawd),
a fork of Hert4/clawd-window, pinned to `fea00f0126d2aded71ec8916966c51a5cd3c22bf`.
The seven SVG files are byte-for-byte copies of `src/assets/`, checked against
the upstream Git blob hashes and recorded in `../SHA256SUMS.json`.

## State mapping

| Cyrvis state | Upstream animation |
| --- | --- |
| Idle | `clawd-idle-living.svg` |
| Listening | `clawd-notification.svg` |
| Thinking | `clawd-working-thinking.svg` |
| Speaking | `clawd-happy.svg` |
| Working | `clawd-working-typing.svg` |
| Sleeping | `clawd-sleeping.svg` |
| Dragging | `clawd-dizzy.svg` |

Select **Appearance → Clawd → Clawd · 像素小螃蟹** from the pet's context menu.
The existing Cyrvis selection persistence and Ryan voice mapping apply.

SVGs load as local image resources, retaining their internal CSS animations
without embedding an active document or executing upstream JavaScript. Original
view boxes keep room for particles and gestures. Cyrvis supplies dragging,
conversation, task state and window behavior; the source project's Windows
climbing, file-eating and Claude Code plugin are not part of this artwork pack.

## Attribution and terms

`UPSTREAM-README.md` and `upstream-manifest.json` preserve the source documentation.
The upstream README identifies the pixel art as original work of the project
author, provided as-is. No explicit license granting redistribution or commercial
use was found in the pinned repository. Included at the user's request for local
integration; those rights remain unestablished and require author permission
before distributing the artwork with the application.
