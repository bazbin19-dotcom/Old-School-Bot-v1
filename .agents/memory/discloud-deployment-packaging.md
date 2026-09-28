---
name: Discloud deployment packaging
description: Discloud ZIP layout and npm builder expectations for this bot project.
---

For Discloud ZIP/GitHub deployments, `discloud.config` must be at the archive or repository root. The builder runs `npm install`, then `npm run build --if-present`, before the configured `START` command. A pnpm-only build script can therefore fail even when npm installation succeeds. The ZIP must contain the project files at its top level rather than inside an extra downloaded-source folder. Runtime binaries used by `npm start` should be installed at the root, rather than relying on a workspace-local executable.

**Why:** Discloud's npm workspace install did not expose the `tsx` binary to the workspace start script, so the bot exited offline even after the build passed. The configured TypeScript entry can run from the root and does not need a compilation step.

**How to apply:** Keep root config/package files available, include the bot source and runtime assets, declare runtime packages at the root for npm builders, and ensure the build command safely skips an unnecessary compile when pnpm is unavailable. Treat missing runtime variables as a startup issue, not a build-analysis issue.