---
name: Auction ephemeral feedback
description: Privacy expectations and Discord interaction constraints for auction setup and bid warnings.
---

Auction setup and rejected-bid explanations must use ephemeral interaction responses in the auction channel. Do not use private threads or DMs. A normal message event cannot receive an ephemeral response, so a public launcher button after the authorized «مزاد» message opens the private setup controls. Bids use a button and modal; accepted amounts are posted publicly by the bot.

**Why:** The user explicitly chose ephemeral setup and rejection feedback in the same channel, with accepted bids and auction announcements visible publicly.

**How to apply:** Keep «مزاد» as the role-gated message trigger, then require a button interaction before showing ephemeral setup. Use bid modals for private validation feedback and publish only accepted amounts, start/end announcements, and winner details. Never add slash commands, threads, or DMs to this flow.