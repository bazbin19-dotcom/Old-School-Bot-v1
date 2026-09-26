---
name: Discord V2 attachments
description: Components V2 messages still depend on explicit attachment retention when editing.
---

On the initial send, `attachment://filename` can reference files uploaded in that request. For later edits, use each retained attachment's direct `url` and include its `id` in the edit payload's `attachments` list. Reusing `attachment://filename` during an edit can fail validation even when the attachment is retained.

When mapping uploaded files back to their returned attachments, do not rely only on filename equality; if it does not match, use the response order or compare against prior attachment IDs. Discord may return a reachable CDN image URL while discord.js exposes an empty `message.attachments` collection, and a forced message fetch after an edit may still omit the new attachment metadata. If a direct gallery/embed URL for the new upload is available, verify and use it. If there is no recoverable URL, send a complete replacement message with the normal initial-send attachment reference, then delete the old message after the replacement succeeds. This keeps one visible card but moves it to the channel's latest position.

**Why:** Explicitly sending an empty `attachments` array can remove existing files, while reusing `attachment://` during edits can make Discord reject the updated gallery. A missing attachment metadata entry does not necessarily mean the CDN image is unavailable; on some edits, neither the edit response nor a fresh message fetch exposes the uploaded attachment.

**How to apply:** After uploading files, prefer returned attachment URLs by name or upload order and force-fetch the edited message if needed. If metadata is empty, inspect direct gallery/embed URLs. When neither metadata nor a usable new URL is available, create the replacement message first and remove the old one only after the new card is live; tell the user that its position may move to the bottom of the channel.