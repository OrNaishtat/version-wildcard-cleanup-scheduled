/// <reference path="./types/jfrog-workers.d.ts" />
import { PlatformContext } from 'jfrog-workers';

const DEFAULT_LIMIT = 200;
const DEFAULT_RETAIN_COUNT = 3;
const DEFAULT_CONCURRENCY = 10;

const PRESET_PATTERNS: Record<string, string> = {
  'ci-build-1': String.raw`^\d+\.\d+\.\d+-\d+\.\d+$`,
  'ci-build-2': String.raw`^\d+\.\d+\.\d+-\d+\.\d+\.$`,
};

const FLEXIBLE_VERSION_REGEX = /\d+(\.\d+)*(-\d+(\.\d+)*)?\.?/;

interface VersionWildcardPayload {
  repos: string[];
  versionPattern?: string;
  sortByVersion?: boolean;
  pathPrefix?: string;
  retainCount?: number;
  dryRun?: boolean;
  limit?: number;
  concurrency?: number;
}

interface ArtifactInfo {
  repo: string;
  name: string;
  path: string;
  type: string;
  size: number;
  modified?: string;
}

class CancelException extends Error {
  constructor(message: string) {
    super(message);
  }
}

function getProp(context: PlatformContext, key: string): string {
  try {
    return context.properties.get(key) || '';
  } catch {
    return '';
  }
}

function getPayloadFromProperties(context: PlatformContext): VersionWildcardPayload {
  const reposStr = getProp(context, 'repos');
  const repos = reposStr
    ? reposStr.includes('[')
      ? (JSON.parse(reposStr) as string[])
      : reposStr.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    repos,
    versionPattern: getProp(context, 'versionPattern') || undefined,
    sortByVersion: getProp(context, 'sortByVersion') === 'true',
    pathPrefix: getProp(context, 'pathPrefix') || undefined,
    retainCount: parseInt(getProp(context, 'retainCount'), 10) || undefined,
    dryRun: getProp(context, 'dryRun') !== 'false',
    limit: parseInt(getProp(context, 'limit'), 10) || undefined,
    concurrency: parseInt(getProp(context, 'concurrency'), 10) || undefined,
  };
}

function getItemPath(item: ArtifactInfo): string {
  const path = item.path === '.' ? item.name : `${item.path}/${item.name}`;
  return item.type === 'folder' ? `${path}/` : path;
}

function extractVersionFromPath(item: ArtifactInfo): string | null {
  const fullPath = item.path === '.' ? item.name : `${item.path}/${item.name}`;
  const parts = fullPath.split('/');
  for (const part of [...parts, item.name]) {
    const match = part.match(FLEXIBLE_VERSION_REGEX);
    if (match) return match[0];
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[.-]/).map(Number);
  const partsB = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (pa !== pb) return pb - pa;
  }
  return 0;
}

async function resolveRepos(context: PlatformContext, repos: string[]): Promise<string[]> {
  const hasWildcard = repos.some((r) => r.includes('*'));
  if (!hasWildcard) return repos;

  console.info('Repo wildcards detected, fetching all local repositories...');
  try {
    const res = await context.clients.platformHttp.get('/artifactory/api/repositories?type=local');
    const allRepos = (res.data as { key: string }[]).map((r) => r.key);
    const resolved = allRepos.filter((key) =>
      repos.some((pattern) => {
        if (!pattern.includes('*')) return key === pattern;
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(key);
      })
    );
    console.info(`Resolved repos: ${resolved.join(', ')}`);
    return resolved;
  } catch (x) {
    const msg = x instanceof Error ? x.message : String(x);
    throw new CancelException(`Failed to fetch repositories: ${msg}`);
  }
}

