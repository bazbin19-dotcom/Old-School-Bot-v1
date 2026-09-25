---
name: Discord ephemeral button interactions
description: Discord component interactions from ephemeral replies reference the ephemeral message rather than the original public post.
---

For controls shown in an ephemeral settings or confirmation reply, `interaction.message.id` identifies that ephemeral reply, not the public image post. Do not require it to equal the stored post ID for those sub-actions. Resolve the post from the encoded ID, verify the interaction channel, and re-check ownership or moderator permissions. Public-card controls should still validate their message ID.

**Why:** Applying the public-card message-ID guard to ephemeral settings controls makes valid edit, comment-lock, and delete-confirmation actions appear unavailable.

**How to apply:** Distinguish public-card buttons from controls rendered in ephemeral replies when validating Discord button interactions.