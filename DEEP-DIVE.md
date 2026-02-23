# Version Wildcard Cleanup Worker — In-Depth Technical Document

## Overview

This is a JFrog Worker of type `SCHEDULED_EVENT`. It runs automatically on a cron schedule and deletes old artifact versions from Artifactory repositories, retaining only the N most recent versions per component.

It is fully configuration-driven via **Worker Properties** (set in the JFrog Platform UI). No code changes are needed to configure it for a new environment.

## Architecture at a Glance

```
JFrog Scheduler
      │
      ▼ (cron trigger)
Worker Execution
      │
      ├─ Read config from Worker Properties
      ├─ Run AQL query against Artifactory
      ├─ Extract versions from artifact paths
      ├─ Group by component
      ├─ Sort versions, keep retainCount newest
      └─ Delete the rest (or dry-run log)
```

## Configuration — Worker Properties

There is no local properties file. Worker Properties are stored and managed entirely inside the JFrog Platform. You set them in the UI under:

**Workers → [worker name] → Settings → Properties tab**

| Property         | Required | Default | Description |
|------------------|----------|---------|-------------|
| `repos`          | Yes      | —       | Comma-separated repo keys or JSON array. E.g. `libs-snapshot-local` or `["repo-a","repo-b"]` |
| `versionPattern` | No       | `auto`  | Version matching strategy. Options: `auto`, `ci-build-1`, `ci-build-2`, or custom regex |
| `retainCount`    | No       | `3`     | How many versions to keep per component |
| `sortByVersion`  | No       | `false` | `true` = sort by version number; `false` = sort by last modified date |
| `pathPrefix`     | No       | (none)  | AQL path prefix to narrow the search. E.g. `com/example/` |
| `dryRun`         | No       | `false` | `true` = log only, no deletions; `false` = real deletions |
| `limit`          | No       | `200`   | Max number of artifacts fetched from Artifactory per run |
| `concurrency`    | No       | `10`    | Number of parallel delete operations (custom, see Deletion section) |

## The Schedule

Defined in `manifest.json`:

```json
"filterCriteria": {
  "schedule": {
    "cron": "0 2 * * *",
    "timezone": "UTC"
  }
}
```

### Cron Format

```
┌─────── minute (0-59)
│ ┌───── hour (0-23)
│ │ ┌─── day of month (1-31)
│ │ │ ┌─ month (1-12)
│ │ │ │ ┌ day of week (0=Sun, 6=Sat)
│ │ │ │ │
0 2 * * *   →  Every day at 2:00 AM UTC
```

### Common Schedule Examples

| Cron           | Meaning                     |
|----------------|-----------------------------|
| `0 2 * * *`    | Daily at 2:00 AM            |
| `0 */6 * * *`  | Every 6 hours               |
| `0 0 * * 0`    | Weekly, Sunday at midnight  |
| `0 3 * * 1-5`  | Weekdays at 3:00 AM         |

### How to Change the Schedule

**Before deployment:** edit `manifest.json` directly.

**After deployment:** run:
```bash
jf worker edit-schedule --cron "0 6 * * *"
jf worker edit-schedule --cron "0 6 * * *" --timezone "America/New_York"
```

## The AQL Query

AQL (Artifactory Query Language) is how the worker searches for artifacts programmatically. It is sent to the Artifactory REST API endpoint:

```
POST /artifactory/api/search/aql
```

### What the Worker Builds

The query is constructed dynamically in `findArtifacts()` in `worker.ts`:

```
items.find({
  "$or": [{"repo": "libs-snapshot-local"}],
  "type": {"$eq": "file"},
  "path": {"$match": "com/example/*"}   ← only added if pathPrefix is set
})
.include("repo", "name", "path", "type", "size", "modified")
.sort({"$desc": ["modified"]})
.limit(200)
```

### Breaking Down Each Part

