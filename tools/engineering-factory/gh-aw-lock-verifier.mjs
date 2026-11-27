import {createHash} from 'node:crypto';
import {types} from 'node:util';

export const PINNED_GHAW_RELEASE = Object.freeze({
  repository: 'github/gh-aw',
  version: 'v1.2.2',
  commit: '399a445fe2d8926c616b54b1b82a16b5b2be4445',
  verified: true
});

const MAX_SOURCE_CHARS = 262144;
const FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HEX40_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const SEMVER_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PINNED_USES_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-f0-9]{40}$/;
const KEY_RE = /^[A-Za-z0-9_.-]+$/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const THREAT_SCAN_JOB_IDS = new Set(['threat-and-policy-scan', 'threat-scan', 'threat_scan', 'policy-scan']);
const ALLOWED_SAFE_OUTPUT_SCOPES = new Set(['contents', 'issues', 'pull-requests', 'discussions']);
const FORBIDDEN_SAFE_OUTPUT_WRITES = new Set(['contents', 'workflows', 'actions', 'administration', 'packages', 'id-token', 'security-events', 'statuses', 'checks']);

const deny = reason => Object.freeze({
  shadow: true,
  valid: false,
  liveDispatch: false,
  liveMerge: false,
  reason
});

function isOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function isPlainRecord(value, requiredKeys, optionalKeys = []) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every(key => typeof key === 'string' && allowed.has(key) && isOwnEnumerableData(value, key))) {
    return false;
  }
  return requiredKeys.every(key => Object.hasOwn(value, key) && value[key] !== undefined);
}

function normalizeText(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_SOURCE_CHARS ||
      FORBIDDEN_CONTROL_RE.test(source) || source.includes('\t')) {
    return null;
  }
  const lf = source.replace(/\r\n/g, '\n');
  if (lf.includes('\r')) return null;
  return lf;
}

function extractFrontmatterParts(markdownSource) {
  const normalized = normalizeText(markdownSource);
  if (normalized === null || !normalized.startsWith('---\n')) return null;
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match || match[1].trim().length === 0) return null;
  return {
    innerYaml: match[1],
    canonicalBlock: `---\n${match[1]}\n---`
  };
}

export function computeFrontmatterSha256(markdownSource) {
  const extracted = extractFrontmatterParts(markdownSource);
  if (extracted === null) return null;
  return createHash('sha256').update(extracted.canonicalBlock, 'utf8').digest('hex');
}

