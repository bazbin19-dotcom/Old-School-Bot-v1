---
name: Discord V2 attachments
description: Components V2 messages still depend on explicit attachment retention when editing.
---

On the initial send, `attachment://filename` can reference files uploaded in that request. For later edits, use each retained attachment's direct `url` and include its `id` in the edit payload's `attachments` list. Reusing `attachment://filename` during an edit can fail validation even when the attachment is retained.

**Why:** Omitting attachment IDs can remove the files, while reusing `attachment://` during edits can make Discord reject the updated gallery. Both failures leave a post without usable controls or break later image lookups.

**How to apply:** After uploading files, rebuild the post with the returned attachment URLs. On every edit, preserve existing attachment IDs. For already-affected posts, recover a direct URL from the media gallery when possible.