| Part | What it does |
|------|--------------|
| `items.find(...)` | Search for artifacts in Artifactory |
| `"$or": [{"repo": "..."}]` | Scope to one or more specific repositories |
| `"type": {"$eq": "file"}` | Only return files, not folders |
| `"path": {"$match": "com/example/*"}` | Optional — narrows to a path prefix |
| `.include(...)` | Fields to return: repo, name, path, type, size, modified |
| `.sort({"$desc": ["modified"]})` | Newest-modified artifacts first |
| `.limit(200)` | Cap results at configured limit (default 200) |

### Where `pathPrefix` Comes From

```
Worker Property set in UI:  pathPrefix = com/example/
                │
                ▼
getPayloadFromProperties()  reads  p.get('pathPrefix')
                │
                ▼
passed into  findArtifacts(context, repos, pathPrefix, limit)
                │
                ▼
appended to AQL:  ,"path":{"$match":"com/example/*"}
```

If `pathPrefix` is not set, the path filter is omitted and all paths in the repo are searched.

### Example AQL as Seen in Execution Logs

```
Running AQL: items.find({"$or":[{"repo":"libs-snapshot-local"}],"type":{"$eq":"file"}})
    .include("repo","name","path","type","size","modified")
    .sort({"$desc":["modified"]})
    .limit(200)
```

## Version Extraction

After the AQL returns results, the worker scans each artifact's path to extract a version string.

### How It Works

Given an artifact path like:
```
libs-snapshot-local/com/example/myapp/1.2.3/myapp-1.2.3.jar
```

The worker splits by `/`, scans each segment for a version-like pattern, and extracts `1.2.3`.

The regex used in `auto` mode:
```
/\d+(\.\d+)*(-\d+(\.\d+)*)?\.?/
```

This matches: `1`, `1.2`, `1.2.3`, `1.2.3-45`, `1.2.3-45.6`, `1.2.3-45.6.` etc.

### Version Patterns

| Key          | Regex                                 | Matches             | Does NOT match  |
|--------------|---------------------------------------|---------------------|-----------------|
| `auto`       | flexible numeric                      | `1.2`, `1.2.3-45.6` | non-numeric     |
| `ci-build-1` | `^\d+\.\d+\.\d+-\d+\.\d+$`           | `1.2.3-45.6`        | `1.2.3`, `1.2`  |
| `ci-build-2` | `^\d+\.\d+\.\d+-\d+\.\d+\.$`         | `1.2.3-45.6.`       | `1.2.3-45.6`    |
| custom regex | your own regex string                 | your definition     | —               |

## Component Grouping

Artifacts are grouped by **component** — the portion of the path before the version segment.

### Example

```
libs-snapshot-local/com/example/myapp/1.0.0/myapp-1.0.0.jar  →  group: com/example/myapp/
libs-snapshot-local/com/example/myapp/1.0.1/myapp-1.0.1.jar  →  group: com/example/myapp/
libs-snapshot-local/com/example/myapp/2.0.0/myapp-2.0.0.jar  →  group: com/example/myapp/

libs-snapshot-local/com/example/otherlib/3.0.0/otherlib.jar  →  group: com/example/otherlib/
```

Each group is handled independently. `retainCount` applies per group.

## Retention Logic

Within each component group, the worker sorts all versions and keeps the top `retainCount`, deleting the rest.

### Sorting Modes

**`sortByVersion=false` (default)** sorts by `modified` date (most recently uploaded first).
Keeps the most recently uploaded artifacts regardless of version number. Useful when versions are not strictly incremental.

**`sortByVersion=true`** sorts by version number using numeric comparison.
Compares numerically: `1.10.0` is correctly treated as newer than `1.9.0`. Recommended for semantic versioning.

### Example with retainCount=3

```
Versions found for com/example/myapp:
  2.0.0  ← KEEP
  1.0.4  ← KEEP
  1.0.3  ← KEEP
  1.0.2  ← DELETE
  1.0.1  ← DELETE
  1.0.0  ← DELETE
```

## Deletion

