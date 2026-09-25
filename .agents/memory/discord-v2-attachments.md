---
name: Discord V2 attachments
description: Components V2 messages still depend on explicit attachment retention when editing.
---

On the initial send, `attachment://filename` can reference files uploaded in that request. For later edits, use each retained attachment's direct `url` and include its `id` in the edit payload's `attachments` list. Reusing `attachment://filename` during an edit can fail validation even when the attachment is retained.

When mapping uploaded files back to their returned attachments, do not rely only on filename equality; if it does not match, use the response order to associate each attachment with the corresponding upload.

**Why:** Omitting attachment IDs can remove the files, while reusing `attachment://` during edits can make Discord reject the updated gallery. Strict filename matching can also fail after a successful upload and leave the post without controls.

**How to apply:** After uploading files, resolve each image from the returned attachment collection by name or upload order, then rebuild the post with its direct URL. On every edit, preserve existing attachment IDs. For already-affected posts, recover a direct URL from the media gallery when possible.