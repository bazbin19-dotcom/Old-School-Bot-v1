---
name: Discloud deployment packaging
description: Discloud ZIP layout and npm builder expectations for this bot project.
---

For Discloud ZIP/GitHub deployments, `discloud.config` must be at the archive or repository root. The builder runs `npm install`, then `npm run build --if-present`, before the configured `START` command. A pnpm-only build script can therefore fail even when npm installation succeeds. The ZIP must contain the project files at its top level rather than inside an extra downloaded-source folder.

**Why:** The Discloud build log showed that the container used npm and did not have pnpm; the configured TypeScript entry runs with `tsx` and does not need a compilation step.

**How to apply:** Keep root config/package files available, include the bot source and runtime assets, and ensure the build command safely skips an unnecessary compile when pnpm is unavailable. Treat missing runtime variables as a startup issue, not a build-analysis issue.