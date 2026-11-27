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
const PR_HEAD_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment']);
const BYPASS_CALL_NAMES = new Set(['always', 'failure', 'cancelled']);
const MAX_IF_TOKENS = 64;
const MAX_IF_DEPTH = 16;

const isHex40 = value => typeof value === 'string' && HEX40_RE.test(value);
const isHex64 = value => typeof value === 'string' && HEX64_RE.test(value);

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
      const item = parseScalar(part.trim());
      if (!item.ok || (typeof item.value === 'object' && item.value !== null)) return {ok: false};
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

function toleratesError(entity) {
  return entity['continue-on-error'] !== undefined && entity['continue-on-error'] !== false;
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
        (!isMapObject(value) || Object.keys(value).some(k => k !== 'label' || typeof value[k] !== 'string'))) {
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
      if (Object.hasOwn(safeOutputs, 'merge-pull-request') && targetsMainMerge(safeOutputs['merge-pull-request'])) {
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

function isTrustedControlPlaneCheckout(withMap, hasPrHeadTrigger, releaseCommit) {
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
  const refOpt = withMap.ref;
  if (refOpt === undefined) {
    return !hasPrHeadTrigger;
  }
  if (typeof refOpt !== 'string') return false;
  const trimmedRef = refOpt.trim();
  return trimmedRef === 'refs/heads/main' ||
    trimmedRef === 'main' ||
    trimmedRef === '${{ github.workflow_sha }}' ||
    isHex40(trimmedRef);
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
  if (!isPlainRecord(input, ['markdownSource', 'lockYamlSource'], ['pinnedRelease', 'workQueueProtocol', 'workQueueRef'])) {
    return deny('INVALID_LOCK_INPUT');
  }
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

  const hasPrHeadTrigger = Object.keys(lockDoc.on).some(ev => PR_HEAD_EVENTS.has(ev));
  const helperJobs = [];
  const evaluationJobIds = [];
  const threatScanJobs = [];
  const safeOutputJobs = [];

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

    if (job.uses !== undefined) {
      if (!isPinnedUses(job.uses)) return deny('UNPINNED_ACTION_REFERENCE');
      if (job.uses.toLowerCase().startsWith('github/gh-aw/') &&
          job.uses.slice(job.uses.indexOf('@') + 1) !== releaseCheck.release.commit) {
        return deny('PINNED_RELEASE_MISMATCH');
      }
    }

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
      if (isThreatScan) threatScanJobs.push({jobId, job});
      else evaluationJobIds.push({jobId, job});
    }

    if (job.uses === undefined) {
      if (!Array.isArray(job.steps) || job.steps.length === 0) return deny('INVALID_LOCK_YAML');
      let hasThreatScanRunStep = false;
      for (const step of job.steps) {
        if (!isMapObject(step)) return deny('INVALID_LOCK_YAML');
        if (!isSafeOutput && toleratesError(step)) return deny('MISSING_THREAT_SCAN_GATE');
        if (isThreatScan && step.if !== undefined) return deny('MISSING_THREAT_SCAN_GATE');
        if (stepAttemptsMainMerge(step)) return deny('MAIN_MERGE_FORBIDDEN_IN_GHAW');
        if (step.uses !== undefined) {
          if (!isPinnedUses(step.uses)) return deny('UNPINNED_ACTION_REFERENCE');
          const usesLower = step.uses.toLowerCase();
          if (usesLower.startsWith('github/gh-aw/') &&
              step.uses.slice(step.uses.indexOf('@') + 1) !== releaseCheck.release.commit) {
            return deny('PINNED_RELEASE_MISMATCH');
          }
          if (usesLower.startsWith('actions/checkout@')) {
            if (!isMapObject(step.with) || step.with['persist-credentials'] !== false) {
              return deny('CHECKOUT_CREDENTIALS_PERSISTED');
            }
            if (typeof step.with.repository === 'string' &&
                step.with.repository.toLowerCase() === 'github/gh-aw' &&
                step.with.ref !== releaseCheck.release.commit) {
              return deny('PINNED_RELEASE_MISMATCH');
            }
            if (jobHasWriteScope &&
                !isTrustedControlPlaneCheckout(step.with, hasPrHeadTrigger, releaseCheck.release.commit)) {
              return deny('UNTRUSTED_SAFE_OUTPUT_CHECKOUT');
            }
          }
        }
        if (step.run !== undefined) {
          if (typeof step.run !== 'string' || step.run.includes('${{')) {
            return deny('UNSAFE_RUN_INTERPOLATION');
          }
          if (isThreatScan && step.run.trim().length > 0) hasThreatScanRunStep = true;
        }
      }
      if (isThreatScan && !hasThreatScanRunStep) return deny('MISSING_THREAT_SCAN_GATE');
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
  const threatScanById = new Map(threatScanJobs.map(entry => [entry.jobId, entry.job]));
  for (const {job} of threatScanJobs) {
    const needs = normalizeNeeds(job.needs);
    if (needs === null || !evaluationJobIds.every(evalJob => needs.includes(evalJob.jobId))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
    if (job.if !== undefined) {
      const scanAst = parseIfExpression(job.if);
      if (scanAst === null || (scanAst.kind === 'Literal' && scanAst.value === false) || astHasBypassCall(scanAst)) {
        return deny('MISSING_THREAT_SCAN_GATE');
      }
      const scanConjuncts = collectMandatoryConjuncts(scanAst);
      if (!evaluationJobIds.every(evalJob =>
          scanConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${evalJob.jobId}.result`, 'success')))) {
        return deny('MISSING_THREAT_SCAN_GATE');
      }
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
    if (astHasBypassCall(safeAst) || !evaluationJobIds.every(evalJob => needs.includes(evalJob.jobId))) {
      return deny('MISSING_THREAT_SCAN_GATE');
    }
    const safeConjuncts = collectMandatoryConjuncts(safeAst);
    const allEvalSucceeded = evaluationJobIds.every(evalJob =>
      safeConjuncts.some(c => isIdentCompareLiteral(c, '==', `needs.${evalJob.jobId}.result`, 'success')));
    const scanSucceeded = matchingScans.every(scanId => {
      const hasResultSuccess = safeConjuncts.some(c =>
        isIdentCompareLiteral(c, '==', `needs.${scanId}.result`, 'success'));
      if (!hasWriteScope) return hasResultSuccess;
      const scanJob = threatScanById.get(scanId);
      const declaresScanOutput = isMapObject(scanJob.outputs) &&
        typeof scanJob.outputs.scan_verified === 'string' &&
        scanJob.outputs.scan_verified.trim().length > 0;
      const hasOutputVerified = safeConjuncts.some(c =>
        isIdentCompareLiteral(c, '==', `needs.${scanId}.outputs.scan_verified`, 'true'));
      return hasResultSuccess && declaresScanOutput && hasOutputVerified;
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