For each artifact marked for deletion, the worker calls the Artifactory REST API:

```
DELETE /artifactory/{repo}/{path}/{filename}
```

### Parallel Batching (Custom Implementation)

The parallel batching is custom code written in the worker — it is not a built-in JFrog Workers feature. The worker slices the delete list into batches and runs them in parallel using JavaScript's `Promise.allSettled`:

```typescript
for (let i = 0; i < toDelete.length; i += concurrency) {
  const batch = toDelete.slice(i, i + concurrency);
  await Promise.allSettled(batch.map((item) => cleanupItem(context, item, dryRun)));
}
```

The batch size is controlled by the `concurrency` Worker Property (default 10). To change it, add or update the `concurrency` key in the Worker Properties in the JFrog Platform UI. For example, set it to `5` on large repos to reduce load on Artifactory.

### Dry Run Mode

When `dryRun=true`, no DELETE calls are made. Each artifact is logged instead:

```
[dryRun] Would delete libs-snapshot-local/com/example/myapp/1.0.0/myapp-1.0.0.jar
```

Always start with `dryRun=true` to verify before enabling real deletions.

## Deployment Steps

### 1. Deploy the worker
```bash
jf worker deploy
jf worker deploy --server-id YOUR_SERVER_ID
```

### 2. Set Worker Properties in the UI

Go to **Workers → [worker name] → Settings → Properties tab** and add:

| Key            | Example Value       |
|----------------|---------------------|
| repos          | libs-snapshot-local |
| versionPattern | auto                |
| retainCount    | 3                   |
| sortByVersion  | true                |
| dryRun         | true                |
| limit          | 200                 |
| concurrency    | 10                  |

### 3. Set the schedule
```bash
jf worker edit-schedule --cron "0 2 * * *"
```

### 4. Enable the worker
In the JFrog Platform UI → Workers → turn the **Enable** toggle ON.

## Testing via CLI

The worker supports payload-based invocation for testing. When `repos` is present in the payload it takes precedence over Worker Properties:

```bash
jf worker test-run @payload.json
```

Example `payload.json`:
```json
{
  "repos": ["libs-snapshot-local"],
  "versionPattern": "auto",
  "retainCount": 3,
  "sortByVersion": true,
  "dryRun": true,
  "limit": 200
}
```

The CLI sends this to the platform, runs the worker, and streams back the full execution logs and result.

## Execution Logs

Example of a full run output:

```
Starting version wildcard cleanup for repos libs-snapshot-local, pattern: auto, retainCount: 3, dryRun: true
Running AQL: items.find(...)
Found 45 matching artifacts, 12 to delete
[dryRun] Would delete libs-snapshot-local/com/example/myapp/1.0.0/myapp-1.0.0.jar
[dryRun] Would delete libs-snapshot-local/com/example/myapp/1.0.1/myapp-1.0.1.jar
...
```

Check execution history:
```bash
jf worker execution-history
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `repos must be specified` | `repos` property not set | Add `repos` in Worker Properties |
| `Found 0 matching artifacts` | Wrong repo name or pathPrefix too narrow | Check repo key; try without pathPrefix first |
| Artifacts not being deleted | `dryRun=true` | Set `dryRun=false` |
| Too many artifacts deleted | `retainCount` too low | Increase `retainCount` |
| Wrong versions deleted | `sortByVersion` mismatch | Toggle `sortByVersion` and re-test with dryRun |
| Worker not running | Disabled or no schedule set | Enable toggle and run `jf worker edit-schedule` |

## Best Practices

1. Always test with `dryRun=true` first and review the logs carefully
2. Use `pathPrefix` to narrow scope and avoid touching unrelated components
3. Start with a small `limit` (e.g. 50) on first run to verify behavior
4. Use `sortByVersion=true` for semantic versioning (`1.2.3`)
5. Use `sortByVersion=false` to keep whatever was uploaded most recently
6. Set `concurrency` lower (e.g. 3 to 5) on large repos to reduce load on Artifactory