function compareSemver(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function resolvePinnedRelease(pinnedRelease) {
  if (pinnedRelease === undefined) {
    return {ok: true, release: PINNED_GHAW_RELEASE, isNewerVerified: false};
  }
  if (!isPlainRecord(pinnedRelease, ['version', 'commit'], ['repository', 'verified'])) {
    return {ok: false, reason: 'PINNED_RELEASE_INVALID'};
  }
  const repository = pinnedRelease.repository === undefined ? 'github/gh-aw' : pinnedRelease.repository;
  const semverMatch = typeof pinnedRelease.version === 'string' ? SEMVER_RE.exec(pinnedRelease.version) : null;
  if (repository !== 'github/gh-aw' || !semverMatch || !HEX40_RE.test(pinnedRelease.commit)) {
    return {ok: false, reason: 'PINNED_RELEASE_INVALID'};
  }
  const parsedVersion = [Number(semverMatch[1]), Number(semverMatch[2]), Number(semverMatch[3])];
  const cmp = compareSemver(parsedVersion, [1, 2, 2]);
  if (cmp < 0) return {ok: false, reason: 'PINNED_RELEASE_INVALID'};
  if (cmp === 0) {
    if (pinnedRelease.verified !== undefined && pinnedRelease.verified !== true) {
      return {ok: false, reason: 'PINNED_RELEASE_INVALID'};
    }
    if (pinnedRelease.commit !== PINNED_GHAW_RELEASE.commit) {
      return {ok: false, reason: 'PINNED_RELEASE_MISMATCH'};
    }
    return {
      ok: true,
      release: Object.freeze({repository, version: pinnedRelease.version, commit: pinnedRelease.commit, verified: true}),
      isNewerVerified: false
    };
  }
  if (pinnedRelease.verified !== true) {
    return {ok: false, reason: 'PINNED_RELEASE_INVALID'};
  }
  if (pinnedRelease.commit === PINNED_GHAW_RELEASE.commit) {
    return {ok: false, reason: 'PINNED_RELEASE_MISMATCH'};
  }
  return {
    ok: true,
    release: Object.freeze({repository, version: pinnedRelease.version, commit: pinnedRelease.commit, verified: true}),
    isNewerVerified: true
  };
}

function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && inDouble) {
      i++;
    } else if (ch === "'" && !inDouble) {
      if (inSingle && raw[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble && (i === 0 || raw[i - 1] === ' ')) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return inSingle || inDouble ? null : raw.trimEnd();
}

function parseScalar(token) {
  if (token.length === 0) return {ok: false};
  if (token.startsWith('&') || token.startsWith('*') || token.startsWith('!')) return {ok: false};
  if (token === '{}') return {ok: true, value: Object.create(null)};
  if (token === '[]') return {ok: true, value: []};
  if (token.startsWith('[') && token.endsWith(']')) {
    const inner = token.slice(1, -1).trim();
    if (inner.length === 0) return {ok: true, value: []};
    const parts = inner.split(',');
    const list = [];
    for (const part of parts) {
      const item = parseScalar(part.trim());
      if (!item.ok || (typeof item.value === 'object' && item.value !== null)) return {ok: false};
      list.push(item.value);
    }
    return {ok: true, value: list};
  }
  if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) {
    const body = token.slice(1, -1);
    const unescaped = body.replace(/''/g, "'");
    if (body.replace(/''/g, '').includes("'")) return {ok: false};
    return {ok: true, value: unescaped};
  }
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    try {
      return {ok: true, value: JSON.parse(token)};
    } catch {
      return {ok: false};
    }
  }
  if (token.startsWith("'") || token.startsWith('"') || token.startsWith('{') || token.startsWith('[')) {
    return {ok: false};
  }
  if (token === 'true') return {ok: true, value: true};
  if (token === 'false') return {ok: true, value: false};
  if (/^(?:0|[1-9]\d*)$/.test(token)) {
    const num = Number(token);
    return Number.isSafeInteger(num) ? {ok: true, value: num} : {ok: false};
  }
  return {ok: true, value: token};
}

function splitKeyValue(content) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble && (i + 1 === content.length || content[i + 1] === ' ')) {
      const rawKey = content.slice(0, i).trim();
      const rest = content.slice(i + 1).trim();
      let key = rawKey;
      if ((rawKey.startsWith("'") && rawKey.endsWith("'")) || (rawKey.startsWith('"') && rawKey.endsWith('"'))) {
        const parsedKey = parseScalar(rawKey);
        if (!parsedKey.ok || typeof parsedKey.value !== 'string') return null;
        key = parsedKey.value;
      } else if (!KEY_RE.test(key)) {
        return null;
      }
      if (key.length === 0 || key === '<<' || FORBIDDEN_OBJECT_KEYS.has(key)) return null;
      return {key, rest};
    }
  }
  return null;
}

