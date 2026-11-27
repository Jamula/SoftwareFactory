// Frontmatter canonical JSON hash and # gh-aw-metadata schema match github/gh-aw
// v1.2.2 (399a445fe2d8926c616b54b1b82a16b5b2be4445, MIT License, Copyright GitHub, Inc.).
import {createHash} from 'node:crypto';
import {types} from 'node:util';

export const PINNED_GHAW_RELEASE = Object.freeze({
  repository: 'github/gh-aw',
  version: 'v1.2.2',
  commit: '399a445fe2d8926c616b54b1b82a16b5b2be4445',
  verified: true
});

export const PINNED_GHAW_DETECTION_CONCLUSION_SCRIPT_SHA256 =
  '63f302c76492b6bde7052889282d030724cde0379ba2b3e38f16882d956c1972';
export const PINNED_FACTORY_POLICY_SCAN_RUN_SHA256 =
  'f80ecd1a1eb7d1afe69e912592699647f0a4fcf4da5148db05fcaaa5a383c970';

const MAX_SOURCE_CHARS = 262144;
const FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HEX40_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const SEMVER_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PINNED_USES_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-f0-9]{40}$/;
const KEY_RE = /^[A-Za-z0-9_.-]+$/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SUPPORTED_METADATA_SCHEMAS = new Set(['v1', 'v2', 'v3', 'v4']);
const ALLOWED_WORK_QUEUE_TOOL_KEYS = new Set(['require-assignment', 'worker', 'issues', 'memory']);
const ALLOWED_WORK_QUEUE_MEMORY_KEYS = new Set([
  'name', 'path', 'target-repo', 'base-revision', 'branch-prefix', 'max-bytes', 'schema'
]);
const REQUIRED_WORK_QUEUE_MEMORY_KEYS = ['path', 'target-repo', 'base-revision', 'branch-prefix', 'schema'];
const HELPER_JOB_IDS = new Set(['activation', 'pre_activation', 'pre-activation', 'conclusion', 'unlock']);
const ALLOWED_HELPER_READ_SCOPES = new Set(['contents', 'actions', 'metadata']);
const THREAT_SCAN_JOB_IDS = new Set(['threat-and-policy-scan', 'threat-scan', 'threat_scan', 'policy-scan', 'detection']);
const ALLOWED_SAFE_OUTPUT_SCOPES = new Set(['contents', 'issues', 'pull-requests', 'discussions']);
const FORBIDDEN_SAFE_OUTPUT_WRITES = new Set(['contents', 'workflows', 'actions', 'administration', 'packages', 'id-token', 'security-events', 'statuses', 'checks']);
const BYPASS_CALL_NAMES = new Set(['always', 'failure', 'cancelled']);
const MAX_IF_TOKENS = 64;
const MAX_IF_DEPTH = 16;

const isHex40 = value => typeof value === 'string' && HEX40_RE.test(value);
const isHex64 = value => typeof value === 'string' && HEX64_RE.test(value);

function isDenseHexArray(value, checkItem, maxLen = 64) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (!isOwnEnumerableData(value, String(i)) || !checkItem(value[i])) return false;
  }
  return true;
}

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

function scanTemplateExpressions(markdownBody) {
  const found = [];
  let offset = 0;
  while (offset < markdownBody.length) {
    const start = markdownBody.indexOf('${{', offset);
    if (start === -1) break;
    let inSingle = false;
    let end = start + 3;
    while (end < markdownBody.length) {
      if (markdownBody[end] === "'") {
        inSingle = !inSingle;
      } else if (!inSingle && markdownBody[end] === '}' && markdownBody[end + 1] === '}') {
        break;
      }
      end++;
    }
    if (end >= markdownBody.length) {
      offset = start + 3;
      continue;
    }
    found.push({
      expression: markdownBody.slice(start, end + 2),
      content: markdownBody.slice(start + 3, end)
    });
    offset = end + 2;
  }
  return found;
}

function marshalCanonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => marshalCanonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${marshalCanonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function extractFrontmatterParts(markdownSource) {
  const normalized = normalizeText(markdownSource);
  if (normalized === null) return null;
  const lines = normalized.split('\n');
  if (lines[0].trim() !== '---') return null;
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return null;
  const frontmatterText = lines.slice(1, endIndex).join('\n');
  const markdownBody = lines.slice(endIndex + 1).join('\n');
  const normalizedFrontmatter = frontmatterText.trim();
  if (normalizedFrontmatter.length === 0) return null;
  if (/\{\{#(?:runtime-import|import)\??/.test(markdownBody)) return null;
  const parsedFrontmatter = parseStrictYaml(frontmatterText);
  if (parsedFrontmatter !== null) {
    if (Object.hasOwn(parsedFrontmatter, 'imports')) return null;
  } else if (/^imports\s*:/m.test(frontmatterText)) {
    return null;
  }
  const inlinedImports = parsedFrontmatter !== null && parsedFrontmatter['inlined-imports'] === true;
  const canonical = {'frontmatter-text': normalizedFrontmatter};
  if (inlinedImports) {
    const normalizedBody = markdownBody.trim();
    if (normalizedBody.length > 0) canonical['body-text'] = normalizedBody;
  } else {
    const relevant = [...new Set(
      scanTemplateExpressions(markdownBody)
        .filter(item => item.content.includes('env.') || item.content.includes('vars.'))
        .map(item => item.expression)
    )].sort();
    if (relevant.length > 0) canonical['template-expressions'] = relevant;
  }
  return {
    parsedFrontmatter,
    normalizedBody: markdownBody.trim(),
    canonicalJson: marshalCanonicalJson(canonical)
  };
}

export function computeFrontmatterSha256(markdownSource) {
  const extracted = extractFrontmatterParts(markdownSource);
  if (extracted === null) return null;
  return createHash('sha256').update(extracted.canonicalJson, 'utf8').digest('hex');
}

export function computeBodySha256(markdownSource) {
  const extracted = extractFrontmatterParts(markdownSource);
  if (extracted === null) return null;
  return createHash('sha256').update(extracted.normalizedBody, 'utf8').digest('hex');
}

export function computeNormalizedScriptSha256(scriptSource) {
  const normalized = normalizeText(scriptSource);
  if (normalized === null) return null;
  const trimmed = normalized.trim();
  if (trimmed.length === 0) return null;
  return createHash('sha256').update(trimmed, 'utf8').digest('hex');
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
  if (repository !== 'github/gh-aw' || !semverMatch || !isHex40(pinnedRelease.commit)) {
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
      const trimmedPart = part.trim();
      if (trimmedPart.startsWith('[') || trimmedPart.startsWith('{')) return {ok: false};
      const item = parseScalar(trimmedPart);
      if (!item.ok) return {ok: false};
      list.push(item.value);
    }
    return {ok: true, value: list};
  }
  if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) {
    let unescaped = '';
    for (let i = 1; i < token.length - 1; i++) {
      if (token[i] === "'") {
        if (token[i + 1] !== "'" || i + 1 >= token.length - 1) return {ok: false};
        unescaped += "'";
        i++;
      } else {
        unescaped += token[i];
      }
    }
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

function extractLockMetadata(normalizedLock) {
  let metadata = null;
  let legacyHash = null;
  const customHeaders = Object.create(null);
  const lines = normalizedLock.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith('#')) break;
    const commentBody = trimmed.slice(1).trim();
    if (commentBody.startsWith('gh-aw-metadata:')) {
      if (metadata !== null) return {ok: false, reason: 'INVALID_LOCK_METADATA'};
      const jsonText = commentBody.slice('gh-aw-metadata:'.length).trim();
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        return {ok: false, reason: 'INVALID_LOCK_METADATA'};
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Object.getPrototypeOf(parsed) !== Object.prototype || Object.hasOwn(parsed, '__proto__')) {
        return {ok: false, reason: 'INVALID_LOCK_METADATA'};
      }
      metadata = parsed;
      continue;
    }
    if (commentBody.startsWith('frontmatter-hash:')) {
      if (legacyHash !== null) return {ok: false, reason: 'INVALID_LOCK_METADATA'};
      const candidate = commentBody.slice('frontmatter-hash:'.length).trim();
      if (!isHex64(candidate)) return {ok: false, reason: 'FRONTMATTER_HASH_MISSING'};
      legacyHash = candidate;
      continue;
    }
    const kvMatch = /^(gh-aw-[a-z0-9-]+):\s*(\S+)$/.exec(commentBody);
    if (kvMatch && kvMatch[1] !== 'gh-aw-manifest') {
      if (Object.hasOwn(customHeaders, kvMatch[1])) return {ok: false, reason: 'INVALID_LOCK_METADATA'};
      customHeaders[kvMatch[1]] = kvMatch[2];
    }
  }
  return {ok: true, metadata, legacyHash, customHeaders};
}

function tokenizeIfExpression(inner) {
  const tokens = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === ' ' || ch === '\n') {
      i++;
      continue;
    }
    if (tokens.length >= MAX_IF_TOKENS) return null;
    const pair = inner.slice(i, i + 2);
    if (pair === '&&' || pair === '||' || pair === '==' || pair === '!=') {
      tokens.push({type: pair, value: pair});
      i += 2;
      continue;
    }
    if (ch === '!' || ch === '(' || ch === ')' || ch === ',') {
      tokens.push({type: ch, value: ch});
      i++;
      continue;
    }
    if (ch === "'") {
      let str = '';
      i++;
      let closed = false;
      while (i < inner.length) {
        if (inner[i] === "'") {
          if (inner[i + 1] === "'") {
            str += "'";
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        str += inner[i];
        i++;
      }
      if (!closed) return null;
      tokens.push({type: 'str', value: str});
      continue;
    }
    const identMatch = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(inner.slice(i));
    if (identMatch) {
      const word = identMatch[0];
      if (word === 'true' || word === 'false') {
        tokens.push({type: 'bool', value: word === 'true'});
      } else {
        tokens.push({type: 'ident', value: word});
      }
      i += word.length;
      continue;
    }
    const numMatch = /^(?:0|[1-9]\d*)/.exec(inner.slice(i));
    if (numMatch) {
      const n = Number(numMatch[0]);
      if (!Number.isSafeInteger(n)) return null;
      tokens.push({type: 'num', value: n});
      i += numMatch[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

function parseIfExpression(rawCondition) {
  if (rawCondition === false) return {kind: 'Literal', value: false};
  if (typeof rawCondition !== 'string') return null;
  const trimmed = rawCondition.trim();
  if (trimmed.length === 0) return null;
  let inner = trimmed;
  if (trimmed.includes('${{') || trimmed.includes('}}')) {
    if (!trimmed.startsWith('${{') || !trimmed.endsWith('}}')) return null;
    inner = trimmed.slice(3, -2).trim();
    if (inner.length === 0) return null;
  }
  const tokens = tokenizeIfExpression(inner);
  if (tokens === null || tokens.length === 0) return null;

  let pos = 0;
  function parseOr(depth) {
    if (depth > MAX_IF_DEPTH) return null;
    let left = parseAnd(depth);
    if (left === null) return null;
    while (pos < tokens.length && tokens[pos].type === '||') {
      pos++;
      const right = parseAnd(depth + 1);
      if (right === null) return null;
      left = {kind: 'Or', left, right};
    }
    return left;
  }
  function parseAnd(depth) {
    if (depth > MAX_IF_DEPTH) return null;
    let left = parseNot(depth);
    if (left === null) return null;
    while (pos < tokens.length && tokens[pos].type === '&&') {
      pos++;
      const right = parseNot(depth);
      if (right === null) return null;
      left = {kind: 'And', left, right};
    }
    return left;
  }
  function parseNot(depth) {
    if (depth > MAX_IF_DEPTH) return null;
    if (pos < tokens.length && tokens[pos].type === '!') {
      pos++;
      const expr = parseNot(depth + 1);
      return expr === null ? null : {kind: 'Not', expr};
    }
    return parseCompare(depth);
  }
  function parseCompare(depth) {
    const left = parsePrimary(depth);
    if (left === null) return null;
    if (pos < tokens.length && (tokens[pos].type === '==' || tokens[pos].type === '!=')) {
      const op = tokens[pos].type;
      pos++;
      const right = parsePrimary(depth + 1);
      if (right === null) return null;
      if (pos < tokens.length && (tokens[pos].type === '==' || tokens[pos].type === '!=')) return null;
      return {kind: 'Compare', op, left, right};
    }
    return left;
  }
  function parsePrimary(depth) {
    if (depth > MAX_IF_DEPTH || pos >= tokens.length) return null;
    const tok = tokens[pos];
    if (tok.type === '(') {
      pos++;
      const expr = parseOr(depth + 1);
      if (expr === null || pos >= tokens.length || tokens[pos].type !== ')') return null;
      pos++;
      return expr;
    }
    if (tok.type === 'str' || tok.type === 'bool' || tok.type === 'num') {
      pos++;
      return {kind: 'Literal', value: tok.value};
    }
    if (tok.type === 'ident') {
      pos++;
      if (pos < tokens.length && tokens[pos].type === '(') {
        if (tok.value.includes('.')) return null;
        pos++;
        const args = [];
        if (pos < tokens.length && tokens[pos].type !== ')') {
          while (true) {
            const arg = parseOr(depth + 1);
            if (arg === null) return null;
            args.push(arg);
            if (pos < tokens.length && tokens[pos].type === ',') {
              pos++;
              continue;
            }
            break;
          }
        }
        if (pos >= tokens.length || tokens[pos].type !== ')') return null;
        pos++;
        return {kind: 'Call', name: tok.value.toLowerCase(), args};
      }
      return {kind: 'Ident', path: tok.value};
    }
    return null;
  }

  const ast = parseOr(0);
  return ast !== null && pos === tokens.length ? ast : null;
}

function collectMandatoryConjuncts(node) {
  if (node.kind === 'And') {
    return [...collectMandatoryConjuncts(node.left), ...collectMandatoryConjuncts(node.right)];
  }
  return [node];
}

function astHasBypassCall(node) {
  if (node.kind === 'Call') {
    return BYPASS_CALL_NAMES.has(node.name) || node.args.some(astHasBypassCall);
  }
  if (node.kind === 'And' || node.kind === 'Or' || node.kind === 'Compare') {
    return astHasBypassCall(node.left) || astHasBypassCall(node.right);
  }
  if (node.kind === 'Not') return astHasBypassCall(node.expr);
  return false;
}

function isIdentCompareLiteral(node, op, expectedPath, expectedLiteral) {
  if (node.kind !== 'Compare' || node.op !== op) return false;
  if (node.left.kind === 'Ident' && node.right.kind === 'Literal') {
    return node.left.path === expectedPath && node.right.value === expectedLiteral;
  }
  if (node.right.kind === 'Ident' && node.left.kind === 'Literal') {
    return node.right.path === expectedPath && node.left.value === expectedLiteral;
  }
  return false;
}

function isNotEndsWithBot(node) {
  if (node.kind !== 'Not' || node.expr.kind !== 'Call' || node.expr.name !== 'endswith') return false;
  const args = node.expr.args;
  return args.length === 2 &&
    args[0].kind === 'Ident' && args[0].path === 'github.actor' &&
    args[1].kind === 'Literal' && args[1].value === '[bot]';
}

function verifyEvaluationGuards(rawIf) {
  const ast = parseIfExpression(rawIf);
  if (ast === null || astHasBypassCall(ast)) {
    return {ok: false, reason: 'MISSING_DEFAULT_OFF_GUARD'};
  }
  const conjuncts = collectMandatoryConjuncts(ast);
  const hasEnable = conjuncts.some(c => isIdentCompareLiteral(c, '==', 'vars.FACTORY_GHAW_ENABLED', 'true'));
  if (!hasEnable) return {ok: false, reason: 'MISSING_DEFAULT_OFF_GUARD'};

  const hasEndsWithBot = conjuncts.some(isNotEndsWithBot);
  const hasExplicitBotExclusions =
    conjuncts.some(c => isIdentCompareLiteral(c, '!=', 'github.actor', 'copilot-swe-agent[bot]')) &&
    conjuncts.some(c => isIdentCompareLiteral(c, '!=', 'github.actor', 'github-actions[bot]'));
  if (!hasEndsWithBot && !hasExplicitBotExclusions) {
    return {ok: false, reason: 'MISSING_BOT_LOOP_GUARD'};
  }
  return {ok: true};
}

function isAlwaysZeroArgCall(node) {
  return node.kind === 'Call' && node.name === 'always' && node.args.length === 0;
}

function astHasUnsafeStatusOverride(node, negated = false) {
  if (node.kind === 'Not') return astHasUnsafeStatusOverride(node.expr, !negated);
  if (node.kind === 'Call') {
    if (node.name === 'failure') return true;
    if (node.name === 'cancelled' && !negated) return true;
    return node.args.some(arg => astHasUnsafeStatusOverride(arg, false));
  }
  if (node.kind === 'And' || node.kind === 'Or' || node.kind === 'Compare') {
    return astHasUnsafeStatusOverride(node.left, false) || astHasUnsafeStatusOverride(node.right, false);
  }
  return false;
}

const STEP_OUTPUT_REF_RE = /^\$\{\{\s*steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.[A-Za-z_][A-Za-z0-9_-]*\s*\}\}$/;
const STEP_OUTCOME_REF_RE = /^\$\{\{\s*steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outcome\s*\}\}$/;
const DETECTION_GUARD_REF_RE = /^\$\{\{\s*steps\.detection_guard\.outputs\.run_detection\s*\}\}$/;
const NEEDS_OUTPUT_TYPES_REF_RE = /^\$\{\{\s*needs\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.output_types\s*\}\}$/;
const NEEDS_HAS_PATCH_REF_RE = /^\$\{\{\s*needs\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.has_patch\s*\}\}$/;
const PINNED_GHAW_DETECTION_GUARD_RUN_SHA256 =
  'cd263ee1576f187c6631de7e4e336dfadb2b8f71404f70dfccaa319b2530af44';
const UNCONDITIONAL_DETECTION_GUARD_RUN_SHA256 =
  '09fc5d5793d63171201ff6034a92a2c9201437b57dcbcb6f3cfbfa0621fd8f19';
const PINNED_CLEAR_AGENT_USAGE_RUN_SHA256 =
  'c93a5242d91f278481809a338d359e8c976f21e030dbbd395410c7eec1a5d4f7';
const PINNED_SHADOW_RECONCILE_OPTIN_RUN_SHA256 =
  'fb54fe1118f487e97b5c0ae0941ff48f484ab1f76ad6cace70d9464290a84949';
const THREAT_DETECT_FLAG_RE = /^--[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THREAT_DETECT_VAL_RE = /^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/;
const SIMPLE_POSIX_TEST_LINE_RE = /^test "\$[A-Z][A-Z0-9_]*" = [A-Za-z0-9_./-]+$/;
const VALID_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isStrictThreatDetectCommand(cmdText) {
  if (cmdText.includes('\n')) return false;
  const tokens = cmdText.trim().split(' ').filter(tok => tok.length > 0);
  if (tokens.length === 0 || tokens[0] !== 'threat-detect') return false;
  let idx = 1;
  while (idx < tokens.length) {
    if (!THREAT_DETECT_FLAG_RE.test(tokens[idx])) return false;
    idx++;
    if (idx < tokens.length && !tokens[idx].startsWith('-')) {
      if (!THREAT_DETECT_VAL_RE.test(tokens[idx])) return false;
      idx++;
    }
  }
  return true;
}
const PINNED_REDACTION_SCRIPT_SHA256S = new Set([
  '26a88c8a5717600f5fd310e6421561c072ac7381d95edfd5fc081bc82fcc93be',
  'bf99a81555fbc952f9f2173d234c6071a0fa01ba181cb046fc12f88ef7294ff3'
]);
const VERIFIED_SCAN_OUTPUT_KEYS = Object.freeze(['scan_verified', 'detection_success', 'detection_conclusion']);
const FORBIDDEN_SCAN_ENV_KEYS = new Set([
  'node_options',
  'node_path',
  'runner_temp',
  'path',
  'bash_env',
  'env',
  'ld_preload',
  'ld_library_path',
  'shellopts',
  'bashopts',
  'ps4',
  'ifs',
  'home'
]);
const ALLOWED_CHECKOUT_WITH_KEYS = new Set([
  'persist-credentials',
  'repository',
  'ref',
  'fetch-depth',
  'clean',
  'sparse-checkout',
  'sparse-checkout-cone-mode',
  'submodules',
  'lfs',
  'path',
  'filter',
  'show-progress'
]);

function hasInputEnvOverride(envValue) {
  return isMapObject(envValue) &&
    Object.keys(envValue).some(key => key.toLowerCase().startsWith('input_'));
}

function isSafeScanEnv(envValue) {
  if (envValue === undefined) return true;
  if (!isMapObject(envValue)) return false;
  return Object.keys(envValue).every(key => {
    if (!VALID_ENV_KEY_RE.test(key)) return false;
    const lower = key.toLowerCase();
    return !lower.startsWith('input_') &&
      !lower.startsWith('bash_func_') &&
      !lower.startsWith('github_') &&
      !lower.startsWith('npm_config_') &&
      !FORBIDDEN_SCAN_ENV_KEYS.has(lower);
  });
}

function normalizeCheckoutWith(withMap) {
  if (!isMapObject(withMap)) return null;
  const normalized = Object.create(null);
  for (const [key, value] of Object.entries(withMap)) {
    const lower = key.toLowerCase();
    if (!ALLOWED_CHECKOUT_WITH_KEYS.has(lower) || Object.hasOwn(normalized, lower)) {
      return null;
    }
    normalized[lower] = value;
  }
  return normalized;
}

function resolveValidDetectionGuardDep(step) {
  const guardDigest = computeNormalizedScriptSha256(step.run);
  if (guardDigest === UNCONDITIONAL_DETECTION_GUARD_RUN_SHA256) return '*';
  if (guardDigest !== PINNED_GHAW_DETECTION_GUARD_RUN_SHA256 ||
      !isMapObject(step.env) ||
      Object.keys(step.env).length !== 2 ||
      typeof step.env.OUTPUT_TYPES !== 'string' ||
      typeof step.env.HAS_PATCH !== 'string') {
    return null;
  }
  const outMatch = NEEDS_OUTPUT_TYPES_REF_RE.exec(step.env.OUTPUT_TYPES.trim());
  const patchMatch = NEEDS_HAS_PATCH_REF_RE.exec(step.env.HAS_PATCH.trim());
  if (outMatch === null || patchMatch === null || outMatch[1] !== patchMatch[1]) {
    return null;
  }
  return outMatch[1];
}

const ALLOWED_SETUP_NODE_WITH_KEYS = new Set(['node-version', 'package-manager-cache', 'check-latest']);

function isSafeSetupStepBeforePolicyScan(step, usesLower) {
  if (step.if !== undefined || step.env !== undefined) return false;
  if (usesLower.startsWith('actions/checkout@')) return true;
  if (!usesLower.startsWith('actions/setup-node@')) return false;
  if (step.with === undefined) return true;
  if (!isMapObject(step.with)) return false;
  const seen = new Set();
  for (const [key, value] of Object.entries(step.with)) {
    const lower = key.toLowerCase();
    if (!ALLOWED_SETUP_NODE_WITH_KEYS.has(lower) || seen.has(lower)) return false;
    if (lower === 'package-manager-cache' && value !== false) return false;
    seen.add(lower);
  }
  return true;
}

function hasFailClosedPosixRefPreamble(runText, expectedBranchRef) {
  const lines = runText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  if (lines.length < 3 || lines[0] !== 'set -euo pipefail') return false;
  let sawRef = false;
  let sawProtected = false;
  for (let i = 1; i < lines.length; i++) {
    if (!SIMPLE_POSIX_TEST_LINE_RE.test(lines[i])) break;
    if (lines[i] === `test "$GITHUB_REF" = ${expectedBranchRef}`) sawRef = true;
    if (lines[i] === 'test "$GITHUB_REF_PROTECTED" = true') sawProtected = true;
    if (sawRef && sawProtected) return true;
  }
  return false;
}

function resolveJobProtectedBranchProvenance(job, jobAst, expectedBranchRef, outerEnvSafe) {
  if (!outerEnvSafe || toleratesError(job) || job.defaults !== undefined || job.container !== undefined ||
      !isSafeScanEnv(job.env) || jobAst === null || astHasBypassCall(jobAst) || !Array.isArray(job.steps)) {
    return {jobWideForDownstream: false, trustedCheckoutStepIndices: new Set()};
  }
  const conjuncts = collectMandatoryConjuncts(jobAst);
  const hasRef = conjuncts.some(c => isIdentCompareLiteral(c, '==', 'github.ref', expectedBranchRef));
  const hasProtected = conjuncts.some(c =>
    isIdentCompareLiteral(c, '==', 'github.ref_protected', true) ||
    isIdentCompareLiteral(c, '==', 'github.ref_protected', 'true')
  );
  if (!hasRef || !hasProtected) {
    return {jobWideForDownstream: false, trustedCheckoutStepIndices: new Set()};
  }

  let jobWideForDownstream = false;
  let preambleCompleted = false;
  let onlyInertSetupSoFar = true;
  const pendingInertCheckoutIndices = [];
  const guardOutputStepIds = new Set();
  const trustedCheckoutStepIndices = new Set();
  for (let idx = 0; idx < job.steps.length; idx++) {
    const step = job.steps[idx];
    const usesLower = typeof step.uses === 'string' ? step.uses.toLowerCase() : null;
    if (usesLower !== null && usesLower.startsWith('actions/checkout@')) {
      if (preambleCompleted) {
        trustedCheckoutStepIndices.add(idx);
      } else if (typeof step.if === 'string') {
        const stepAst = parseIfExpression(step.if);
        if (stepAst !== null && !astHasBypassCall(stepAst)) {
          const stepConjuncts = collectMandatoryConjuncts(stepAst);
          const gatedByPriorOptin = [...guardOutputStepIds].some(guardId =>
            stepConjuncts.some(c =>
              isIdentCompareLiteral(c, '==', `steps.${guardId}.outputs.enabled`, 'true')
            )
          );
          if (gatedByPriorOptin) trustedCheckoutStepIndices.add(idx);
        }
      } else if (onlyInertSetupSoFar) {
        pendingInertCheckoutIndices.push(idx);
      }
    }
    if (usesLower !== null) {
      const normalizedWith = usesLower.startsWith('actions/checkout@') ? normalizeCheckoutWith(step.with) : null;
      const inertSetup = !toleratesError(step) &&
        isSafeSetupStepBeforePolicyScan(step, usesLower) &&
        (!usesLower.startsWith('actions/checkout@') ||
          (normalizedWith !== null && normalizedWith['persist-credentials'] === false && normalizedWith.path === undefined));
      if (!inertSetup) {
        onlyInertSetupSoFar = false;
        pendingInertCheckoutIndices.length = 0;
      }
      continue;
    }
    if (typeof step.run !== 'string' || toleratesError(step) || step.if !== undefined ||
        step['working-directory'] !== undefined ||
        (step.shell !== undefined && step.shell !== 'bash') ||
        !isSafeScanEnv(step.env)) {
      onlyInertSetupSoFar = false;
      pendingInertCheckoutIndices.length = 0;
      continue;
    }
    if (hasFailClosedPosixRefPreamble(step.run, expectedBranchRef)) {
      jobWideForDownstream = true;
      preambleCompleted = true;
      if (onlyInertSetupSoFar) {
        for (const pendingIdx of pendingInertCheckoutIndices) {
          trustedCheckoutStepIndices.add(pendingIdx);
        }
      }
    }
    if (expectedBranchRef === 'refs/heads/main' && typeof step.id === 'string' &&
        computeNormalizedScriptSha256(step.run) === PINNED_SHADOW_RECONCILE_OPTIN_RUN_SHA256) {
      guardOutputStepIds.add(step.id);
    }
    onlyInertSetupSoFar = false;
    pendingInertCheckoutIndices.length = 0;
  }
  return {jobWideForDownstream, trustedCheckoutStepIndices};
}

function isValidRedactionStep(step, usesLower) {
  if (step.if === undefined || !usesLower.startsWith('actions/github-script@') ||
      !isMapObject(step.with) || Object.keys(step.with).length !== 1 ||
      typeof step.with.script !== 'string' || step.with.script.includes('${{')) {
    return false;
  }
  const digest = computeNormalizedScriptSha256(step.with.script);
  return digest !== null && PINNED_REDACTION_SCRIPT_SHA256S.has(digest);
}

function isDetectionGuardCompare(node, expectedLiteral) {
  return isIdentCompareLiteral(node, '==', 'steps.detection_guard.outputs.run_detection', expectedLiteral);
}

function isStepOutcomeSuccess(node, stepId) {
  return isIdentCompareLiteral(node, '==', `steps.${stepId}.outcome`, 'success');
}

function isCompilerDetectionStepIf(ast) {
  const conjuncts = collectMandatoryConjuncts(ast);
  return conjuncts.length === 2 &&
    isAlwaysZeroArgCall(conjuncts[0]) &&
    isDetectionGuardCompare(conjuncts[1], 'true');
}

function isCompilerDetectionConclusionIf(ast) {
  if (ast.kind !== 'Or') return false;
  const skippedBranch = collectMandatoryConjuncts(ast.left);
  const redactedBranch = collectMandatoryConjuncts(ast.right);
  return skippedBranch.length === 2 &&
    isAlwaysZeroArgCall(skippedBranch[0]) &&
    isDetectionGuardCompare(skippedBranch[1], 'false') &&
    redactedBranch.length === 4 &&
    isAlwaysZeroArgCall(redactedBranch[0]) &&
    isDetectionGuardCompare(redactedBranch[1], 'true') &&
    isStepOutcomeSuccess(redactedBranch[2], 'redact_detection_logs') &&
    isStepOutcomeSuccess(redactedBranch[3], 'redact_detection_artifacts');
}

function isAllowedThreatScanStepIf(step, stepAst) {
  if (step.id === 'redact_detection_logs' || step.id === 'redact_detection_artifacts') {
    return isCompilerDetectionStepIf(stepAst);
  }
  if (step.id === 'detection_conclusion') {
    return isCompilerDetectionConclusionIf(stepAst);
  }
  return isAlwaysZeroArgCall(stepAst);
}

function isValidGhAwSetupStep(step, usesLower, releaseCommit) {
  if (usesLower !== `github/gh-aw/actions/setup@${releaseCommit}` || step.if !== undefined) {
    return false;
  }
  if (step.with === undefined) return true;
  if (!isMapObject(step.with)) return false;
  return Object.entries(step.with).every(([key, val]) =>
    key.toLowerCase() !== 'destination' ||
    (typeof val === 'string' && val.trim() === '${{ runner.temp }}/gh-aw/actions')
  );
}

function isValidActionConclusionProducer(
  step,
  precedingUnconditionalStepIds,
  precedingDetectionPrereqs,
  trustedDetectionDigests
) {
  if (step.id !== 'detection_conclusion' ||
      step.if === undefined ||
      !precedingDetectionPrereqs.actionsTamperFree ||
      !precedingDetectionPrereqs.hasValidGuard ||
      !precedingDetectionPrereqs.hasRedactLogs ||
      !precedingDetectionPrereqs.hasRedactArtifacts ||
      typeof step.uses !== 'string' ||
      !step.uses.toLowerCase().startsWith('actions/github-script@') ||
      !isMapObject(step.env) ||
      Object.keys(step.env).length !== 3 ||
      step.env.GH_AW_DETECTION_CONTINUE_ON_ERROR !== 'false' ||
      typeof step.env.RUN_DETECTION !== 'string' ||
      !DETECTION_GUARD_REF_RE.test(step.env.RUN_DETECTION.trim()) ||
      typeof step.env.DETECTION_AGENTIC_EXECUTION_OUTCOME !== 'string' ||
      !isMapObject(step.with) ||
      Object.keys(step.with).length !== 1 ||
      typeof step.with.script !== 'string' ||
      step.with.script.includes('${{')) {
    return false;
  }
  const scriptDigest = computeNormalizedScriptSha256(step.with.script);
  if (scriptDigest === null || !trustedDetectionDigests.has(scriptDigest)) {
    return false;
  }
  if ((scriptDigest === PINNED_GHAW_DETECTION_CONCLUSION_SCRIPT_SHA256 ||
       step.with.script.includes('RUNNER_TEMP')) &&
      !precedingDetectionPrereqs.hasGhAwSetup) {
    return false;
  }
  const outcomeMatch = STEP_OUTCOME_REF_RE.exec(step.env.DETECTION_AGENTIC_EXECUTION_OUTCOME.trim());
  return outcomeMatch !== null && precedingUnconditionalStepIds.has(outcomeMatch[1]);
}

function declaresVerifiedStepOutput(job, outputName, validScanOutputStepIds) {
  if (!isMapObject(job.outputs) || typeof job.outputs[outputName] !== 'string') {
    return false;
  }
  const match = STEP_OUTPUT_REF_RE.exec(job.outputs[outputName].trim());
  return match !== null && validScanOutputStepIds.has(match[1]);
}

function isValidIssuesLabel(label) {
  return typeof label === 'string' &&
    label.length >= 1 &&
    label.length <= 33 &&
    Buffer.byteLength(label, 'utf8') <= 33 &&
    /\S/.test(label);
}
function toleratesError(entity) {
  return entity['continue-on-error'] !== undefined && entity['continue-on-error'] !== false;
}

function isValidWorkQueueMemoryConfig(memory) {
  if (!isMapObject(memory)) return false;
  const keys = Object.keys(memory);
  if (!keys.every(key => ALLOWED_WORK_QUEUE_MEMORY_KEYS.has(key))) return false;
  if (!REQUIRED_WORK_QUEUE_MEMORY_KEYS.every(key => Object.hasOwn(memory, key))) return false;
  if (typeof memory.path !== 'string' || memory.path.length === 0 || memory.path.length > 256 ||
      memory.path.startsWith('/') || memory.path.includes('\\') || memory.path.includes('..')) {
    return false;
  }
  if (typeof memory['target-repo'] !== 'string' || memory['target-repo'].includes('..') ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(memory['target-repo'])) {
    return false;
  }
  if (!isHex40(memory['base-revision']) && !isHex64(memory['base-revision'])) {
    return false;
  }
  if (typeof memory['branch-prefix'] !== 'string' || memory['branch-prefix'].length === 0 ||
      memory['branch-prefix'].length > 120) {
    return false;
  }
  if (!isMapObject(memory.schema)) return false;
  if (memory.name !== undefined &&
      (typeof memory.name !== 'string' || memory.name.length > 64 || !/^[A-Za-z][A-Za-z_0-9]*$/.test(memory.name))) {
    return false;
  }
  if (memory['max-bytes'] !== undefined &&
      (!Number.isSafeInteger(memory['max-bytes']) || memory['max-bytes'] < 1 || memory['max-bytes'] > 262144)) {
    return false;
  }
  return true;
}

function isValidWorkQueueToolConfig(workQueue) {
  if (workQueue === true) return true;
  if (!isMapObject(workQueue)) return false;
  for (const [key, value] of Object.entries(workQueue)) {
    if (!ALLOWED_WORK_QUEUE_TOOL_KEYS.has(key)) return false;
    if ((key === 'require-assignment' || key === 'worker') && typeof value !== 'boolean') return false;
    if (key === 'issues' && typeof value !== 'boolean' &&
        (!isMapObject(value) || Object.keys(value).some(k => k !== 'label' || !isValidIssuesLabel(value[k])))) {
      return false;
    }
    if (key === 'memory' && !isValidWorkQueueMemoryConfig(value)) return false;
  }
  return true;
}

function inspectFrontmatterPolicy(frontmatter, isNewerVerified, headers, options) {
  const safeOutputs = frontmatter['safe-outputs'];
  if (safeOutputs !== undefined) {
    if (Array.isArray(safeOutputs)) {
      if (safeOutputs.includes('merge-pull-request')) return {ok: false, reason: 'MAIN_MERGE_FORBIDDEN_IN_GHAW'};
    } else if (isMapObject(safeOutputs)) {
      if (Object.hasOwn(safeOutputs, 'merge-pull-request') && safeOutputs['merge-pull-request'] !== false) {
        return {ok: false, reason: 'MAIN_MERGE_FORBIDDEN_IN_GHAW'};
      }
    } else {
      return {ok: false, reason: 'INVALID_FRONTMATTER'};
    }
  }

  if (Object.hasOwn(frontmatter, 'work-queue') || Object.hasOwn(frontmatter, 'protocol')) {
    return {ok: false, reason: 'INVALID_FRONTMATTER'};
  }
  if (isMapObject(frontmatter.tools) && Object.hasOwn(frontmatter.tools, 'work-queue') &&
      !isValidWorkQueueToolConfig(frontmatter.tools['work-queue'])) {
    return {ok: false, reason: 'INVALID_FRONTMATTER'};
  }

  const frontmatterGuards = verifyEvaluationGuards(frontmatter.if);
  if (!frontmatterGuards.ok) return frontmatterGuards;

  const headerProtocol = headers['gh-aw-work-queue-protocol'];
  const requestedProtocol = options.workQueueProtocol;
  if (requestedProtocol !== undefined && headerProtocol !== undefined && requestedProtocol !== headerProtocol) {
    return {ok: false, reason: 'WORK_QUEUE_PROTOCOL_UNSUPPORTED'};
  }
  const protocol = requestedProtocol ?? headerProtocol ?? 'v3';
  if (protocol !== 'v3' && protocol !== 'v4') {
    return {ok: false, reason: 'WORK_QUEUE_PROTOCOL_UNSUPPORTED'};
  }
  if (protocol === 'v4' && !isNewerVerified) {
    return {ok: false, reason: 'WORK_QUEUE_PROTOCOL_UNSUPPORTED'};
  }

  const headerRef = headers['gh-aw-work-queue-ref'];
  const requestedRef = options.workQueueRef;
  if (requestedRef !== undefined && headerRef !== undefined && requestedRef !== headerRef) {
    return {ok: false, reason: 'INVALID_WORK_QUEUE_BRANCH'};
  }
  const resolvedRef = requestedRef ?? headerRef ?? 'refs/heads/work-queue';
  if (resolvedRef !== 'refs/heads/work-queue' && resolvedRef !== 'work-queue') {
    return {ok: false, reason: 'INVALID_WORK_QUEUE_BRANCH'};
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

function isHelperReadOnlyPermissions(perms) {
  if (!isMapObject(perms)) return false;
  return Object.entries(perms).every(([scope, level]) =>
    ALLOWED_HELPER_READ_SCOPES.has(scope) && level === 'read');
}

function isTrustedControlPlaneCheckout(withMap, releaseCommit, trustedShas) {
  const repoOpt = withMap.repository;
  if (repoOpt !== undefined) {
    if (typeof repoOpt !== 'string') return false;
    const trimmedRepo = repoOpt.trim();
    if (trimmedRepo.toLowerCase() === 'github/gh-aw') {
      return withMap.ref === releaseCommit;
    }
    if (trimmedRepo !== 'Jamula/SoftwareFactory' && trimmedRepo !== '${{ github.repository }}') {
      return false;
    }
  }
  if (typeof withMap.ref !== 'string') return false;
  const trimmedRef = withMap.ref.trim();
  return trimmedRef === 'refs/heads/main' || trustedShas.has(trimmedRef);
}

function isTrustedScanJobCheckout(checkoutWith, releaseCommit, trustedShas, lockOn) {
  if (checkoutWith.path !== undefined) return {ok: false, needsUpstreamRefProvenance: false};
  if (checkoutWith.ref === undefined && checkoutWith.repository === undefined) {
    const safeTriggerSet = !Object.hasOwn(lockOn, 'pull_request') &&
      !Object.hasOwn(lockOn, 'pull_request_target') &&
      !Object.hasOwn(lockOn, 'pull_request_review');
    return {ok: safeTriggerSet, needsUpstreamRefProvenance: true};
  }
  return {
    ok: isTrustedControlPlaneCheckout(checkoutWith, releaseCommit, trustedShas),
    needsUpstreamRefProvenance: false
  };
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
  const optionalKeys = [
    'pinnedRelease',
    'workQueueProtocol',
    'workQueueRef',
    'trustedControlPlaneShas',
    'trustedDetectionScriptSha256s',
    'trustedPolicyScanRunSha256s'
  ];
  if (!isPlainRecord(input, ['markdownSource', 'lockYamlSource'], optionalKeys)) {
    return deny('INVALID_LOCK_INPUT');
  }
  if ((input.trustedControlPlaneShas !== undefined && !isDenseHexArray(input.trustedControlPlaneShas, isHex40)) ||
      (input.trustedDetectionScriptSha256s !== undefined && !isDenseHexArray(input.trustedDetectionScriptSha256s, isHex64)) ||
      (input.trustedPolicyScanRunSha256s !== undefined && !isDenseHexArray(input.trustedPolicyScanRunSha256s, isHex64))) {
    return deny('INVALID_LOCK_INPUT');
  }
  const trustedShas = new Set(input.trustedControlPlaneShas ?? []);
  const trustedDetectionDigests = new Set([
    PINNED_GHAW_DETECTION_CONCLUSION_SCRIPT_SHA256,
    ...(input.trustedDetectionScriptSha256s ?? [])
  ]);
  const trustedPolicyScanDigests = new Set([
    PINNED_FACTORY_POLICY_SCAN_RUN_SHA256,
    ...(input.trustedPolicyScanRunSha256s ?? [])
  ]);
  const normalizedLock = normalizeText(input.lockYamlSource);
  if (normalizedLock === null || normalizeText(input.markdownSource) === null) {
    return deny('INVALID_LOCK_INPUT');
  }

  const releaseCheck = resolvePinnedRelease(input.pinnedRelease);
  if (!releaseCheck.ok) return deny(releaseCheck.reason);

  const extracted = extractFrontmatterParts(input.markdownSource);
  if (extracted === null || extracted.parsedFrontmatter === null) return deny('INVALID_FRONTMATTER');
  const frontmatter = extracted.parsedFrontmatter;

  const computedSha256 = createHash('sha256').update(extracted.canonicalJson, 'utf8').digest('hex');
  const computedBodySha256 = createHash('sha256').update(extracted.normalizedBody, 'utf8').digest('hex');

  const headerInfo = extractLockMetadata(normalizedLock);
  if (!headerInfo.ok) return deny(headerInfo.reason);
  const {metadata, legacyHash, customHeaders} = headerInfo;

  if (metadata !== null) {
    if (!SUPPORTED_METADATA_SCHEMAS.has(metadata.schema_version) ||
        (metadata.strict !== undefined && typeof metadata.strict !== 'boolean') ||
        (metadata.dry_run !== undefined && typeof metadata.dry_run !== 'boolean') ||
        (metadata.compiler_version !== undefined && typeof metadata.compiler_version !== 'string') ||
        (metadata.body_hash !== undefined && !isHex64(metadata.body_hash))) {
      return deny('INVALID_LOCK_METADATA');
    }
    if (!isHex64(metadata.frontmatter_hash)) return deny('FRONTMATTER_HASH_MISSING');
    if (metadata.frontmatter_hash !== computedSha256) return deny('FRONTMATTER_HASH_MISMATCH');
    if (metadata.body_hash !== undefined && metadata.body_hash !== computedBodySha256) {
      return deny('BODY_HASH_MISMATCH');
    }
    if (metadata.compiler_version !== undefined && metadata.compiler_version !== releaseCheck.release.version) {
      return deny('PINNED_RELEASE_MISMATCH');
    }
  } else if (legacyHash !== null) {
    if (legacyHash !== computedSha256) return deny('FRONTMATTER_HASH_MISMATCH');
  } else {
    return deny('FRONTMATTER_HASH_MISSING');
  }

  if ((customHeaders['gh-aw-version'] !== undefined && customHeaders['gh-aw-version'] !== releaseCheck.release.version) ||
      (customHeaders['gh-aw-commit'] !== undefined && customHeaders['gh-aw-commit'] !== releaseCheck.release.commit)) {
    return deny('PINNED_RELEASE_MISMATCH');
  }

  const policyCheck = inspectFrontmatterPolicy(frontmatter, releaseCheck.isNewerVerified, customHeaders, input);
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

  const helperJobs = [];
  const evaluationJobIds = [];
  const threatScanJobs = [];
  const safeOutputJobs = [];
  const workflowEnvSafeForScan = lockDoc.defaults === undefined && isSafeScanEnv(lockDoc.env);

  for (const [jobId, job] of Object.entries(lockDoc.jobs)) {
    if (!isMapObject(job)) return deny('INVALID_LOCK_YAML');
    if (/merge[-_]pull[-_]request/i.test(jobId)) {
      return deny('MAIN_MERGE_FORBIDDEN_IN_GHAW');
    }
    const isHelper = HELPER_JOB_IDS.has(jobId);
    const isThreatScan = THREAT_SCAN_JOB_IDS.has(jobId);
    const isSafeOutput = jobId.startsWith('safe-outputs') || jobId.startsWith('safe_outputs');

    if (!isSafeOutput && toleratesError(job)) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
    if (isThreatScan && (!workflowEnvSafeForScan || job.defaults !== undefined ||
        job.container !== undefined || !isSafeScanEnv(job.env))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }

    if (job.uses !== undefined) {
      if (!isPinnedUses(job.uses)) return deny('UNPINNED_ACTION_REFERENCE');
      if (job.uses.toLowerCase().startsWith('github/gh-aw/') &&
          job.uses.slice(job.uses.indexOf('@') + 1) !== releaseCheck.release.commit) {
        return deny('PINNED_RELEASE_MISMATCH');
      }
    }

    const validScanOutputStepIds = new Set();
    const actionConclusionGuardDeps = new Map();
    const precedingUnconditionalScanStepIds = new Set();
    const precedingDetectionPrereqs = {
      hasGhAwSetup: false,
      actionsTamperFree: true,
      hasValidGuard: false,
      guardEvalDep: null,
      hasRedactLogs: false,
      hasRedactArtifacts: false
    };
    let scanNeedsRefProvenance = false;
    let jobHasWriteScope = false;
    if (isSafeOutput) {
      if (!isMapObject(job.permissions)) return deny('EXCESSIVE_SAFE_OUTPUT_PERMISSION');
      for (const [scope, level] of Object.entries(job.permissions)) {
        if (!ALLOWED_SAFE_OUTPUT_SCOPES.has(scope) || (level !== 'read' && level !== 'write') ||
            (level === 'write' && FORBIDDEN_SAFE_OUTPUT_WRITES.has(scope))) {
          return deny('EXCESSIVE_SAFE_OUTPUT_PERMISSION');
        }
        if (level === 'write') jobHasWriteScope = true;
      }
      safeOutputJobs.push({jobId, job, hasWriteScope: jobHasWriteScope});
    } else if (isHelper) {
      if (!isHelperReadOnlyPermissions(job.permissions)) return deny('AGENT_JOB_WRITE_PERMISSION');
      helperJobs.push({jobId, job});
    } else {
      const jobPerms = isReadOnlyPermissions(job.permissions);
      if (!jobPerms.ok) return deny('AGENT_JOB_WRITE_PERMISSION');
      if (isThreatScan) {
        threatScanJobs.push({
          jobId,
          job,
          validScanOutputStepIds,
          actionConclusionGuardDeps,
          getNeedsRefProvenance: () => scanNeedsRefProvenance
        });
      } else {
        evaluationJobIds.push({jobId, job});
      }
    }

    if (job.uses === undefined) {
      if (!Array.isArray(job.steps) || job.steps.length === 0) return deny('INVALID_LOCK_YAML');
      let hasUnconditionalThreatScanRunStep = false;
      let canRegisterPolicyScanProducer = true;
      for (const step of job.steps) {
        if (!isMapObject(step)) return deny('INVALID_LOCK_YAML');
        if (!isSafeOutput && toleratesError(step)) return deny('MISSING_THREAT_SCAN_GATE');
        if (isThreatScan && !isSafeScanEnv(step.env)) return deny('MISSING_THREAT_SCAN_GATE');
        if (isThreatScan && step.if !== undefined) {
          const stepAst = parseIfExpression(step.if);
          if (stepAst === null || !isAllowedThreatScanStepIf(step, stepAst)) {
            return deny('MISSING_THREAT_SCAN_GATE');
          }
        }
        if (stepAttemptsMainMerge(step)) return deny('MAIN_MERGE_FORBIDDEN_IN_GHAW');
        if (step.uses !== undefined) {
          if (!isPinnedUses(step.uses)) return deny('UNPINNED_ACTION_REFERENCE');
          const usesLower = step.uses.toLowerCase();
          if (usesLower.startsWith('github/gh-aw/') &&
              step.uses.slice(step.uses.indexOf('@') + 1) !== releaseCheck.release.commit) {
            return deny('PINNED_RELEASE_MISMATCH');
          }
          if (usesLower.startsWith('actions/checkout@')) {
            const checkoutWith = normalizeCheckoutWith(step.with);
            if (checkoutWith === null || checkoutWith['persist-credentials'] !== false) {
              return deny('CHECKOUT_CREDENTIALS_PERSISTED');
            }
            if (typeof checkoutWith.repository === 'string' &&
                checkoutWith.repository.toLowerCase() === 'github/gh-aw' &&
                checkoutWith.ref !== releaseCheck.release.commit) {
              return deny('PINNED_RELEASE_MISMATCH');
            }
            if (jobHasWriteScope &&
                (hasInputEnvOverride(lockDoc.env) || hasInputEnvOverride(job.env) || hasInputEnvOverride(step.env) ||
                 !isTrustedControlPlaneCheckout(checkoutWith, releaseCheck.release.commit, trustedShas))) {
              return deny('UNTRUSTED_SAFE_OUTPUT_CHECKOUT');
            }
            if (isThreatScan) {
              const scanCheckout = isTrustedScanJobCheckout(
                checkoutWith,
                releaseCheck.release.commit,
                trustedShas,
                lockDoc.on
              );
              if (!scanCheckout.ok) return deny('MISSING_THREAT_SCAN_GATE');
              if (scanCheckout.needsUpstreamRefProvenance) scanNeedsRefProvenance = true;
            }
          }
          if (isThreatScan) {
            const safeForPolicy = isSafeSetupStepBeforePolicyScan(step, usesLower);
            if (!safeForPolicy) {
              canRegisterPolicyScanProducer = false;
            }
            if (isValidGhAwSetupStep(step, usesLower, releaseCheck.release.commit)) {
              precedingDetectionPrereqs.hasGhAwSetup = true;
            } else if (step.id === 'redact_detection_logs' && isValidRedactionStep(step, usesLower)) {
              precedingDetectionPrereqs.hasRedactLogs = true;
            } else if (step.id === 'redact_detection_artifacts' && isValidRedactionStep(step, usesLower)) {
              precedingDetectionPrereqs.hasRedactArtifacts = true;
            } else if (step.id === 'detection_conclusion') {
              if (isValidActionConclusionProducer(
                step,
                precedingUnconditionalScanStepIds,
                precedingDetectionPrereqs,
                trustedDetectionDigests
              )) {
                validScanOutputStepIds.add(step.id);
                actionConclusionGuardDeps.set(step.id, precedingDetectionPrereqs.guardEvalDep);
              }
              precedingDetectionPrereqs.actionsTamperFree = false;
            } else if (!safeForPolicy) {
              precedingDetectionPrereqs.actionsTamperFree = false;
            }
          }
        }
        if (step.run !== undefined) {
          if (typeof step.run !== 'string' || step.run.includes('${{')) {
            return deny('UNSAFE_RUN_INTERPOLATION');
          }
          if (isThreatScan) {
            if (step['working-directory'] !== undefined ||
                (step.shell !== undefined && step.shell !== 'bash')) {
              return deny('MISSING_THREAT_SCAN_GATE');
            }
            const normalizedRunSha = computeNormalizedScriptSha256(step.run);
            let runSafeForDetectionModules = normalizedRunSha === PINNED_CLEAR_AGENT_USAGE_RUN_SHA256;
            if (step.id === 'detection_guard') {
              const guardDep = resolveValidDetectionGuardDep(step);
              if (guardDep !== null) {
                precedingDetectionPrereqs.hasValidGuard = true;
                precedingDetectionPrereqs.guardEvalDep = guardDep;
                runSafeForDetectionModules = true;
              }
            }
            if (step.if === undefined && step.run.trim().length > 0) {
              hasUnconditionalThreatScanRunStep = true;
              const isStrictThreatDetectCmd = isStrictThreatDetectCommand(step.run);
              const isTrustedPolicyRun = trustedPolicyScanDigests.has(normalizedRunSha);
              if (isStrictThreatDetectCmd || isTrustedPolicyRun) {
                runSafeForDetectionModules = true;
              }
              if (typeof step.id === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(step.id)) {
                precedingUnconditionalScanStepIds.add(step.id);
                if (canRegisterPolicyScanProducer && isTrustedPolicyRun) {
                  validScanOutputStepIds.add(step.id);
                }
              }
            }
            if (!runSafeForDetectionModules) {
              precedingDetectionPrereqs.actionsTamperFree = false;
            }
            canRegisterPolicyScanProducer = false;
          }
        }
      }
      if (isThreatScan) {
        if (!hasUnconditionalThreatScanRunStep) return deny('MISSING_THREAT_SCAN_GATE');
        if (job.outputs !== undefined) {
          if (!isMapObject(job.outputs)) return deny('MISSING_THREAT_SCAN_GATE');
          for (const verifiedKey of VERIFIED_SCAN_OUTPUT_KEYS) {
            if (Object.hasOwn(job.outputs, verifiedKey) &&
                !declaresVerifiedStepOutput(job, verifiedKey, validScanOutputStepIds)) {
              return deny('MISSING_THREAT_SCAN_GATE');
            }
          }
        }
      }
    }
  }

  const guardedHelperIds = new Set(
    helperJobs.filter(({job}) => verifyEvaluationGuards(job.if).ok).map(({jobId}) => jobId)
  );

  if (evaluationJobIds.length === 0) return deny('MISSING_EVALUATION_JOB');
  for (const {job} of evaluationJobIds) {
    const guardVerdict = verifyEvaluationGuards(job.if);
    if (guardVerdict.ok) continue;
    const evalNeeds = normalizeNeeds(job.needs);
    const matchingGuardedHelpers = evalNeeds === null ? [] : evalNeeds.filter(dep => guardedHelperIds.has(dep));
    if (matchingGuardedHelpers.length === 0) return deny(guardVerdict.reason);
    if (job.if !== undefined) {
      const evalAst = parseIfExpression(job.if);
      if (evalAst === null || astHasBypassCall(evalAst)) return deny(guardVerdict.reason);
      const evalConjuncts = collectMandatoryConjuncts(evalAst);
      const inheritsHelperSuccess = matchingGuardedHelpers.some(helperId =>
        evalConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${helperId}.result`, 'success')));
      if (!inheritsHelperSuccess) return deny(guardVerdict.reason);
    }
  }

  if (threatScanJobs.length === 0) return deny('MISSING_THREAT_SCAN_GATE');
  const evalJobIdSet = new Set(evaluationJobIds.map(entry => entry.jobId));
  const evalRefProvenanceIds = new Set(
    evaluationJobIds
      .filter(({job}) =>
        resolveJobProtectedBranchProvenance(job, parseIfExpression(job.if), 'refs/heads/main', workflowEnvSafeForScan).jobWideForDownstream
      )
      .map(({jobId}) => jobId)
  );
  const threatScanById = new Map(threatScanJobs.map(entry => [entry.jobId, entry]));
  for (const scanEntry of threatScanJobs) {
    const {job, validScanOutputStepIds, actionConclusionGuardDeps, getNeedsRefProvenance} = scanEntry;
    for (const [stepId, guardDep] of actionConclusionGuardDeps.entries()) {
      if (guardDep !== '*' && !evalJobIdSet.has(guardDep)) {
        validScanOutputStepIds.delete(stepId);
      }
    }
    if (job.outputs !== undefined) {
      for (const verifiedKey of VERIFIED_SCAN_OUTPUT_KEYS) {
        if (Object.hasOwn(job.outputs, verifiedKey) &&
            !declaresVerifiedStepOutput(job, verifiedKey, validScanOutputStepIds)) {
          return deny('MISSING_THREAT_SCAN_GATE');
        }
      }
    }
    const needs = normalizeNeeds(job.needs);
    if (needs === null || !evaluationJobIds.every(evalJob => needs.includes(evalJob.jobId))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
    const scanSelfProvenance = resolveJobProtectedBranchProvenance(
      job,
      job.if === undefined ? null : parseIfExpression(job.if),
      'refs/heads/main',
      workflowEnvSafeForScan
    ).trustedCheckoutStepIndices.size > 0;
    if (job.if !== undefined) {
      const scanAst = parseIfExpression(job.if);
      if (scanAst === null || (scanAst.kind === 'Literal' && scanAst.value === false) ||
          astHasUnsafeStatusOverride(scanAst)) {
        return deny('MISSING_THREAT_SCAN_GATE');
      }
      const scanConjuncts = collectMandatoryConjuncts(scanAst);
      const hasAlwaysConjunct = scanConjuncts.some(isAlwaysZeroArgCall);
      if (astHasBypassCall(scanAst) && !hasAlwaysConjunct) {
        return deny('MISSING_THREAT_SCAN_GATE');
      }
      const validEvalGate = evaluationJobIds.every(evalJob =>
        scanConjuncts.some(c =>
          isIdentCompareLiteral(c, '==', `needs.${evalJob.jobId}.result`, 'success') ||
          (hasAlwaysConjunct && isIdentCompareLiteral(c, '!=', `needs.${evalJob.jobId}.result`, 'skipped'))
        )
      );
      if (!validEvalGate) {
        return deny('MISSING_THREAT_SCAN_GATE');
      }
      if (getNeedsRefProvenance() && !scanSelfProvenance &&
          !evaluationJobIds.some(evalJob =>
            evalRefProvenanceIds.has(evalJob.jobId) &&
            scanConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${evalJob.jobId}.result`, 'success'))
          )) {
        return deny('MISSING_THREAT_SCAN_GATE');
      }
    } else if (getNeedsRefProvenance() && !evaluationJobIds.every(evalJob => evalRefProvenanceIds.has(evalJob.jobId))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
  }

  for (const {job, hasWriteScope} of safeOutputJobs) {
    const needs = normalizeNeeds(job.needs);
    const matchingScans = needs === null ? [] : needs.filter(dep => threatScanById.has(dep));
    if (needs === null || matchingScans.length === 0) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
    if (job.if === undefined) {
      if (hasWriteScope || !evaluationJobIds.every(evalJob => needs.includes(evalJob.jobId))) {
        return deny('MISSING_THREAT_SCAN_GATE');
      }
      continue;
    }
    const safeAst = parseIfExpression(job.if);
    if (safeAst === null) return deny('MISSING_THREAT_SCAN_GATE');
    if (safeAst.kind === 'Literal' && safeAst.value === false) continue;
    if (astHasUnsafeStatusOverride(safeAst) || !evaluationJobIds.every(evalJob => needs.includes(evalJob.jobId))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
    const safeConjuncts = collectMandatoryConjuncts(safeAst);
    const allEvalSucceeded = evaluationJobIds.every(evalJob =>
      safeConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${evalJob.jobId}.result`, 'success')));
    const scanSucceeded = matchingScans.every(scanId => {
      const hasResultSuccess = safeConjuncts.some(c =>
        isIdentCompareLiteral(c, '==', `needs.${scanId}.result`, 'success'));
      if (!hasWriteScope) return hasResultSuccess;
      const scanEntry = threatScanById.get(scanId);
      const verifiedByScanOutput =
        declaresVerifiedStepOutput(scanEntry.job, 'scan_verified', scanEntry.validScanOutputStepIds) &&
        safeConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${scanId}.outputs.scan_verified`, 'true'));
      const verifiedByDetectionSuccess =
        declaresVerifiedStepOutput(scanEntry.job, 'detection_success', scanEntry.validScanOutputStepIds) &&
        safeConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${scanId}.outputs.detection_success`, 'true'));
      const verifiedByDetectionConclusion =
        declaresVerifiedStepOutput(scanEntry.job, 'detection_conclusion', scanEntry.validScanOutputStepIds) &&
        safeConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${scanId}.outputs.detection_conclusion`, 'success'));
      return hasResultSuccess && (verifiedByScanOutput || verifiedByDetectionSuccess || verifiedByDetectionConclusion);
    });
    if (!allEvalSucceeded || !scanSucceeded) {
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
    bodySha256: computedBodySha256,
    lockSha256: createHash('sha256').update(normalizedLock, 'utf8').digest('hex'),
    pinnedRelease: releaseCheck.release,
    workQueueProtocol: policyCheck.protocol
  });
}

const SUPPORTED_EVENT_MATRIX_TRIGGERS = new Set([
  'workflow_dispatch',
  'schedule',
  'issues',
  'pull_request_target',
  'pull_request_review',
  'workflow_run',
  'push'
]);
const REQUIRED_CORE_EVENT_TRIGGERS = Object.freeze([
  'issues',
  'pull_request_target',
  'workflow_run',
  'push',
  'workflow_dispatch'
]);
const ALLOWED_ISSUES_TYPES = new Set([
  'opened', 'edited', 'labeled', 'unlabeled', 'closed',
  'reopened', 'assigned', 'unassigned', 'milestoned', 'demilestoned'
]);
const ALLOWED_PULL_TARGET_TYPES = new Set([
  'opened', 'reopened', 'synchronize', 'ready_for_review',
  'closed', 'converted_to_draft', 'labeled', 'unlabeled', 'edited'
]);
const ALLOWED_PULL_REVIEW_TYPES = new Set(['submitted', 'edited', 'dismissed']);
const DEFAULT_OFF_ENABLE_VARS = Object.freeze([
  'vars.FACTORY_GHAW_ENABLED',
  'vars.FACTORY_SHADOW_ENABLED'
]);
const ALLOWED_GITHUB_CONTEXT_PATHS = new Set([
  'github.repository',
  'github.repository_id',
  'github.ref',
  'github.ref_protected',
  'github.event_name',
  'github.workflow_sha',
  'github.sha',
  'github.actor',
  'github.actor_id',
  'github.triggering_actor',
  'github.run_id',
  'github.run_number',
  'github.run_attempt',
  'github.workflow',
  'github.workflow_ref',
  'github.job',
  'github.base_ref',
  'github.workspace',
  'github.api_url',
  'github.server_url',
  'github.graphql_url'
]);
const ALLOWED_TYPED_EVENT_PATHS = new Set([
  'github.event.action',
  'github.event.number',
  'github.event.issue.number',
  'github.event.pull_request.number',
  'github.event.pull_request.head.sha',
  'github.event.pull_request.base.sha',
  'github.event.pull_request.base.ref',
  'github.event.pull_request.head.repo.id',
  'github.event.pull_request.base.repo.id',
  'github.event.review.id',
  'github.event.workflow_run.id',
  'github.event.workflow_run.run_attempt',
  'github.event.workflow_run.head_sha',
  'github.event.workflow_run.head_repository.id',
  'github.event.workflow_run.repository.id',
  'github.event.check_suite.id',
  'github.event.check_suite.head_sha'
]);
const VALID_TARGET_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

function isValidTargetBranch(branch) {
  return typeof branch === 'string' &&
    VALID_TARGET_BRANCH_RE.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.lock');
}

function parseTenMinuteRecoverySchedule(scheduleField) {
  if (!Array.isArray(scheduleField) || scheduleField.length !== 1 || !isMapObject(scheduleField[0])) {
    return null;
  }
  const entry = scheduleField[0];
  if (Object.keys(entry).length !== 1 || typeof entry.cron !== 'string') return null;
  const cron = entry.cron.trim();
  const parts = cron.split(' ');
  if (parts.length !== 5 || parts[1] !== '*' || parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') {
    return null;
  }
  const minuteSpec = parts[0];
  let minuteOffsets = null;
  if (minuteSpec === '*/10') {
    minuteOffsets = [0, 10, 20, 30, 40, 50];
  } else {
    const rangeStep = /^([0-9])-(5[0-9])\/10$/.exec(minuteSpec);
    if (rangeStep !== null && Number(rangeStep[2]) >= Number(rangeStep[1]) + 50) {
      const base = Number(rangeStep[1]);
      minuteOffsets = [base, base + 10, base + 20, base + 30, base + 40, base + 50];
    } else {
      const tokens = minuteSpec.split(',');
      if (tokens.length === 6 && tokens.every(tok => /^(?:[0-9]|[1-5][0-9])$/.test(tok))) {
        const nums = tokens.map(Number);
        if (nums[0] < 10 && nums.every((val, idx) => val === nums[0] + idx * 10)) {
          minuteOffsets = nums;
        }
      }
    }
  }
  if (minuteOffsets === null) return null;
  return {
    cron,
    offMinute: minuteOffsets[0] !== 0,
    minuteOffsets
  };
}

function isNonEmptyUniqueSubset(list, allowedSet) {
  return Array.isArray(list) &&
    list.length > 0 &&
    new Set(list).size === list.length &&
    list.every(item => typeof item === 'string' && allowedSet.has(item));
}

function isExactSingleStringArray(list, expected) {
  return Array.isArray(list) && list.length === 1 && list[0] === expected;
}

function isValidEventTriggerConfig(triggerName, cfg, targetBranch) {
  if (!isMapObject(cfg)) return false;
  const keys = Object.keys(cfg);
  if (triggerName === 'workflow_dispatch') {
    return keys.every(key => key === 'inputs') && (cfg.inputs === undefined || isMapObject(cfg.inputs));
  }
  if (triggerName === 'issues') {
    return keys.length === 1 && keys[0] === 'types' && isNonEmptyUniqueSubset(cfg.types, ALLOWED_ISSUES_TYPES);
  }
  if (triggerName === 'pull_request_target') {
    return keys.every(key => key === 'branches' || key === 'types') &&
      isExactSingleStringArray(cfg.branches, targetBranch) &&
      (cfg.types === undefined || isNonEmptyUniqueSubset(cfg.types, ALLOWED_PULL_TARGET_TYPES));
  }
  if (triggerName === 'pull_request_review') {
    return keys.length === 1 && keys[0] === 'types' && isNonEmptyUniqueSubset(cfg.types, ALLOWED_PULL_REVIEW_TYPES);
  }
  if (triggerName === 'workflow_run') {
    return keys.every(key => key === 'workflows' || key === 'types' || key === 'branches') &&
      Array.isArray(cfg.workflows) &&
      cfg.workflows.length > 0 &&
      cfg.workflows.length <= 16 &&
      new Set(cfg.workflows).size === cfg.workflows.length &&
      cfg.workflows.every(name => typeof name === 'string' && name.trim().length > 0) &&
      isExactSingleStringArray(cfg.types, 'completed') &&
      (cfg.branches === undefined || isExactSingleStringArray(cfg.branches, targetBranch));
  }
  return keys.length === 1 && keys[0] === 'branches' && isExactSingleStringArray(cfg.branches, targetBranch);
}

function stripSingleQuotedExpressionLiterals(exprText) {
  let out = '';
  let i = 0;
  while (i < exprText.length) {
    if (exprText[i] !== "'") {
      out += exprText[i];
      i++;
      continue;
    }
    i++;
    let closed = false;
    while (i < exprText.length) {
      if (exprText[i] === "'") {
        if (exprText[i + 1] === "'") {
          i += 2;
          continue;
        }
        i++;
        closed = true;
        break;
      }
      i++;
    }
    if (!closed) return null;
    out += ' ';
  }
  return out;
}

function expressionHasUntrustedEventText(exprText) {
  const stripped = stripSingleQuotedExpressionLiterals(exprText);
  if (stripped === null) return true;
  for (const match of stripped.matchAll(/(?<![.A-Za-z0-9_-])github(?:\.[A-Za-z0-9_-]+)*/gi)) {
    const afterIdx = match.index + match[0].length;
    if (stripped.slice(afterIdx).trimStart().startsWith('[')) return true;
    const normalizedRef = match[0].toLowerCase();
    if (!ALLOWED_GITHUB_CONTEXT_PATHS.has(normalizedRef) && !ALLOWED_TYPED_EVENT_PATHS.has(normalizedRef)) {
      return true;
    }
  }
  return false;
}

function stringHasUntrustedInterpolation(rawValue, isIfField) {
  if (!rawValue.includes('${{') && !rawValue.includes('}}')) {
    return isIfField ? expressionHasUntrustedEventText(rawValue) : false;
  }
  let offset = 0;
  while (offset < rawValue.length) {
    const nextOpen = rawValue.indexOf('${{', offset);
    const nextClose = rawValue.indexOf('}}', offset);
    if (nextOpen === -1) {
      if (nextClose !== -1) return true;
      return isIfField ? expressionHasUntrustedEventText(rawValue.slice(offset)) : false;
    }
    if (nextClose !== -1 && nextClose < nextOpen) return true;
    if (isIfField && expressionHasUntrustedEventText(rawValue.slice(offset, nextOpen))) {
      return true;
    }
    let inSingle = false;
    let end = nextOpen + 3;
    while (end < rawValue.length) {
      if (rawValue[end] === "'") {
        inSingle = !inSingle;
      } else if (!inSingle && rawValue[end] === '}' && rawValue[end + 1] === '}') {
        break;
      }
      end++;
    }
    if (end >= rawValue.length) return true;
    if (expressionHasUntrustedEventText(rawValue.slice(nextOpen + 3, end))) {
      return true;
    }
    offset = end + 2;
  }
  return false;
}

function nodeHasUntrustedInterpolation(node, mode = 'root') {
  if (typeof node === 'string') {
    return stringHasUntrustedInterpolation(node, false);
  }
  if (Array.isArray(node)) {
    const elemMode = mode === 'stepsArray' ? 'step' : 'generic';
    return node.some(item => nodeHasUntrustedInterpolation(item, elemMode));
  }
  if (!isMapObject(node)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (mode === 'step' && key === 'run') continue;
    if (typeof value === 'string') {
      const isIfExpr = (mode === 'job' || mode === 'step') && key === 'if';
      if (stringHasUntrustedInterpolation(value, isIfExpr)) return true;
    } else {
      let childMode = 'generic';
      if (mode === 'root' && key === 'jobs') childMode = 'jobsMap';
      else if (mode === 'jobsMap') childMode = 'job';
      else if (mode === 'job' && key === 'steps') childMode = 'stepsArray';
      if (nodeHasUntrustedInterpolation(value, childMode)) return true;
    }
  }
  return false;
}

const ALLOWED_CONCURRENCY_GROUP_IDENTS = new Set([
  'github.repository',
  'github.repository_id',
  'github.ref',
  'github.workflow',
  'github.job',
  'github.base_ref'
]);

function isScopeStableConcurrencyGroup(group) {
  if (typeof group !== 'string' || group.trim().length === 0) return false;
  for (const expr of scanTemplateExpressions(group)) {
    const tokens = tokenizeIfExpression(expr.content.trim());
    if (tokens === null || tokens.length !== 1 || tokens[0].type !== 'ident' ||
        !ALLOWED_CONCURRENCY_GROUP_IDENTS.has(tokens[0].value.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function isValidNonCancellingConcurrency(concurrency) {
  return isMapObject(concurrency) &&
    Object.keys(concurrency).length === 2 &&
    isScopeStableConcurrencyGroup(concurrency.group) &&
    concurrency['cancel-in-progress'] === false;
}

function isTrustedCheckoutRefValueNode(node, expectedBranchRef) {
  return (node.kind === 'Ident' && node.path === 'github.workflow_sha') ||
    (node.kind === 'Literal' && node.value === expectedBranchRef);
}

function classifyEventMatrixCheckoutRef(rawRef, targetBranch, trustedShas) {
  if (typeof rawRef !== 'string') return 'untrusted';
  const trimmed = rawRef.trim();
  const expectedBranchRef = `refs/heads/${targetBranch}`;
  if (trimmed === expectedBranchRef || trustedShas.has(trimmed)) {
    return 'static_trusted';
  }
  if (!trimmed.startsWith('${{') || !trimmed.endsWith('}}')) {
    return 'untrusted';
  }
  const ast = parseIfExpression(trimmed);
  if (ast === null || astHasBypassCall(ast)) return 'untrusted';
  if (isTrustedCheckoutRefValueNode(ast, expectedBranchRef)) return 'workflow_sha';
  return ast.kind === 'Or' &&
    isTrustedCheckoutRefValueNode(ast.right, expectedBranchRef) &&
    ast.left.kind === 'And' &&
    isTrustedCheckoutRefValueNode(ast.left.right, expectedBranchRef)
    ? 'workflow_sha'
    : 'untrusted';
}

export function verifyEventTriggerMatrix(lockYamlSource, options) {
  let requireRecoverySchedule = true;
  let allowPartialTriggers = false;
  let targetBranch = 'main';
  let trustedShas = new Set();
  if (options !== undefined) {
    const allowedOptionKeys = [
      'requireRecoverySchedule',
      'allowPartialTriggers',
      'targetBranch',
      'trustedControlPlaneShas'
    ];
    if (!isPlainRecord(options, [], allowedOptionKeys)) {
      return deny('INVALID_LOCK_INPUT');
    }
    if ((options.requireRecoverySchedule !== undefined && typeof options.requireRecoverySchedule !== 'boolean') ||
        (options.allowPartialTriggers !== undefined && typeof options.allowPartialTriggers !== 'boolean') ||
        (options.targetBranch !== undefined && !isValidTargetBranch(options.targetBranch)) ||
        (options.trustedControlPlaneShas !== undefined && !isDenseHexArray(options.trustedControlPlaneShas, isHex40))) {
      return deny('INVALID_LOCK_INPUT');
    }
    if (options.requireRecoverySchedule !== undefined) requireRecoverySchedule = options.requireRecoverySchedule;
    if (options.allowPartialTriggers !== undefined) allowPartialTriggers = options.allowPartialTriggers;
    if (options.targetBranch !== undefined) targetBranch = options.targetBranch;
    if (options.trustedControlPlaneShas !== undefined) trustedShas = new Set(options.trustedControlPlaneShas);
  }

  const normalizedLock = normalizeText(lockYamlSource);
  if (normalizedLock === null) return deny('INVALID_LOCK_INPUT');

  const lockDoc = parseStrictYaml(normalizedLock);
  if (lockDoc === null || !isMapObject(lockDoc.on) || Object.keys(lockDoc.on).length === 0 ||
      lockDoc.permissions === undefined || !isMapObject(lockDoc.jobs) || Object.keys(lockDoc.jobs).length === 0) {
    return deny('INVALID_LOCK_YAML');
  }

  const topPerms = isReadOnlyPermissions(lockDoc.permissions);
  if (!topPerms.ok) {
    return deny(topPerms.hasWrite ? 'TOP_LEVEL_WRITE_PERMISSION' : 'INVALID_TOP_LEVEL_PERMISSIONS');
  }

  const onKeys = Object.keys(lockDoc.on);
  for (const triggerName of onKeys) {
    if (!SUPPORTED_EVENT_MATRIX_TRIGGERS.has(triggerName)) {
      return deny('UNSUPPORTED_EVENT_TRIGGER');
    }
  }

  let scheduleInfo = null;
  if (Object.hasOwn(lockDoc.on, 'schedule')) {
    scheduleInfo = parseTenMinuteRecoverySchedule(lockDoc.on.schedule);
    if (scheduleInfo === null) return deny('INVALID_RECOVERY_SCHEDULE');
  } else if (requireRecoverySchedule) {
    return deny('MISSING_RECOVERY_SCHEDULE');
  }

  const eventTriggers = onKeys.filter(key => key !== 'schedule');
  if (eventTriggers.length === 0 ||
      (!allowPartialTriggers && !REQUIRED_CORE_EVENT_TRIGGERS.every(req => Object.hasOwn(lockDoc.on, req)))) {
    return deny('MISSING_REQUIRED_EVENT_TRIGGER');
  }
  for (const triggerName of eventTriggers) {
    if (!isValidEventTriggerConfig(triggerName, lockDoc.on[triggerName], targetBranch)) {
      return deny('INVALID_EVENT_TRIGGER_CONFIG');
    }
  }

  const hasTopLevelConcurrency = lockDoc.concurrency !== undefined;
  const hasPullRequestReviewTrigger = Object.hasOwn(lockDoc.on, 'pull_request_review');
  const hasPullRequestTargetTrigger = Object.hasOwn(lockDoc.on, 'pull_request_target');
  const expectedBranchRef = `refs/heads/${targetBranch}`;
  const checkoutProvenanceReqs = [];
  const jobEntries = Object.entries(lockDoc.jobs);

  for (const [jobId, job] of jobEntries) {
    if (!isMapObject(job)) return deny('INVALID_LOCK_YAML');
    if (/merge[-_]pull[-_]request/i.test(jobId)) {
      return deny('MAIN_MERGE_FORBIDDEN_IN_GHAW');
    }
    const isHelper = HELPER_JOB_IDS.has(jobId);
    const isSafeOutput = jobId.startsWith('safe-outputs') || jobId.startsWith('safe_outputs');
    if (isSafeOutput) {
      if (!isMapObject(job.permissions)) return deny('EXCESSIVE_SAFE_OUTPUT_PERMISSION');
      for (const [scope, level] of Object.entries(job.permissions)) {
        if (!ALLOWED_SAFE_OUTPUT_SCOPES.has(scope) || (level !== 'read' && level !== 'write') ||
            (level === 'write' && FORBIDDEN_SAFE_OUTPUT_WRITES.has(scope))) {
          return deny('EXCESSIVE_SAFE_OUTPUT_PERMISSION');
        }
      }
    } else if (job.permissions !== undefined) {
      const permsOk = isHelper
        ? isHelperReadOnlyPermissions(job.permissions)
        : isReadOnlyPermissions(job.permissions).ok;
      if (!permsOk) return deny('AGENT_JOB_WRITE_PERMISSION');
    }

    if (job.uses !== undefined) {
      if (!isPinnedUses(job.uses)) return deny('UNPINNED_ACTION_REFERENCE');
    } else {
      if (!Array.isArray(job.steps) || job.steps.length === 0) return deny('INVALID_LOCK_YAML');
      for (let stepIdx = 0; stepIdx < job.steps.length; stepIdx++) {
        const step = job.steps[stepIdx];
        if (!isMapObject(step)) return deny('INVALID_LOCK_YAML');
        if (stepAttemptsMainMerge(step)) return deny('MAIN_MERGE_FORBIDDEN_IN_GHAW');
        if (step.run !== undefined && (typeof step.run !== 'string' || step.run.includes('${{'))) {
          return deny('UNSAFE_RUN_INTERPOLATION');
        }
        if (step.uses !== undefined) {
          if (!isPinnedUses(step.uses)) return deny('UNPINNED_ACTION_REFERENCE');
          if (step.uses.toLowerCase().startsWith('actions/checkout@')) {
            const checkoutWith = normalizeCheckoutWith(step.with);
            if (checkoutWith === null || checkoutWith['persist-credentials'] !== false) {
              return deny('CHECKOUT_CREDENTIALS_PERSISTED');
            }
            if (hasInputEnvOverride(lockDoc.env) || hasInputEnvOverride(job.env) || hasInputEnvOverride(step.env)) {
              return deny('UNTRUSTED_PR_CHECKOUT');
            }
            let isGhAwCheckout = false;
            if (checkoutWith.repository !== undefined) {
              if (typeof checkoutWith.repository !== 'string') return deny('UNTRUSTED_PR_CHECKOUT');
              const repoTrimmed = checkoutWith.repository.trim();
              if (repoTrimmed.toLowerCase() === 'github/gh-aw') {
                isGhAwCheckout = true;
              } else if (repoTrimmed !== 'Jamula/SoftwareFactory' &&
                         repoTrimmed !== '${{ github.repository }}') {
                return deny('UNTRUSTED_PR_CHECKOUT');
              }
            }
            if (isGhAwCheckout) {
              if (checkoutWith.ref !== PINNED_GHAW_RELEASE.commit) {
                return deny('UNTRUSTED_PR_CHECKOUT');
              }
            } else if (checkoutWith.ref === undefined) {
              if (hasPullRequestReviewTrigger || hasPullRequestTargetTrigger) {
                return deny('UNTRUSTED_PR_CHECKOUT');
              }
              checkoutProvenanceReqs.push({jobId, stepIdx});
            } else {
              const refKind = classifyEventMatrixCheckoutRef(checkoutWith.ref, targetBranch, trustedShas);
              if (refKind === 'untrusted') return deny('UNTRUSTED_PR_CHECKOUT');
              if (refKind === 'workflow_sha') {
                if (hasPullRequestReviewTrigger) return deny('UNTRUSTED_PR_CHECKOUT');
                checkoutProvenanceReqs.push({jobId, stepIdx});
              }
            }
          }
        }
      }
    }
  }

  if (nodeHasUntrustedInterpolation(lockDoc, 'root')) {
    return deny('UNTRUSTED_PR_TEXT_INTERPOLATION');
  }

  if (hasTopLevelConcurrency && !isValidNonCancellingConcurrency(lockDoc.concurrency)) {
    return deny('MISSING_CONCURRENCY_GUARD');
  }

  const workflowEnvSafeForProvenance = lockDoc.defaults === undefined && isSafeScanEnv(lockDoc.env);
  const disabledJobIds = new Set();
  const guardedJobIds = new Set();
  const downstreamRefProvenanceJobIds = new Set();
  const inheritedRefProvenanceJobIds = new Set();
  const trustedCheckoutStepsByJob = new Map();
  const matchedEnableVars = new Set();
  const parsedJobIfs = new Map();

  for (const [jobId, job] of jobEntries) {
    if (job.concurrency !== undefined && !isValidNonCancellingConcurrency(job.concurrency)) {
      return deny('MISSING_CONCURRENCY_GUARD');
    }
    const jobAst = job.if === undefined ? null : parseIfExpression(job.if);
    parsedJobIfs.set(jobId, jobAst);
    if (jobAst !== null && jobAst.kind === 'Literal' && jobAst.value === false) {
      disabledJobIds.add(jobId);
      continue;
    }
    if (!hasTopLevelConcurrency && job.concurrency === undefined) {
      return deny('MISSING_CONCURRENCY_GUARD');
    }
    if (jobAst !== null && !astHasBypassCall(jobAst)) {
      const conjuncts = collectMandatoryConjuncts(jobAst);
      for (const enableVar of DEFAULT_OFF_ENABLE_VARS) {
        if (conjuncts.some(c => isIdentCompareLiteral(c, '==', enableVar, 'true'))) {
          guardedJobIds.add(jobId);
          matchedEnableVars.add(enableVar.slice('vars.'.length));
        }
      }
      const refProv = resolveJobProtectedBranchProvenance(
        job,
        jobAst,
        expectedBranchRef,
        workflowEnvSafeForProvenance
      );
      if (refProv.jobWideForDownstream) downstreamRefProvenanceJobIds.add(jobId);
      if (refProv.trustedCheckoutStepIndices.size > 0) {
        trustedCheckoutStepsByJob.set(jobId, refProv.trustedCheckoutStepIndices);
      }
    }
    if (job.needs === undefined && !guardedJobIds.has(jobId)) {
      return deny('MISSING_DEFAULT_OFF_GUARD');
    }
  }

  const knownJobIds = new Set(Object.keys(lockDoc.jobs));
  let progress = true;
  while (progress) {
    progress = false;
    for (const [jobId, job] of jobEntries) {
      if (disabledJobIds.has(jobId)) continue;
      const needs = normalizeNeeds(job.needs);
      if (needs === null || !needs.every(dep => knownJobIds.has(dep))) {
        if (!guardedJobIds.has(jobId)) return deny('MISSING_DEFAULT_OFF_GUARD');
        continue;
      }
      if (job.if === undefined) {
        if (!guardedJobIds.has(jobId) &&
            needs.some(dep => guardedJobIds.has(dep)) &&
            needs.every(dep => guardedJobIds.has(dep) || disabledJobIds.has(dep))) {
          guardedJobIds.add(jobId);
          progress = true;
        }
        if (!inheritedRefProvenanceJobIds.has(jobId) &&
            needs.some(dep => downstreamRefProvenanceJobIds.has(dep)) &&
            needs.every(dep => downstreamRefProvenanceJobIds.has(dep) || disabledJobIds.has(dep))) {
          inheritedRefProvenanceJobIds.add(jobId);
          if (!toleratesError(job)) downstreamRefProvenanceJobIds.add(jobId);
          progress = true;
        }
        continue;
      }
      const jobAst = parsedJobIfs.get(jobId);
      if (jobAst === null || astHasUnsafeStatusOverride(jobAst)) {
        return deny('MISSING_DEFAULT_OFF_GUARD');
      }
      const conjuncts = collectMandatoryConjuncts(jobAst);
      const hasAlways = conjuncts.some(isAlwaysZeroArgCall);
      const isScanJob = THREAT_SCAN_JOB_IDS.has(jobId);
      const inheritsFrom = (predSet, allowScanNonSkipped) => needs.some(dep =>
        predSet.has(dep) &&
        conjuncts.some(c =>
          isIdentCompareLiteral(c, '==', `needs.${dep}.result`, 'success') ||
          (allowScanNonSkipped && isScanJob && hasAlways && isIdentCompareLiteral(c, '!=', `needs.${dep}.result`, 'skipped'))
        )
      );
      if (!guardedJobIds.has(jobId) && inheritsFrom(guardedJobIds, true)) {
        guardedJobIds.add(jobId);
        progress = true;
      }
      if (!inheritedRefProvenanceJobIds.has(jobId) && inheritsFrom(downstreamRefProvenanceJobIds, false)) {
        inheritedRefProvenanceJobIds.add(jobId);
        if (!toleratesError(job)) downstreamRefProvenanceJobIds.add(jobId);
        progress = true;
      }
    }
  }

  if (guardedJobIds.size === 0 ||
      jobEntries.some(([jobId]) => !disabledJobIds.has(jobId) && !guardedJobIds.has(jobId))) {
    return deny('MISSING_DEFAULT_OFF_GUARD');
  }

  for (const {jobId, stepIdx} of checkoutProvenanceReqs) {
    if (disabledJobIds.has(jobId)) continue;
    const stepDominated = trustedCheckoutStepsByJob.get(jobId)?.has(stepIdx) === true;
    if (!inheritedRefProvenanceJobIds.has(jobId) && !stepDominated) {
      return deny('UNTRUSTED_PR_CHECKOUT');
    }
  }

  return Object.freeze({
    shadow: true,
    valid: true,
    liveDispatch: false,
    liveMerge: false,
    reason: 'EVENT_TRIGGER_MATRIX_VERIFIED',
    triggers: Object.freeze([...onKeys].sort()),
    recoverySchedule: scheduleInfo === null
      ? null
      : Object.freeze({
          cron: scheduleInfo.cron,
          intervalMinutes: 10,
          offMinute: scheduleInfo.offMinute,
          minuteOffsets: Object.freeze([...scheduleInfo.minuteOffsets])
        }),
    defaultOffVars: Object.freeze([...matchedEnableVars].sort()),
    targetBranch
  });
}
