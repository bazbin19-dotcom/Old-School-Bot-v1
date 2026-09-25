# Discord Image Bot

A Discord bot that converts images posted in one configured channel into interactive image posts with likes, comment threads, and author/moderator controls.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/scripts run discord-bot` — run the Discord image bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `DISCORD_CHANNEL_ID`, `DISCORD_BOT_TOKEN` (secret)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `scripts/src/discord-bot.ts` — Discord events, image conversion, buttons, and modals
- `lib/db/` — PostgreSQL connection used for persistent post and like state

## Architecture decisions

- Source messages are deleted only after the replacement post and database record are successfully created.
- Likes and post controls persist in PostgreSQL; comments are stored in Discord threads attached to the post.
- Captions and the divider are embed content; Discord renders buttons below the embed, not inside it.

## Product

Images in the configured channel become embeds with an optional caption, subtle divider, persistent Like count, comment threads, and owner/moderator controls.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