function parseStrictYaml(yamlText) {
  const rawLines = yamlText.split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line === '---' || line === '...') return null;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    lines.push({raw: line, indent, trimmed});
  }

  function nextSignificantIndex(fromIndex) {
    for (let i = fromIndex; i < lines.length; i++) {
      if (lines[i].trimmed.length > 0 && !lines[i].trimmed.startsWith('#')) return i;
    }
    return lines.length;
  }

  function parseBlockScalar(startIndex, parentIndent) {
    const collected = [];
    let idx = startIndex;
    let blockIndent = null;
    while (idx < lines.length) {
      const entry = lines[idx];
      if (entry.trimmed.length === 0) {
        collected.push('');
        idx++;
        continue;
      }
      if (entry.indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = entry.indent;
      if (entry.indent < blockIndent) return null;
      collected.push(entry.raw.slice(blockIndent));
      idx++;
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
    return {value: collected.join('\n'), nextIndex: idx};
  }

  function parseNode(startIndex, expectedIndent) {
    const firstIdx = nextSignificantIndex(startIndex);
    if (firstIdx >= lines.length || lines[firstIdx].indent !== expectedIndent) return null;
    return lines[firstIdx].trimmed.startsWith('- ') || lines[firstIdx].trimmed === '-'
      ? parseSequence(firstIdx, expectedIndent)
      : parseMappingEntries(firstIdx, expectedIndent, Object.create(null));
  }

  function parseMappingEntries(startIndex, mapIndent, target) {
    let idx = startIndex;
    while (true) {
      idx = nextSignificantIndex(idx);
      if (idx >= lines.length || lines[idx].indent < mapIndent) {
        return {value: target, nextIndex: idx};
      }
      if (lines[idx].indent !== mapIndent || lines[idx].trimmed.startsWith('-')) return null;
      const cleaned = stripInlineComment(lines[idx].trimmed);
      if (cleaned === null) return null;
      const kv = splitKeyValue(cleaned);
      if (kv === null || Object.hasOwn(target, kv.key)) return null;
      idx++;
      if (kv.rest === '|' || kv.rest === '|-' || kv.rest === '>' || kv.rest === '>-') {
        const block = parseBlockScalar(idx, mapIndent);
        if (block === null) return null;
        target[kv.key] = block.value;
        idx = block.nextIndex;
      } else if (kv.rest.length === 0) {
        const peek = nextSignificantIndex(idx);
        if (peek >= lines.length || lines[peek].indent <= mapIndent) {
          target[kv.key] = Object.create(null);
        } else {
          const child = parseNode(peek, lines[peek].indent);
          if (child === null) return null;
          target[kv.key] = child.value;
          idx = child.nextIndex;
        }
      } else {
        const scalar = parseScalar(kv.rest);
        if (!scalar.ok) return null;
        target[kv.key] = scalar.value;
      }
    }
  }

  function parseSequence(startIndex, seqIndent) {
    const items = [];
    let idx = startIndex;
    while (true) {
      idx = nextSignificantIndex(idx);
      if (idx >= lines.length || lines[idx].indent < seqIndent) {
        return {value: items, nextIndex: idx};
      }
      if (lines[idx].indent !== seqIndent) return null;
      const trimmed = lines[idx].trimmed;
      if (trimmed !== '-' && !trimmed.startsWith('- ')) return null;
      const afterDash = stripInlineComment(trimmed.slice(1).trim());
      if (afterDash === null) return null;
      idx++;
      if (afterDash.length === 0) {
        const peek = nextSignificantIndex(idx);
        if (peek >= lines.length || lines[peek].indent <= seqIndent) return null;
        const child = parseNode(peek, lines[peek].indent);
        if (child === null) return null;
        items.push(child.value);
        idx = child.nextIndex;
        continue;
      }
      const kv = splitKeyValue(afterDash);
      if (kv !== null) {
        const itemObj = Object.create(null);
        const itemIndent = seqIndent + 2;
        if (kv.rest === '|' || kv.rest === '|-' || kv.rest === '>' || kv.rest === '>-') {
          const block = parseBlockScalar(idx, itemIndent);
          if (block === null) return null;
          itemObj[kv.key] = block.value;
          idx = block.nextIndex;
        } else if (kv.rest.length === 0) {
          const peek = nextSignificantIndex(idx);
          if (peek >= lines.length || lines[peek].indent <= itemIndent) {
            itemObj[kv.key] = Object.create(null);
          } else {
            const child = parseNode(peek, lines[peek].indent);
            if (child === null) return null;
            itemObj[kv.key] = child.value;
            idx = child.nextIndex;
          }
        } else {
          const scalar = parseScalar(kv.rest);
          if (!scalar.ok) return null;
          itemObj[kv.key] = scalar.value;
        }
        const continued = parseMappingEntries(idx, itemIndent, itemObj);
        if (continued === null) return null;
        items.push(continued.value);
        idx = continued.nextIndex;
      } else {
        const scalar = parseScalar(afterDash);
        if (!scalar.ok) return null;
        items.push(scalar.value);
      }
    }
  }

  const rootIdx = nextSignificantIndex(0);
  if (rootIdx >= lines.length || lines[rootIdx].indent !== 0 || lines[rootIdx].trimmed.startsWith('-')) {
    return null;
  }
  const parsed = parseMappingEntries(rootIdx, 0, Object.create(null));
  if (parsed === null || nextSignificantIndex(parsed.nextIndex) !== lines.length) return null;
  return parsed.value;
}

function isMapObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractLockHeaders(normalizedLock) {
  const headers = Object.create(null);
  const lines = normalizedLock.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith('#')) break;
    const match = /^#\s*(gh-aw-[a-z0-9-]+):\s*(\S+)\s*$/.exec(trimmed);
    if (match) {
      if (Object.hasOwn(headers, match[1])) return null;
      headers[match[1]] = match[2];
    }
  }
  return headers;
}