export default async function versionWildcardCleanup(
  context: PlatformContext,
  data?: VersionWildcardPayload
) {
  const payload =
    data?.repos && data.repos.length > 0 ? data : getPayloadFromProperties(context);

  try {
    checkInput(payload);

    const repos = await resolveRepos(context, payload.repos);
    const patternKey = payload.versionPattern ?? 'auto';
    const useAutoMode = patternKey === 'auto';
    const regexStr = PRESET_PATTERNS[patternKey] ?? patternKey;
    const regex = useAutoMode ? null : new RegExp(regexStr);
    const pathPrefix = payload.pathPrefix || '';
    const retainCount = payload.retainCount ?? DEFAULT_RETAIN_COUNT;
    const limit = payload.limit ?? DEFAULT_LIMIT;
    const concurrency = payload.concurrency ?? DEFAULT_CONCURRENCY;
    const dryRun = payload.dryRun !== false;
    const sortByVersion = Boolean(payload.sortByVersion);

    if (repos.length === 0) {
      console.info('No repositories matched the given pattern. Nothing to do.');
      return { status: 'STATUS_SUCCESS', message: '0 artifact(s) processed', deleted: 0, dryRun };
    }

    console.info(
      `Starting version wildcard cleanup for repos ${repos.join(', ')}, pattern: ${patternKey}, retainCount: ${retainCount}, dryRun: ${dryRun}`
    );

    const items = await findArtifacts(context, repos, pathPrefix, limit);
    const matching = items.filter((item) => {
      const ver = extractVersionFromPath(item);
      if (!ver) return false;
      if (useAutoMode) return true;
      return regex!.test(ver);
    });

    const toDelete = computeArtifactsToDelete(matching, retainCount, sortByVersion);
    console.info(`Found ${matching.length} matching artifacts, ${toDelete.length} to delete`);

    for (let i = 0; i < toDelete.length; i += concurrency) {
      const batch = toDelete.slice(i, Math.min(i + concurrency, toDelete.length));
      await Promise.allSettled(
        batch.map((item) => cleanupItem(context, item, dryRun))
      );
    }

    return {
      status: 'STATUS_SUCCESS',
      message: `${toDelete.length} artifact(s) processed`,
      deleted: toDelete.length,
      dryRun,
    };
  } catch (x) {
    const msg = x instanceof Error ? x.message : String(x);
    console.error(msg);
    return { status: 'STATUS_FAILURE', message: msg };
  }
}

function checkInput(data: VersionWildcardPayload) {
  if (!data) throw new CancelException('No payload or properties configured.');
  if (!data.repos || data.repos.length === 0) {
    throw new CancelException(
      'repos must be specified via payload or Worker Properties (repos key).'
    );
  }
}

async function findArtifacts(
  context: PlatformContext,
  repos: string[],
  pathPrefix: string,
  limit: number
): Promise<ArtifactInfo[]> {
  const reposFilter = `"$or":[${repos.map((r) => `{"repo":"${r}"}`).join(',')}]`;
  const pathMatch = pathPrefix
    ? `,"path":{"$match":"${pathPrefix}*"}`
    : '';

  const query = `items.find({${reposFilter},"type":{"$eq":"file"}${pathMatch}})
    .include("repo","name","path","type","size","modified")
    .sort({"$desc":["modified"]})
    .limit(${limit})`;

  return runAql(context, query);
}

function computeArtifactsToDelete(
  items: ArtifactInfo[],
  retainCount: number,
  sortByVersion: boolean
): ArtifactInfo[] {
  const byComponent = new Map<string, ArtifactInfo[]>();

  for (const item of items) {
    const key = getComponentKey(item);
    if (!byComponent.has(key)) byComponent.set(key, []);
    byComponent.get(key)!.push(item);
  }

  const toDelete: ArtifactInfo[] = [];
  for (const group of byComponent.values()) {
    const sorted = [...group].sort((a, b) => {
      if (sortByVersion) {
        const verA = extractVersionFromPath(a) || '';
        const verB = extractVersionFromPath(b) || '';
        return compareVersions(verA, verB);
      }
      const aMod = a.modified || '';
      const bMod = b.modified || '';
      return bMod.localeCompare(aMod);
    });
    toDelete.push(...sorted.slice(retainCount));
  }

  return toDelete;
}

function getComponentKey(item: ArtifactInfo): string {
  const fullPath = item.path === '.' ? item.name : `${item.path}/${item.name}`;
  const idx = fullPath.search(FLEXIBLE_VERSION_REGEX);
  if (idx >= 0) {
    const base = fullPath.substring(0, idx).replace(/\.$/, '');
    return `${item.repo}:${base}`;
  }
  return `${item.repo}:${fullPath}`;
}

async function cleanupItem(
  context: PlatformContext,
  item: ArtifactInfo,
  dryRun: boolean
) {
  const itemPath = getItemPath(item);
  if (dryRun) {
    console.log(`[dryRun] Would delete ${item.repo}/${itemPath}`);
    return;
  }
  console.log(`Deleting ${item.repo}/${itemPath}`);
  await context.clients.platformHttp.delete(`/artifactory/${item.repo}/${itemPath}`);
  console.log(`Deleted ${item.repo}/${itemPath}`);
}

async function runAql(
  context: PlatformContext,
  query: string
): Promise<ArtifactInfo[]> {
  console.log(`Running AQL: ${query}`);
  try {
    const res = await context.clients.platformHttp.post(
      '/artifactory/api/search/aql',
      query,
      { 'Content-Type': 'text/plain' }
    );
    const data = res.data as { results?: ArtifactInfo[] };
    return data?.results ?? [];
  } catch (x) {
    const msg = x instanceof Error ? x.message : String(x);
    console.error(`AQL query failed: ${msg}`);
    return [];
  }
}
