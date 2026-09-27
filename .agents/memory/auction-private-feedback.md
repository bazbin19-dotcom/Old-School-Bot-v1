---
name: Auction ephemeral feedback
description: Privacy expectations and Discord interaction constraints for auction setup and bid warnings.
---

Auction setup must use an ephemeral interaction response in the auction channel. Do not use private threads or DMs. A normal message event cannot receive an ephemeral response, so a public launcher button after the authorized «مزاد» message opens the private setup controls. During an active auction, standalone numeric messages are bids; accepted amounts are announced publicly by the bot, while rejected numeric messages are deleted without a reply.

The public setup launcher expires one minute after it is sent and is then deleted. If its creator misses it, sending «مزاد» again can issue a replacement; an already-open ephemeral setup panel remains usable after the launcher is deleted.

**Why:** The user wants bid amounts entered directly in chat and chose silent deletion for rejected amounts after learning that Discord cannot send ephemeral responses to regular message events.

**How to apply:** Keep «مزاد» as the role-gated message trigger, then require a button interaction before showing ephemeral setup. Delete the public launcher after one minute, but do not expire an ephemeral panel already opened from it. Treat only standalone numeric messages during an active auction as bids, and remove rejected numeric messages without a public reply. Publish accepted amounts and auction start/end/winner announcements. Never add slash commands, threads, or DMs to this flow.