function targetsMainMerge(mergeConfig) {
  if (mergeConfig === undefined || mergeConfig === false) return false;
  if (!isMapObject(mergeConfig)) return true;
  const branchValue = mergeConfig.branch ?? mergeConfig['target-branch'] ?? mergeConfig.base ?? 'main';
  if (Array.isArray(branchValue)) {
    return branchValue.length === 0 || branchValue.some(item => item === 'main' || item === 'refs/heads/main' || item === '*');
  }
  return branchValue === 'main' || branchValue === 'refs/heads/main' || branchValue === '*';
}

function inspectFrontmatterPolicy(frontmatter, isNewerVerified, headers) {
  const safeOutputs = frontmatter['safe-outputs'];
  if (safeOutputs !== undefined) {
    if (Array.isArray(safeOutputs)) {
      if (safeOutputs.includes('merge-pull-request')) return {ok: false, reason: 'MAIN_MERGE_FORBIDDEN_IN_GHAW'};
    } else if (isMapObject(safeOutputs)) {
      if (Object.hasOwn(safeOutputs, 'merge-pull-request') && targetsMainMerge(safeOutputs['merge-pull-request'])) {
        return {ok: false, reason: 'MAIN_MERGE_FORBIDDEN_IN_GHAW'};
      }
    } else {
      return {ok: false, reason: 'INVALID_FRONTMATTER'};
    }
  }

  let workQueue = undefined;
  if (isMapObject(frontmatter.tools) && Object.hasOwn(frontmatter.tools, 'work-queue')) {
    workQueue = frontmatter.tools['work-queue'];
  } else if (Object.hasOwn(frontmatter, 'work-queue')) {
    workQueue = frontmatter['work-queue'];
  }

  let protocol = 'v3';
  if (workQueue !== undefined) {
    if (!isMapObject(workQueue)) return {ok: false, reason: 'INVALID_FRONTMATTER'};
    if (workQueue.branch !== undefined && workQueue.branch !== 'work-queue') {
      return {ok: false, reason: 'INVALID_WORK_QUEUE_BRANCH'};
    }
    protocol = workQueue.protocol === undefined ? 'v3' : workQueue.protocol;
  } else if (frontmatter.protocol !== undefined) {
    protocol = frontmatter.protocol;
  }

  if (protocol !== 'v3' && protocol !== 'v4') {
    return {ok: false, reason: 'WORK_QUEUE_PROTOCOL_UNSUPPORTED'};
  }
  if (protocol === 'v4' && !isNewerVerified) {
    return {ok: false, reason: 'WORK_QUEUE_PROTOCOL_UNSUPPORTED'};
  }
  const headerProtocol = headers['gh-aw-work-queue-protocol'];
  if (headerProtocol !== undefined && headerProtocol !== protocol) {
    return {ok: false, reason: 'WORK_QUEUE_PROTOCOL_UNSUPPORTED'};
  }
  return {ok: true, protocol};
}

function isReadOnlyPermissions(perms) {
  if (!isMapObject(perms)) {
    return {ok: false, hasWrite: perms === 'write-all'};
  }
  const keys = Object.keys(perms);
  let hasWrite = false;
  for (const key of keys) {
    if (perms[key] === 'write') hasWrite = true;
  }
  if (hasWrite) return {ok: false, hasWrite: true};
  if (keys.length === 0) return {ok: true, hasWrite: false};
  if (keys.length === 1 && keys[0] === 'contents' && perms.contents === 'read') {
    return {ok: true, hasWrite: false};
  }
  return {ok: false, hasWrite: false};
}

