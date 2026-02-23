# Version Wildcard Cleanup (Scheduled Worker)

JFrog Worker that runs on a schedule to delete old CI build artifacts, retaining the N most recent versions per component. Supports npm, NuGet, PyPI, Maven, and generic repositories.

## Overview

- Runs on a cron schedule (e.g., daily at 2:00 AM) via JFrog Platform
- Reads configuration from Worker Properties (repos, retainCount, etc.)
- Queries artifacts via AQL, extracts versions from paths, groups by component
- Keeps the latest `retainCount` versions per component, deletes the rest

## Worker Properties

Configure in JFrog Platform: Worker Settings → Properties tab.

| Property       | Required | Description                                                |
|----------------|----------|------------------------------------------------------------|
| `repos`        | Yes      | Comma-separated repo keys or JSON array                    |
| `versionPattern`| No       | `auto` (default), `ci-build-1`, `ci-build-2`, or custom regex |
| `retainCount`  | No       | Versions to keep per component (default: 3)                |
| `sortByVersion`| No       | `true` or `false` (default: false)                         |
| `pathPrefix`   | No       | AQL path prefix to scope the search                        |
| `dryRun`       | No       | `true` = log only; `false` = delete (default: false)       |
| `limit`        | No       | Max artifacts to consider (default: 200)                   |
| `concurrency`  | No       | Parallel delete operations (default: 10)                   |

## Version Patterns

| Key          | Description                    | Example Matches                          |
|--------------|--------------------------------|------------------------------------------|
| `auto`       | Detects any numeric version    | `1`, `1.2`, `1.2.3`, `1.2.3-45.6`        |
| `ci-build-1` | Strict: `*.*.*-*.*`           | 1.2.3-45.6                               |
| `ci-build-2` | Strict: `*.*.*-*.*.` (trailing dot) | 1.2.3-45.6.                          |

## Deployment

```bash
jf worker deploy
# Or with specific server: jf worker deploy --server-id YOUR_SERVER_ID
```

## Schedule

```bash
jf worker edit-schedule --cron "0 2 * * *"   # Daily at 2:00 AM
jf worker edit-schedule --cron "0 */6 * * *" # Every 6 hours
jf worker edit-schedule --cron "0 0 * * 0"   # Weekly on Sunday
```

Cron format: `minute hour day-of-month month day-of-week`. Use `--timezone` for non-UTC.

## Enable Worker

1. Deploy the worker
2. Set Worker Properties in the UI (repos, retainCount, dryRun, etc.)
3. Edit the schedule with `jf worker edit-schedule`
4. Enable the worker in Worker Settings

## Best Practices

- Always set `dryRun: true` first and verify logs before switching to `false`
- Use `pathPrefix` to limit scope (e.g., `com/example/`)
- Use `sortByVersion: true` with `versionPattern: auto` for predictable retention
