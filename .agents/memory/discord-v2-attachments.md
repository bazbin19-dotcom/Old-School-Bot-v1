---
name: Discord V2 attachments
description: Components V2 messages still depend on explicit attachment retention when editing.
---

When editing an image post, include the IDs of its existing attachments in the edit payload. Omitting them can remove the files even if a media gallery still appears to render, causing later interaction handlers to fail when they fetch the post images.

**Why:** Like and comment handlers look up images by the stored filenames; dropped Discord attachments make those actions fail with a missing-image error.

**How to apply:** Any message edit that changes Components V2 layout or buttons should preserve current attachment IDs. For already-affected posts, recover an image URL from the media gallery when possible.