---
name: Discord message repositioning
description: Discord API behavior and replacement strategy for moving persistent bot panels to the latest channel position.
---

Discord does not support moving an existing message while keeping its message ID. To keep a persistent bot panel at the bottom, send a replacement, update the stored panel ID, then delete the old panel. Serialize replacements so concurrent sends do not leave multiple panels.

**Why:** Editing a Discord message does not change its position, and interactions can validate the stored message ID to reject stale panels.

**How to apply:** Explain that a replacement changes the Discord message ID. Send the new panel before deleting the old one to avoid losing the panel if sending fails, then handle deletion failures explicitly.