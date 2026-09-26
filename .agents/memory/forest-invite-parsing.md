---
name: Forest invite parsing
description: Lessons for extracting room details from Forest's surrounding invite text.
---

Forest invite text is not reliably limited to one English “plant N-minute tree” sentence. Duration can be easy to recognize while the tree name appears after it, before it, or in a labeled phrase.

**Why:** A real invite was recognized as 55 minutes but not as a tree name, which caused an unnecessary private prompt.

**How to apply:** Parse the room token from the URL and the tree/duration from the full message text using several contextual patterns. Test realistic English and Arabic samples; use the private form only for fields genuinely absent from the message.