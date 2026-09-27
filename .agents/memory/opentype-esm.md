---
name: OpenType.js ESM exports
description: Node ESM interop behavior for OpenType.js 2.x.
---

With OpenType.js 2.x in Node ESM, import the default export object and call `opentype.parse(...)`. A named `parse` import can pass TypeScript checks but fail during ESM module loading because the package does not expose named ESM exports.

**Why:** A TypeScript eval path allowed the named import to run, while the actual `tsx` service startup failed before the bot became ready.

**How to apply:** When changing font parsing in this workspace, keep the default import and verify with a native ESM parse or a full workflow start, not only a transpiled eval.