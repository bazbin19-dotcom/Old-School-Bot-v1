---
name: OpenType.js ESM and SVG path rendering
description: Node ESM imports and SVG path serialization behavior for OpenType.js 2.x.
---

With OpenType.js 2.x in Node ESM, import the default export object and call `opentype.parse(...)`. A named `parse` import can pass TypeScript checks but fail during ESM module loading because the package does not expose named ESM exports.

**Why:** A TypeScript eval path allowed the named import to run, while the actual `tsx` service startup failed before the bot became ready.

**How to apply:** When changing font parsing in this workspace, keep the default import and verify with a native ESM parse or a full workflow start, not only a transpiled eval.

OpenType.js 2.0's `Path.toPathData(2)` can emit `NaN` for some otherwise-finite font paths depending on glyph positions. SVG renderers may then drop timer digits. Serialize `Path.commands` directly and validate coordinates instead of relying on the package formatter.

**Why:** A timer image lost a zero even though the glyph path commands were finite; the package formatter emitted `NaN` while serializing that centered glyph.

**How to apply:** For SVG text from this font, explicitly serialize the M/L/Q/C/Z commands and reject non-finite coordinates before rendering.