function normalizeNeeds(needsField) {
  if (typeof needsField === 'string') return [needsField];
  if (Array.isArray(needsField) && needsField.length > 0 && needsField.every(item => typeof item === 'string')) {
    return needsField;
  }
  return null;
}

function isPinnedUses(ref) {
  return typeof ref === 'string' && !ref.includes('..') && PINNED_USES_RE.test(ref);
}

function hasBotLoopGuard(condition) {
  return typeof condition === 'string' && (
    condition.includes("!endsWith(github.actor, '[bot]')") ||
    condition.includes('!endsWith(github.actor, "[bot]")') ||
    (condition.includes("github.actor != 'copilot-swe-agent[bot]'") &&
     condition.includes("github.actor != 'github-actions[bot]'"))
  );
}

function hasDefaultOffGuard(condition) {
  return typeof condition === 'string' && (
    condition.includes("vars.FACTORY_GHAW_ENABLED == 'true'") ||
    condition.includes('vars.FACTORY_GHAW_ENABLED == "true"')
  );
}

function stepAttemptsMainMerge(step) {
  if (typeof step.name === 'string' && /merge[-_ ]pull[-_ ]request/i.test(step.name)) return true;
  if (typeof step.run === 'string' && (/\bgh\s+pr\s+merge\b/.test(step.run) || /merge-pull-request/.test(step.run))) {
    return true;
  }
  if (isMapObject(step.env)) {
    for (const val of Object.values(step.env)) {
      if (typeof val === 'string' && val.includes('merge-pull-request')) return true;
    }
  }
  return false;
}

