---
name: Discord V2 attachments
description: Components V2 messages still depend on explicit attachment retention when editing.
---

On the initial send, `attachment://filename` can reference files uploaded in that request. For later edits, use each retained attachment's direct `url` and include its `id` in the edit payload's `attachments` list. Reusing `attachment://filename` during an edit can fail validation even when the attachment is retained.

When mapping uploaded files back to their returned attachments, do not rely only on filename equality; if it does not match, use the response order to associate each attachment with the corresponding upload. Discord may also return a reachable CDN image URL while discord.js exposes an empty `message.attachments` collection. In that case, verify the direct gallery/embed URL and use it as the image reference.

**Why:** Explicitly sending an empty `attachments` array can remove existing files, while reusing `attachment://` during edits can make Discord reject the updated gallery. A missing attachment metadata entry does not necessarily mean the CDN image is unavailable.

**How to apply:** After uploading files, prefer returned attachment URLs by name or upload order. If metadata is empty, verify direct URLs from the media gallery or embed. On edits, include known attachment IDs; if no IDs are available, omit the `attachments` property rather than sending an empty array. For already-affected posts, recover a direct URL from the existing gallery/embed.