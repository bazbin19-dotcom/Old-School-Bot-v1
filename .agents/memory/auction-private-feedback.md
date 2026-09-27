---
name: Auction ephemeral feedback
description: Privacy expectations and Discord interaction constraints for auction setup and bid warnings.
---

Auction setup and rejected-bid explanations must use ephemeral interaction responses in the auction channel. Do not use private threads or DMs. A normal message event cannot receive an ephemeral response, so a public launcher button after the authorized «مزاد» message opens the private setup controls. Bids use a button and modal; accepted amounts are posted publicly by the bot.

The public setup launcher expires one minute after it is sent and is then deleted. If its creator misses it, sending «مزاد» again can issue a replacement; an already-open ephemeral setup panel remains usable after the launcher is deleted.

**Why:** The user explicitly chose ephemeral setup and rejection feedback in the same channel, with accepted bids and auction announcements visible publicly.

**How to apply:** Keep «مزاد» as the role-gated message trigger, then require a button interaction before showing ephemeral setup. Delete the public launcher after one minute, but do not expire an ephemeral panel already opened from it. Use bid modals for private validation feedback and publish only accepted amounts, start/end announcements, and winner details. Never add slash commands, threads, or DMs to this flow.