export function verifyGhAwWorkflowLock(input) {
  if (!isPlainRecord(input, ['markdownSource', 'lockYamlSource'], ['pinnedRelease'])) {
    return deny('INVALID_LOCK_INPUT');
  }
  const normalizedLock = normalizeText(input.lockYamlSource);
  if (normalizedLock === null || normalizeText(input.markdownSource) === null) {
    return deny('INVALID_LOCK_INPUT');
  }

  const releaseCheck = resolvePinnedRelease(input.pinnedRelease);
  if (!releaseCheck.ok) return deny(releaseCheck.reason);

  const extracted = extractFrontmatterParts(input.markdownSource);
  if (extracted === null) return deny('INVALID_FRONTMATTER');
  const frontmatter = parseStrictYaml(extracted.innerYaml);
  if (frontmatter === null) return deny('INVALID_FRONTMATTER');

  const computedSha256 = createHash('sha256').update(extracted.canonicalBlock, 'utf8').digest('hex');
  const headers = extractLockHeaders(normalizedLock);
  if (headers === null || !HEX64_RE.test(headers['gh-aw-frontmatter-sha256'] ?? '')) {
    return deny('FRONTMATTER_HASH_MISSING');
  }
  if (headers['gh-aw-frontmatter-sha256'] !== computedSha256) {
    return deny('FRONTMATTER_HASH_MISMATCH');
  }
  if (headers['gh-aw-version'] !== releaseCheck.release.version ||
      headers['gh-aw-commit'] !== releaseCheck.release.commit) {
    return deny('PINNED_RELEASE_MISMATCH');
  }

  const policyCheck = inspectFrontmatterPolicy(frontmatter, releaseCheck.isNewerVerified, headers);
  if (!policyCheck.ok) return deny(policyCheck.reason);

  const lockDoc = parseStrictYaml(normalizedLock);
  if (lockDoc === null || !isMapObject(lockDoc.on) || Object.keys(lockDoc.on).length === 0 ||
      lockDoc.permissions === undefined || !isMapObject(lockDoc.jobs) || Object.keys(lockDoc.jobs).length === 0) {
    return deny('INVALID_LOCK_YAML');
  }

  const topPerms = isReadOnlyPermissions(lockDoc.permissions);
  if (!topPerms.ok) {
    return deny(topPerms.hasWrite ? 'TOP_LEVEL_WRITE_PERMISSION' : 'INVALID_TOP_LEVEL_PERMISSIONS');
  }

  const evaluationJobIds = [];
  const threatScanJobs = [];
  const safeOutputJobs = [];

  for (const [jobId, job] of Object.entries(lockDoc.jobs)) {
    if (!isMapObject(job)) return deny('INVALID_LOCK_YAML');
    if (/merge[-_]pull[-_]request/i.test(jobId)) {
      return deny('MAIN_MERGE_FORBIDDEN_IN_GHAW');
    }
    const isThreatScan = THREAT_SCAN_JOB_IDS.has(jobId);
    const isSafeOutput = jobId.startsWith('safe-outputs') || jobId.startsWith('safe_outputs');

    if (job.uses !== undefined && !isPinnedUses(job.uses)) {
      return deny('UNPINNED_ACTION_REFERENCE');
    }

    if (isSafeOutput) {
      if (!isMapObject(job.permissions)) return deny('EXCESSIVE_SAFE_OUTPUT_PERMISSION');
      for (const [scope, level] of Object.entries(job.permissions)) {
        if (!ALLOWED_SAFE_OUTPUT_SCOPES.has(scope) || (level !== 'read' && level !== 'write') ||
            (level === 'write' && FORBIDDEN_SAFE_OUTPUT_WRITES.has(scope))) {
          return deny('EXCESSIVE_SAFE_OUTPUT_PERMISSION');
        }
      }
      safeOutputJobs.push({jobId, job});
    } else {
      const jobPerms = isReadOnlyPermissions(job.permissions);
      if (!jobPerms.ok) return deny('AGENT_JOB_WRITE_PERMISSION');
      if (isThreatScan) threatScanJobs.push({jobId, job});
      else evaluationJobIds.push({jobId, job});
    }

    if (job.uses === undefined) {
      if (!Array.isArray(job.steps) || job.steps.length === 0) return deny('INVALID_LOCK_YAML');
      for (const step of job.steps) {
        if (!isMapObject(step)) return deny('INVALID_LOCK_YAML');
        if (stepAttemptsMainMerge(step)) return deny('MAIN_MERGE_FORBIDDEN_IN_GHAW');
        if (step.uses !== undefined) {
          if (!isPinnedUses(step.uses)) return deny('UNPINNED_ACTION_REFERENCE');
          if (step.uses.startsWith('actions/checkout@')) {
            if (!isMapObject(step.with) || step.with['persist-credentials'] !== false) {
              return deny('CHECKOUT_CREDENTIALS_PERSISTED');
            }
          }
        }
        if (step.run !== undefined) {
          if (typeof step.run !== 'string' || step.run.includes('${{')) {
            return deny('UNSAFE_RUN_INTERPOLATION');
          }
        }
      }
    }
  }

  if (evaluationJobIds.length === 0) return deny('MISSING_EVALUATION_JOB');
  for (const {job} of evaluationJobIds) {
    if (!hasDefaultOffGuard(job.if)) return deny('MISSING_DEFAULT_OFF_GUARD');
    if (!hasBotLoopGuard(job.if)) return deny('MISSING_BOT_LOOP_GUARD');
  }

  if (threatScanJobs.length === 0) return deny('MISSING_THREAT_SCAN_GATE');
  const threatScanIds = new Set(threatScanJobs.map(entry => entry.jobId));
  for (const {job} of threatScanJobs) {
    const needs = normalizeNeeds(job.needs);
    if (needs === null || !evaluationJobIds.every(evalJob => needs.includes(evalJob.jobId))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
  }

  for (const {job} of safeOutputJobs) {
    const needs = normalizeNeeds(job.needs);
    if (needs === null || !needs.some(dep => threatScanIds.has(dep))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
  }

  return Object.freeze({
    shadow: true,
    valid: true,
    liveDispatch: false,
    liveMerge: false,
    reason: 'GHAW_LOCK_VERIFIED',
    frontmatterSha256: computedSha256,
    lockSha256: createHash('sha256').update(normalizedLock, 'utf8').digest('hex'),
    pinnedRelease: releaseCheck.release,
    workQueueProtocol: policyCheck.protocol
  });
}
