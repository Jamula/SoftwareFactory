// Optional developer workstation compatibility preflight evaluator (#66 / M02.05 P2).
// Pure, read-only, fail-closed, zero-private-data diagnostic evaluation across
// Windows 11, macOS, and Linux/WSL2. Never authorizes live orchestration or spend.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { release as osRelease } from 'node:os';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';

export const PINNED_WORKSTATION_TOOLCHAIN = Object.freeze({
  nodeVersion: 'v26.13.1',
  dotnetSdkVersion: '10.0.404',
  aspireCliVersion: '17.0.0'
});

export const SUPPORTED_WORKSTATION_PLATFORMS = Object.freeze([
  'windows-11',
  'macos',
  'linux',
  'wsl2'
]);

export const SUPPORTED_WORKSTATION_ARCHES = Object.freeze(['x64', 'arm64']);

export const REQUIRED_TELEMETRY_OPTOUTS = Object.freeze({
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  ASPIRE_CLI_TELEMETRY_OPTOUT: 'true',
  ASPIRE_DASHBOARD_TELEMETRY_OPTOUT: 'true'
});

export const REQUIRED_SECURE_LOOPBACK_ENV = Object.freeze({
  ASPIRE_ALLOW_UNSECURED_TRANSPORT: 'false',
  ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: 'false'
});

export const ALLOWED_LOOPBACK_IPS = Object.freeze(['127.0.0.1', '::1']);

const MAX_PEM_CA_BYTES = 1_048_576;
const MAX_OBSERVATION_JSON_BYTES = 1_048_576;
const MAX_TEXT_CHARS = 4_096;
const MAX_PATH_CHARS = 512;
const SAFE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW | 0) | (constants.O_NONBLOCK | 0);

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ARCH_SET = new Set(SUPPORTED_WORKSTATION_ARCHES);
const PRIVACY_MODES = new Set(['strict', 'strip']);

const FORBIDDEN_PII_OBSERVATION_KEYS = new Set([
  'username',
  'user',
  'userInfo',
  'homeDir',
  'homeDirectory',
  'hostname',
  'machineName',
  'machineId',
  'serialNumber',
  'macAddress',
  'macAddresses',
  'ipAddress',
  'userEmail',
  'loginUrl',
  'dashboardToken',
  'token',
  'rawStartupLog'
]);

const REQUIRED_OBSERVATION_KEYS = [
  'platform',
  'arch',
  'nodeVersion',
  'dotnetSdkVersion',
  'aspireCliVersion',
  'operationalOrchestratorMode',
  'osRootTrustStoreModified',
  'env',
  'pemCa'
];

const OPTIONAL_OBSERVATION_KEYS = [
  'osRelease',
  'authoritativeLeaseStore',
  'hostedWorkerHost',
  'replacesHostedRunnerValidation',
  'incrementalSpendUsdCents',
  'headSha',
  'loopbackEndpoints',
  'observedIpAddresses',
  'diagnosticNotes',
  'privacyMode'
];

const ALLOWED_OBSERVATION_KEYS = new Set([
  ...REQUIRED_OBSERVATION_KEYS,
  ...OPTIONAL_OBSERVATION_KEYS
]);

const PEM_CA_KEYS = new Set([
  'readable',
  'isRegularFile',
  'isSymbolicLink',
  'pemContent'
]);

const REQUIRED_ENV_KEYS = [
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'ASPIRE_CLI_TELEMETRY_OPTOUT',
  'ASPIRE_DASHBOARD_TELEMETRY_OPTOUT',
  'ASPIRE_ALLOW_UNSECURED_TRANSPORT',
  'ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS',
  'NODE_EXTRA_CA_CERTS'
];

const OPTIONAL_ENV_KEYS = [
  'ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL',
  'ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL',
  'ASPIRE_DASHBOARD_PERSISTENCE_MODE',
  'ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE',
  'ASPIRE_CLI_START_TIMEOUT',
  'ASPIRE_HOME',
  'ASPIRE_DASHBOARD_DATA_DIRECTORY',
  'NO_PROXY',
  'NODE_OPTIONS',
  'OPENAI_AGENTS_DISABLE_TRACING'
];

const ALLOWED_ENV_KEYS = new Set([...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS]);

const SECRET_ENV_KEYS = new Set([
  'DASHBOARD__API__SECONDARYAPIKEY',
  'DASHBOARD__API__PRIMARYAPIKEY',
  'DASHBOARD__FRONTEND__BROWSERTOKEN',
  'ASPIRE_DASHBOARD_FRONTEND_BROWSERTOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AZURE_CLIENT_SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'NPM_TOKEN',
  'NUGET_API_KEY',
  'OTEL_EXPORTER_OTLP_HEADERS'
]);
const SECRET_OTEL_HEADERS_KEY_RE = /^OTEL_EXPORTER_OTLP_(?:[A-Z0-9_]+_)?HEADERS$/;
const SECRET_DASHBOARD_KEY_RE = /^DASHBOARD__(?:API__[A-Z0-9_]*APIKEY|FRONTEND__BROWSERTOKEN)$/;

const IDENTITY_ENV_KEYS = new Set([
  'USER',
  'USERNAME',
  'LOGNAME',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOSTNAME',
  'COMPUTERNAME',
  'USERDOMAIN'
]);

const PROXY_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NODE_USE_ENV_PROXY'
]);

const OPERATIONAL_ENV_KEYS = new Set([
  'FACTORY_OPERATIONAL_ORCHESTRATOR',
  'FACTORY_LEASE_STORE_HOST',
  'RUNNER_ENVIRONMENT'
]);

const EXTERNAL_OTEL_KEY_RE = /^(?:OTEL_EXPORTER_OTLP_.+|OTEL_(?:TRACES|METRICS|LOGS)_EXPORTER)$/;

const NO_PROXY_ALLOWED_TOKENS = new Set(['*', 'localhost', '127.0.0.1', '::1', '[::1]']);

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SHA40_RE = /^[a-f0-9]{40}$/;
const PRIVATE_KEY_HEADER = '-----BEGIN ';
const PRIVATE_KEY_SUFFIXES = ['PRIVATE KEY BLOCK-----', 'PRIVATE KEY-----'];
const PEM_CERT_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_CERT_END = '-----END CERTIFICATE-----';

const QUERY_TOKEN_RE =
  /([?&](?:t|token|access_token|api_key|apikey|key|secret)=)(?:\\?"(?:\\.|[^"\\\r\n]){1,512}\\?"|\\?'(?:\\.|[^'\\\r\n]){1,512}\\?'|[^&\s#"'\\]{1,512})/gi;
const ENV_SECRET_ASSIGNMENT_RE =
  /\b(DASHBOARD__API__[A-Z0-9_]*APIKEY|DASHBOARD__FRONTEND__BROWSERTOKEN|ASPIRE_DASHBOARD_FRONTEND_BROWSERTOKEN|GITHUB_TOKEN|GH_TOKEN|COPILOT_GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AZURE_CLIENT_SECRET|AWS_SECRET_ACCESS_KEY|NPM_TOKEN|NUGET_API_KEY|OTEL_EXPORTER_OTLP_(?:[A-Z0-9_]+_)?HEADERS)(?:\\?["'])?\s*[:=]\s*(?:\\?"(?:\\.|[^"\\\r\n]){1,512}\\?"|\\?'(?:\\.|[^'\\\r\n]){1,512}\\?'|[^\s"',;}\]]{1,512})/gi;
const API_HEADER_SECRET_RE =
  /\b(x-api-key|x-otlp-api-key|access_token|refresh_token|client_secret|api_key|apikey|password|passwd)(?:\\?["'])?\s*[:=]\s*(?:\\?"(?:\\.|[^"\\\r\n]){1,512}\\?"|\\?'(?:\\.|[^'\\\r\n]){1,512}\\?'|[^\s"',;}\]]{1,512})/gi;
const AUTH_SCHEME_SECRET_RE =
  /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{4,512}/gi;
const CREDENTIAL_TOKEN_RE =
  /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9_]{4,255}|github_pat_[A-Za-z0-9_]{4,255}|npm_[A-Za-z0-9]{8,255}|sk-ant-[A-Za-z0-9_-]{4,255}|sk-[A-Za-z0-9_-]{8,255})/gi;

const WSL_HOME_SUBDIR_RE =
  /(?:\\{2,4}|\/\/)(?:wsl\$|wsl\.localhost)(?:\\{1,2}|\/)[^\\/\s"':]{1,128}(?:\\{1,2}|\/)home(?:\\{1,2}|\/)[^\\/\r\n":]{1,128}(?=(?:\\{1,2}|\/))/gi;
const WSL_HOME_BARE_RE =
  /(?:\\{2,4}|\/\/)(?:wsl\$|wsl\.localhost)(?:\\{1,2}|\/)[^\\/\s"':]{1,128}(?:\\{1,2}|\/)home(?:\\{1,2}|\/)[^\\/\r\n":,;|()[\]{}]{1,128}/gi;
const WSL_MOUNT_WIN_HOME_SUBDIR_RE =
  /(?<![A-Za-z0-9_.-])\/mnt\/[a-zA-Z]\/Users\/[^\\/\r\n":]{1,128}(?=\/)/gi;
const WSL_MOUNT_WIN_HOME_BARE_RE =
  /(?<![A-Za-z0-9_.-])\/mnt\/[a-zA-Z]\/Users\/[^/\r\n":,;|()[\]{}]{1,128}/gi;
const WINDOWS_HOME_SUBDIR_RE =
  /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\r\n":]{1,128}(?=(?:\\{1,2}|\/))/gi;
const WINDOWS_HOME_BARE_RE =
  /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\r\n":,;|()[\]{}]{1,128}/gi;
const MACOS_HOME_SUBDIR_RE =
  /(?<![A-Za-z0-9_.-])(?:\/System\/Volumes\/Data)?\/Users\/[^/\r\n":]{1,128}(?=\/)/gi;
const MACOS_HOME_BARE_RE =
  /(?<![A-Za-z0-9_.-])(?:\/System\/Volumes\/Data)?\/Users\/[^/\r\n":,;|()[\]{}]{1,128}/gi;
const LINUX_HOME_SUBDIR_RE = /(?<![A-Za-z0-9_.-])(?:\/var)?\/home\/[^/\r\n":]{1,128}(?=\/)/g;
const LINUX_HOME_BARE_RE =
  /(?<![A-Za-z0-9_.-])(?:\/var)?\/home\/[^/\r\n":,;|()[\]{}]{1,128}/g;
const XDG_RUNTIME_UID_RE = /(?<![A-Za-z0-9_.-])\/run\/user\/[0-9]{1,12}/g;
const DARWIN_USER_TMP_RE =
  /(?<![A-Za-z0-9_.-])(?:\/private)?\/var\/folders\/[^/\s"':]{1,64}\/[^/\s"':]{1,128}/g;

const URL_USERINFO_RE = /(https?:\/\/)([^\s/?#@]{1,128}@)/gi;
const URL_HOST_AUTHORITY_RE =
  /\b(https?:\/\/(?:[^\s/?#@]{1,128}@)?)(\[[^\]]{1,64}\]|[^[\s/?#:@"']{1,255})/gi;
const EMAIL_CANDIDATE_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
const IDENTITY_ASSIGNMENT_RE =
  /(?<![A-Za-z0-9_.-])(user(?:name)?|logname|login|hostname|computer[-_]?name|userdomain|machine[-_]?name|machine[-_]?id|serial[-_]?number|userprofile|home(?:dir|directory|path)?)(?:\\?["'])?\s*[:=]\s*(?:\\?"(?:\\.|[^"\\\r\n]){1,128}\\?"|\\?'(?:\\.|[^'\\\r\n]){1,128}\\?'|[^\s"',;}\]]{1,128})/gi;

const MAC_COLON_RE =
  /(?<![0-9A-Fa-f]{2}:)(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f])(?![:][0-9A-Fa-f]{2})/g;
const MAC_DASH_RE =
  /(?<![0-9A-Fa-f]{2}-)(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f])(?![-][0-9A-Fa-f]{2})/g;
const MAC_CISCO_RE =
  /(?<![0-9A-Fa-f.])[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}(?![0-9A-Fa-f.])/g;

const BRACKETED_IPV6_CANDIDATE_RE = /\[([0-9A-Fa-f:.]{2,45}(?:%[A-Za-z0-9_.-]{1,32})?)\]/g;
const UNBRACKETED_IPV6_CANDIDATE_RE = /[0-9A-Fa-f:.]{2,45}(?:%[A-Za-z0-9_.-]{1,32})?/g;
const IPV4_CANDIDATE_RE = /(?<!(?:\d\.|\d|[A-Za-z]))(\d{1,3}(?:\.\d{1,3}){3})(?!(?:\.\d|\d))/g;

const POSIX_OS_TRUST_PREFIXES = [
  '/etc/ssl',
  '/private/etc/ssl',
  '/etc/pki',
  '/private/etc/pki',
  '/etc/ca-certificates',
  '/usr/share/ca-certificates',
  '/usr/local/share/ca-certificates',
  '/system/library/keychains',
  '/library/keychains',
  '/system/volumes/data/library/keychains'
];

const WINDOWS_OS_TRUST_PREFIXES = [
  'c:/windows',
  'c:/programdata/microsoft/crypto'
];

function isOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value')
  );
}

function isPlainRecord(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) {
    return false;
  }
  return keys.every(
    key =>
      typeof key === 'string' &&
      !FORBIDDEN_OBJECT_KEYS.has(key) &&
      isOwnEnumerableData(value, key)
  );
}

function isDenseArray(value, maxLength) {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false;
  }
  const len = value.length;
  if (len > maxLength || Reflect.ownKeys(value).length !== len + 1) {
    return false;
  }
  for (let i = 0; i < len; i++) {
    if (!isOwnEnumerableData(value, String(i))) {
      return false;
    }
  }
  return true;
}

function blockedReceipt(reason) {
  return Object.freeze({
    shadow: true,
    compatible: false,
    state: 'blocked',
    nonBlockingOptionalP2: true,
    operationalOrchestratorAllowed: false,
    liveDispatch: false,
    liveMerge: false,
    replacesHostedRunnerValidation: false,
    incrementalSpendUsdCents: 0,
    zeroPrivateData: true,
    reason
  });
}

function isExactLoopbackIp(rawCandidate) {
  const trimmed = rawCandidate.trim();
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
  if (unbracketed.includes('%')) {
    return false;
  }
  const ipVersion = isIP(unbracketed);
  if (ipVersion === 4) {
    return unbracketed === '127.0.0.1';
  }
  if (ipVersion === 6) {
    return unbracketed === '::1';
  }
  return false;
}

function isSecretEnvKey(upperKey) {
  return (
    SECRET_ENV_KEYS.has(upperKey) ||
    SECRET_OTEL_HEADERS_KEY_RE.test(upperKey) ||
    SECRET_DASHBOARD_KEY_RE.test(upperKey)
  );
}

function matchPrivateKeyHeaderAt(text, labelStart) {
  for (const suffix of PRIVATE_KEY_SUFFIXES) {
    const suffixIdx = text.indexOf(suffix, labelStart);
    if (suffixIdx !== -1 && suffixIdx - labelStart <= 32) {
      const label = text.slice(labelStart, suffixIdx);
      if (/^[A-Z0-9 ]*$/.test(label)) {
        return { label, suffix, headerEnd: suffixIdx + suffix.length };
      }
    }
  }
  return null;
}

function containsPrivateKeyPemMarker(text) {
  let cursor = 0;
  while (cursor < text.length) {
    const beginIdx = text.indexOf(PRIVATE_KEY_HEADER, cursor);
    if (beginIdx === -1) {
      return false;
    }
    const labelStart = beginIdx + PRIVATE_KEY_HEADER.length;
    if (matchPrivateKeyHeaderAt(text, labelStart) !== null) {
      return true;
    }
    cursor = labelStart;
  }
  return false;
}

function redactPrivateKeyPemBlocks(text, onRedacted) {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const beginIdx = text.indexOf(PRIVATE_KEY_HEADER, cursor);
    if (beginIdx === -1) {
      result += text.slice(cursor);
      break;
    }
    const labelStart = beginIdx + PRIVATE_KEY_HEADER.length;
    const matched = matchPrivateKeyHeaderAt(text, labelStart);
    if (matched === null) {
      result += text.slice(cursor, labelStart);
      cursor = labelStart;
      continue;
    }
    result += text.slice(cursor, beginIdx) + '[REDACTED_TOKEN]';
    onRedacted();
    const endMarker = `-----END ${matched.label}${matched.suffix}`;
    const endIdx = text.indexOf(endMarker, matched.headerEnd);
    cursor = endIdx === -1 ? text.length : endIdx + endMarker.length;
  }
  return result;
}

export function stripPrivateWorkstationIdentifiers(rawText) {
  if (typeof rawText !== 'string' || rawText.length > MAX_TEXT_CHARS || CONTROL_CHAR_RE.test(rawText)) {
    return null;
  }
  const stripped = new Set();
  let text = redactPrivateKeyPemBlocks(rawText, () => {
    stripped.add('token');
  });

  const replaceTracking = (pattern, replacement, category) => {
    text = text.replace(pattern, () => {
      stripped.add(category);
      return replacement;
    });
  };

  text = text.replace(QUERY_TOKEN_RE, (_full, prefix) => {
    stripped.add('token');
    return `${prefix}[REDACTED_TOKEN]`;
  });
  text = text.replace(ENV_SECRET_ASSIGNMENT_RE, (_full, key) => {
    stripped.add('token');
    return `${key}=[REDACTED_TOKEN]`;
  });
  text = text.replace(API_HEADER_SECRET_RE, (_full, key) => {
    stripped.add('token');
    return `${key}: [REDACTED_TOKEN]`;
  });
  replaceTracking(AUTH_SCHEME_SECRET_RE, '[REDACTED_TOKEN]', 'token');
  replaceTracking(CREDENTIAL_TOKEN_RE, '[REDACTED_TOKEN]', 'token');

  text = text.replace(URL_USERINFO_RE, (_full, scheme) => {
    stripped.add('username');
    return `${scheme}[REDACTED_USER]@`;
  });
  text = text.replace(EMAIL_CANDIDATE_RE, full => {
    const tld = full.slice(full.lastIndexOf('.') + 1);
    if (!/^[A-Za-z]{2,24}$/.test(tld)) {
      return full;
    }
    stripped.add('username');
    return '[REDACTED_USER]';
  });
  text = text.replace(IDENTITY_ASSIGNMENT_RE, (_full, key) => {
    stripped.add('username');
    return `${key}=[REDACTED_USER]`;
  });

  replaceTracking(MAC_COLON_RE, '[REDACTED_MAC]', 'mac-address');
  replaceTracking(MAC_DASH_RE, '[REDACTED_MAC]', 'mac-address');
  replaceTracking(MAC_CISCO_RE, '[REDACTED_MAC]', 'mac-address');

  text = text.replace(BRACKETED_IPV6_CANDIDATE_RE, (full, inner) => {
    const base = inner.split('%')[0];
    if (isIP(base) !== 6) {
      return full;
    }
    if (!inner.includes('%') && base === '::1') {
      return '[::1]';
    }
    stripped.add('non-loopback-ip');
    return '[REDACTED_IP]';
  });

  text = text.replace(UNBRACKETED_IPV6_CANDIDATE_RE, (full, offset, current) => {
    if (
      !full.includes(':') ||
      (offset > 0 && current[offset - 1] === '[' && current[offset + full.length] === ']')
    ) {
      return full;
    }
    let lead = '';
    let core = full;
    if (core.startsWith(':') && !core.startsWith('::')) {
      lead = ':';
      core = core.slice(1);
    }
    let trail = '';
    while (core.endsWith('.') || (core.endsWith(':') && !core.endsWith('::'))) {
      trail = core.slice(-1) + trail;
      core = core.slice(0, -1);
    }
    if (!core.includes(':')) {
      return full;
    }
    const base = core.split('%')[0];
    if (isIP(base) !== 6) {
      return full;
    }
    if (!core.includes('%') && base === '::1') {
      return `${lead}::1${trail}`;
    }
    stripped.add('non-loopback-ip');
    return `${lead}[REDACTED_IP]${trail}`;
  });

  text = text.replace(IPV4_CANDIDATE_RE, (full, candidate) => {
    if (isIP(candidate) !== 4) {
      return full;
    }
    if (candidate === '127.0.0.1') {
      return '127.0.0.1';
    }
    stripped.add('non-loopback-ip');
    return '[REDACTED_IP]';
  });

  text = text.replace(URL_HOST_AUTHORITY_RE, (full, prefix, host) => {
    const lowerHost = host.toLowerCase();
    if (
      lowerHost === 'localhost' ||
      lowerHost === '127.0.0.1' ||
      lowerHost === '[::1]' ||
      lowerHost === '[redacted_ip]'
    ) {
      return full;
    }
    stripped.add('non-loopback-ip');
    return `${prefix}[REDACTED_HOST]`;
  });

  replaceTracking(WSL_HOME_SUBDIR_RE, '<redacted-home>', 'home-directory');
  replaceTracking(WSL_HOME_BARE_RE, '<redacted-home>', 'home-directory');
  replaceTracking(WSL_MOUNT_WIN_HOME_SUBDIR_RE, '<redacted-home>', 'home-directory');
  replaceTracking(WSL_MOUNT_WIN_HOME_BARE_RE, '<redacted-home>', 'home-directory');
  replaceTracking(WINDOWS_HOME_SUBDIR_RE, '<redacted-home>', 'home-directory');
  replaceTracking(WINDOWS_HOME_BARE_RE, '<redacted-home>', 'home-directory');
  replaceTracking(MACOS_HOME_SUBDIR_RE, '<redacted-home>', 'home-directory');
  replaceTracking(MACOS_HOME_BARE_RE, '<redacted-home>', 'home-directory');
  replaceTracking(LINUX_HOME_SUBDIR_RE, '<redacted-home>', 'home-directory');
  replaceTracking(LINUX_HOME_BARE_RE, '<redacted-home>', 'home-directory');
  replaceTracking(XDG_RUNTIME_UID_RE, '<redacted-runtime-dir>', 'home-directory');
  replaceTracking(DARWIN_USER_TMP_RE, '<redacted-temp>', 'home-directory');

  const strippedCategories = Object.freeze([...stripped].sort());
  return Object.freeze({
    sanitizedText: text,
    strippedCategories,
    containsPrivateData: strippedCategories.length > 0
  });
}

function classifyLoopbackHttpsEndpoint(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 256 || CONTROL_CHAR_RE.test(rawUrl)) {
    return 'INSECURE_LOOPBACK_POSTURE';
  }
  const redaction = stripPrivateWorkstationIdentifiers(rawUrl);
  if (redaction.strippedCategories.includes('token')) {
    return 'SECRET_OR_TOKEN_FORBIDDEN';
  }
  if (redaction.strippedCategories.includes('username') || redaction.strippedCategories.includes('mac-address')) {
    return 'PRIVATE_IDENTIFIER_FORBIDDEN';
  }
  if (redaction.strippedCategories.includes('non-loopback-ip')) {
    return 'NON_LOOPBACK_ADDRESS_FORBIDDEN';
  }
  const match = /^https:\/\/([^/?#@\s]+):([1-9][0-9]{0,4})$/.exec(rawUrl);
  if (!match) {
    return 'INSECURE_LOOPBACK_POSTURE';
  }
  const host = match[1];
  const port = Number(match[2]);
  if (port > 65535) {
    return 'INSECURE_LOOPBACK_POSTURE';
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
    return 'NON_LOOPBACK_ADDRESS_FORBIDDEN';
  }
  return 'OK';
}

function isOsRootTrustStorePath(rawPath) {
  const normalizedSlashes = rawPath.replaceAll('\\', '/');
  const lowerNormalized = normalizedSlashes.toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || /^cert:[\\/]/i.test(rawPath)) {
    return true;
  }
  if (
    WINDOWS_OS_TRUST_PREFIXES.some(
      prefix => lowerNormalized === prefix || lowerNormalized.startsWith(`${prefix}/`)
    )
  ) {
    return true;
  }
  return (
    POSIX_OS_TRUST_PREFIXES.some(
      prefix => lowerNormalized === prefix || lowerNormalized.startsWith(`${prefix}/`)
    ) ||
    /^(?:\/system\/volumes\/data)?\/users\/[^/]+\/library\/keychains(?:\/|$)/i.test(normalizedSlashes) ||
    /^(?:\/var)?\/home\/[^/]+\/\.pki\/nssdb(?:\/|$)/i.test(normalizedSlashes) ||
    /^\/mnt\/[a-z]\/(?:windows|programdata\/microsoft\/crypto)(?:\/|$)/i.test(normalizedSlashes)
  );
}

function validateScopedWorkstationPath(rawPath, osFamily, requirePemExtension) {
  if (
    rawPath.trim().length === 0 ||
    rawPath.length > MAX_PATH_CHARS ||
    rawPath.includes('\n') ||
    rawPath.includes('\r')
  ) {
    return { ok: false, reason: 'INVALID_PATH', homeStripped: false };
  }
  const redaction = stripPrivateWorkstationIdentifiers(rawPath);
  const normalizedSlashes = rawPath.replaceAll('\\', '/');
  if (isOsRootTrustStorePath(rawPath)) {
    return { ok: false, reason: 'OS_ROOT_TRUST_MODIFIED', homeStripped: false };
  }

  if (osFamily === 'windows-11') {
    if (!/^[A-Za-z]:\//.test(normalizedSlashes)) {
      return { ok: false, reason: 'INVALID_PATH', homeStripped: false };
    }
    const segments = normalizedSlashes.slice(3).split('/');
    if (segments.some(seg => seg.length === 0 || seg === '.' || seg === '..')) {
      return { ok: false, reason: 'INVALID_PATH', homeStripped: false };
    }
  } else {
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) {
      return { ok: false, reason: 'INVALID_PATH', homeStripped: false };
    }
    const segments = rawPath.slice(1).split('/');
    if (segments.some(seg => seg.length === 0 || seg === '.' || seg === '..')) {
      return { ok: false, reason: 'INVALID_PATH', homeStripped: false };
    }
  }

  if (requirePemExtension && !/\.(?:pem|crt)$/i.test(normalizedSlashes)) {
    return { ok: false, reason: 'INVALID_PATH', homeStripped: false };
  }

  return {
    ok: true,
    reason: 'OK',
    homeStripped: redaction.strippedCategories.includes('home-directory')
  };
}

function parsePemCertificateBlocks(pemContent) {
  const blocks = [];
  let cursor = 0;
  while (cursor < pemContent.length) {
    const beginIdx = pemContent.indexOf(PEM_CERT_BEGIN, cursor);
    if (beginIdx === -1) {
      if (pemContent.slice(cursor).trim().length > 0) {
        return null;
      }
      break;
    }
    if (pemContent.slice(cursor, beginIdx).trim().length > 0) {
      return null;
    }
    const bodyStart = beginIdx + PEM_CERT_BEGIN.length;
    const endIdx = pemContent.indexOf(PEM_CERT_END, bodyStart);
    if (endIdx === -1) {
      return null;
    }
    const blockEnd = endIdx + PEM_CERT_END.length;
    blocks.push(pemContent.slice(beginIdx, blockEnd));
    cursor = blockEnd;
  }
  return blocks.length > 0 ? blocks : null;
}

function validatePemCertificateContent(pemCa) {
  if (
    pemCa.readable !== true ||
    pemCa.isRegularFile !== true ||
    pemCa.isSymbolicLink !== false ||
    pemCa.pemContent.length === 0 ||
    pemCa.pemContent.length > MAX_PEM_CA_BYTES ||
    CONTROL_CHAR_RE.test(pemCa.pemContent)
  ) {
    return { ok: false, reason: 'INVALID_OR_UNREADABLE_PEM_CA', certificateCount: 0 };
  }
  const blocks = parsePemCertificateBlocks(pemCa.pemContent);
  if (!blocks) {
    return { ok: false, reason: 'INVALID_OR_UNREADABLE_PEM_CA', certificateCount: 0 };
  }
  try {
    for (const block of blocks) {
      new X509Certificate(block);
    }
  } catch {
    return { ok: false, reason: 'INVALID_OR_UNREADABLE_PEM_CA', certificateCount: 0 };
  }
  return { ok: true, reason: 'OK', certificateCount: blocks.length };
}

function isSupportedWindows11Release(rawRelease) {
  if (typeof rawRelease !== 'string' || rawRelease.length > 128 || CONTROL_CHAR_RE.test(rawRelease)) {
    return false;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[.-]|$)/.exec(rawRelease.trim());
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const build = Number(match[3]);
  return major > 10 || (major === 10 && minor === 0 && build >= 22000);
}

function isSupportedDarwinRelease(rawRelease) {
  if (typeof rawRelease !== 'string' || rawRelease.length > 128 || CONTROL_CHAR_RE.test(rawRelease)) {
    return false;
  }
  const match = /^(\d+)\.(\d+)(?:[.-]|$)/.exec(rawRelease.trim());
  return Boolean(match && Number(match[1]) >= 20);
}

function resolveWorkstationOsFamily(rawPlatform, rawRelease, hasExplicitRelease) {
  if (rawPlatform === 'win32') {
    return hasExplicitRelease && isSupportedWindows11Release(rawRelease) ? 'windows-11' : null;
  }
  if (rawPlatform === 'windows-11') {
    return !hasExplicitRelease || isSupportedWindows11Release(rawRelease) ? 'windows-11' : null;
  }
  if (rawPlatform === 'darwin') {
    return hasExplicitRelease && isSupportedDarwinRelease(rawRelease) ? 'macos' : null;
  }
  if (rawPlatform === 'macos') {
    return !hasExplicitRelease || isSupportedDarwinRelease(rawRelease) ? 'macos' : null;
  }
  if (rawPlatform === 'wsl2') {
    if (!hasExplicitRelease) {
      return 'wsl2';
    }
    if (
      typeof rawRelease !== 'string' ||
      rawRelease.length > 128 ||
      CONTROL_CHAR_RE.test(rawRelease) ||
      !/^\d+\.\d+/.test(rawRelease.trim()) ||
      !/\bwsl2\b/i.test(rawRelease)
    ) {
      return null;
    }
    return 'wsl2';
  }
  if (rawPlatform === 'linux') {
    if (!hasExplicitRelease) {
      return 'linux';
    }
    if (
      typeof rawRelease !== 'string' ||
      rawRelease.length > 128 ||
      CONTROL_CHAR_RE.test(rawRelease) ||
      !/^\d+\.\d+/.test(rawRelease.trim())
    ) {
      return null;
    }
    if (/microsoft|wsl/i.test(rawRelease)) {
      return /\bwsl2\b/i.test(rawRelease) ? 'wsl2' : null;
    }
    return 'linux';
  }
  return null;
}

function validateNoProxyValue(rawNoProxy) {
  if (typeof rawNoProxy !== 'string' || rawNoProxy.trim().length === 0 || rawNoProxy.length > 128) {
    return false;
  }
  const parts = rawNoProxy.split(',').map(part => part.trim().toLowerCase());
  return parts.length > 0 && parts.every(part => NO_PROXY_ALLOWED_TOKENS.has(part));
}

export function evaluateWorkstationCompatibilityPreflight(observation) {
  if (!isPlainRecord(observation)) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  const obsKeys = Object.keys(observation);
  if (obsKeys.some(key => FORBIDDEN_PII_OBSERVATION_KEYS.has(key))) {
    return blockedReceipt('PRIVATE_IDENTIFIER_FORBIDDEN');
  }
  if (
    !obsKeys.every(key => ALLOWED_OBSERVATION_KEYS.has(key)) ||
    !REQUIRED_OBSERVATION_KEYS.every(key => Object.hasOwn(observation, key) && observation[key] !== undefined)
  ) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  if (
    typeof observation.platform !== 'string' ||
    typeof observation.arch !== 'string' ||
    typeof observation.nodeVersion !== 'string' ||
    typeof observation.dotnetSdkVersion !== 'string' ||
    typeof observation.aspireCliVersion !== 'string' ||
    typeof observation.operationalOrchestratorMode !== 'boolean' ||
    typeof observation.osRootTrustStoreModified !== 'boolean' ||
    !isPlainRecord(observation.env) ||
    !isPlainRecord(observation.pemCa)
  ) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  const hasOsRelease = Object.hasOwn(observation, 'osRelease');
  if (hasOsRelease && typeof observation.osRelease !== 'string') {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  const pemCaKeys = Object.keys(observation.pemCa);
  if (
    pemCaKeys.length !== PEM_CA_KEYS.size ||
    !pemCaKeys.every(key => PEM_CA_KEYS.has(key)) ||
    typeof observation.pemCa.readable !== 'boolean' ||
    typeof observation.pemCa.isRegularFile !== 'boolean' ||
    typeof observation.pemCa.isSymbolicLink !== 'boolean' ||
    typeof observation.pemCa.pemContent !== 'string'
  ) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  const privacyMode =
    Object.hasOwn(observation, 'privacyMode') && observation.privacyMode !== undefined
      ? observation.privacyMode
      : 'strict';
  if (!PRIVACY_MODES.has(privacyMode)) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  for (const boolKey of [
    'authoritativeLeaseStore',
    'hostedWorkerHost',
    'replacesHostedRunnerValidation'
  ]) {
    if (Object.hasOwn(observation, boolKey) && typeof observation[boolKey] !== 'boolean') {
      return blockedReceipt('INPUT_UNKNOWN');
    }
  }

  if (
    Object.hasOwn(observation, 'incrementalSpendUsdCents') &&
    (!Number.isSafeInteger(observation.incrementalSpendUsdCents) ||
      observation.incrementalSpendUsdCents < 0)
  ) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  let headSha = null;
  if (Object.hasOwn(observation, 'headSha')) {
    if (typeof observation.headSha !== 'string' || !SHA40_RE.test(observation.headSha)) {
      return blockedReceipt('INPUT_UNKNOWN');
    }
    headSha = observation.headSha;
  }

  if (
    Object.hasOwn(observation, 'observedIpAddresses') &&
    (!isDenseArray(observation.observedIpAddresses, 32) ||
      !observation.observedIpAddresses.every(item => typeof item === 'string'))
  ) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  if (
    Object.hasOwn(observation, 'loopbackEndpoints') &&
    (!isDenseArray(observation.loopbackEndpoints, 16) ||
      !observation.loopbackEndpoints.every(item => typeof item === 'string'))
  ) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  if (
    Object.hasOwn(observation, 'diagnosticNotes') &&
    (!isDenseArray(observation.diagnosticNotes, 32) ||
      !observation.diagnosticNotes.every(
        item => typeof item === 'string' && item.length <= MAX_TEXT_CHARS && !CONTROL_CHAR_RE.test(item)
      ))
  ) {
    return blockedReceipt('INPUT_UNKNOWN');
  }

  if (
    observation.operationalOrchestratorMode !== false ||
    observation.authoritativeLeaseStore === true ||
    observation.hostedWorkerHost === true ||
    observation.replacesHostedRunnerValidation === true
  ) {
    return blockedReceipt('OPERATIONAL_ORCHESTRATOR_FORBIDDEN');
  }

  if (
    Object.hasOwn(observation, 'incrementalSpendUsdCents') &&
    observation.incrementalSpendUsdCents > 0
  ) {
    return blockedReceipt('INCREMENTAL_SPEND_FORBIDDEN');
  }

  const osFamily = resolveWorkstationOsFamily(
    observation.platform,
    hasOsRelease ? observation.osRelease : '',
    hasOsRelease
  );
  if (!osFamily || !ARCH_SET.has(observation.arch)) {
    return blockedReceipt('UNSUPPORTED_PLATFORM');
  }

  const effectiveEnv = {};
  const seenWindowsKeys = new Set();
  for (const [rawKey, rawValue] of Object.entries(observation.env)) {
    if (typeof rawValue !== 'string' || rawValue.length > MAX_TEXT_CHARS || CONTROL_CHAR_RE.test(rawValue)) {
      return blockedReceipt('INPUT_UNKNOWN');
    }
    const upperKey = rawKey.toUpperCase();
    if (isSecretEnvKey(upperKey)) {
      return blockedReceipt('SECRET_OR_TOKEN_FORBIDDEN');
    }
    if (IDENTITY_ENV_KEYS.has(upperKey)) {
      return blockedReceipt('PRIVATE_IDENTIFIER_FORBIDDEN');
    }
    if (OPERATIONAL_ENV_KEYS.has(upperKey)) {
      return blockedReceipt('OPERATIONAL_ORCHESTRATOR_FORBIDDEN');
    }
    if (upperKey === 'NODE_TLS_REJECT_UNAUTHORIZED') {
      return blockedReceipt('TLS_VERIFICATION_OVERRIDE_FORBIDDEN');
    }
    if (
      PROXY_ENV_KEYS.has(upperKey) ||
      (upperKey === 'NODE_OPTIONS' && /--use-env-proxy(?:\s|=|$)/.test(rawValue))
    ) {
      return blockedReceipt('PROXY_INTERCEPTION_FORBIDDEN');
    }
    if (
      EXTERNAL_OTEL_KEY_RE.test(upperKey) ||
      (upperKey === 'OPENAI_AGENTS_DISABLE_TRACING' && rawValue !== '1')
    ) {
      return blockedReceipt('TELEMETRY_OPTOUT_MISSING');
    }

    if (osFamily === 'windows-11') {
      if (!ALLOWED_ENV_KEYS.has(upperKey) || seenWindowsKeys.has(upperKey)) {
        return blockedReceipt('INPUT_UNKNOWN');
      }
      seenWindowsKeys.add(upperKey);
      effectiveEnv[upperKey] = rawValue;
    } else if (rawKey === 'no_proxy') {
      effectiveEnv.no_proxy = rawValue;
    } else if (ALLOWED_ENV_KEYS.has(rawKey)) {
      effectiveEnv[rawKey] = rawValue;
    } else {
      return blockedReceipt('INPUT_UNKNOWN');
    }

    const valueScan = stripPrivateWorkstationIdentifiers(rawValue);
    if (valueScan.strippedCategories.includes('token')) {
      return blockedReceipt('SECRET_OR_TOKEN_FORBIDDEN');
    }
    if (
      valueScan.strippedCategories.includes('mac-address') ||
      valueScan.strippedCategories.includes('username')
    ) {
      return blockedReceipt('PRIVATE_IDENTIFIER_FORBIDDEN');
    }
    if (valueScan.strippedCategories.includes('non-loopback-ip')) {
      return blockedReceipt('NON_LOOPBACK_ADDRESS_FORBIDDEN');
    }
  }

  if (containsPrivateKeyPemMarker(observation.pemCa.pemContent)) {
    return blockedReceipt('SECRET_OR_TOKEN_FORBIDDEN');
  }

  if (Object.hasOwn(observation, 'observedIpAddresses')) {
    for (const ip of observation.observedIpAddresses) {
      if (!isExactLoopbackIp(ip)) {
        return blockedReceipt('NON_LOOPBACK_ADDRESS_FORBIDDEN');
      }
    }
  }

  if (Object.hasOwn(observation, 'loopbackEndpoints')) {
    for (const endpoint of observation.loopbackEndpoints) {
      const endpointStatus = classifyLoopbackHttpsEndpoint(endpoint);
      if (endpointStatus !== 'OK') {
        return blockedReceipt(endpointStatus);
      }
    }
  }

  const strippedSet = new Set();
  let diagnosticNoteCount = 0;
  if (Object.hasOwn(observation, 'diagnosticNotes')) {
    diagnosticNoteCount = observation.diagnosticNotes.length;
    for (const note of observation.diagnosticNotes) {
      const sanitized = stripPrivateWorkstationIdentifiers(note);
      if (sanitized.strippedCategories.includes('token')) {
        return blockedReceipt('SECRET_OR_TOKEN_FORBIDDEN');
      }
      if (sanitized.strippedCategories.includes('mac-address')) {
        return blockedReceipt('PRIVATE_IDENTIFIER_FORBIDDEN');
      }
      if (sanitized.strippedCategories.includes('non-loopback-ip')) {
        return blockedReceipt('NON_LOOPBACK_ADDRESS_FORBIDDEN');
      }
      if (privacyMode === 'strict' && sanitized.strippedCategories.includes('username')) {
        return blockedReceipt('PRIVATE_IDENTIFIER_FORBIDDEN');
      }
      for (const category of sanitized.strippedCategories) {
        strippedSet.add(category);
      }
    }
  }

  if (observation.nodeVersion !== PINNED_WORKSTATION_TOOLCHAIN.nodeVersion) {
    return blockedReceipt('NODE_VERSION_MISMATCH');
  }
  if (observation.dotnetSdkVersion !== PINNED_WORKSTATION_TOOLCHAIN.dotnetSdkVersion) {
    return blockedReceipt('DOTNET_SDK_VERSION_MISMATCH');
  }
  if (observation.aspireCliVersion !== PINNED_WORKSTATION_TOOLCHAIN.aspireCliVersion) {
    return blockedReceipt('ASPIRE_CLI_VERSION_MISMATCH');
  }

  for (const [key, expectedValue] of Object.entries(REQUIRED_TELEMETRY_OPTOUTS)) {
    if (effectiveEnv[key] !== expectedValue) {
      return blockedReceipt('TELEMETRY_OPTOUT_MISSING');
    }
  }

  if (
    observation.osRootTrustStoreModified !== false ||
    (Object.hasOwn(effectiveEnv, 'ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE') &&
      effectiveEnv.ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE !== 'false')
  ) {
    return blockedReceipt('OS_ROOT_TRUST_MODIFIED');
  }

  for (const [key, expectedValue] of Object.entries(REQUIRED_SECURE_LOOPBACK_ENV)) {
    if (effectiveEnv[key] !== expectedValue) {
      return blockedReceipt('INSECURE_LOOPBACK_POSTURE');
    }
  }

  for (const endpointEnvKey of [
    'ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL',
    'ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL'
  ]) {
    if (Object.hasOwn(effectiveEnv, endpointEnvKey)) {
      const status = classifyLoopbackHttpsEndpoint(effectiveEnv[endpointEnvKey]);
      if (status !== 'OK') {
        return blockedReceipt(status);
      }
    }
  }

  if (
    Object.hasOwn(effectiveEnv, 'ASPIRE_DASHBOARD_PERSISTENCE_MODE') &&
    effectiveEnv.ASPIRE_DASHBOARD_PERSISTENCE_MODE !== 'Run'
  ) {
    return blockedReceipt('INSECURE_LOOPBACK_POSTURE');
  }

  if (Object.hasOwn(effectiveEnv, 'ASPIRE_CLI_START_TIMEOUT')) {
    const parsedTimeout = Number(effectiveEnv.ASPIRE_CLI_START_TIMEOUT);
    if (
      !/^[1-9][0-9]{0,2}$/.test(effectiveEnv.ASPIRE_CLI_START_TIMEOUT) ||
      parsedTimeout > 600
    ) {
      return blockedReceipt('INSECURE_LOOPBACK_POSTURE');
    }
  }

  if (
    (Object.hasOwn(effectiveEnv, 'NO_PROXY') && !validateNoProxyValue(effectiveEnv.NO_PROXY)) ||
    (Object.hasOwn(effectiveEnv, 'no_proxy') && !validateNoProxyValue(effectiveEnv.no_proxy)) ||
    (Object.hasOwn(effectiveEnv, 'NO_PROXY') &&
      Object.hasOwn(effectiveEnv, 'no_proxy') &&
      effectiveEnv.NO_PROXY !== effectiveEnv.no_proxy)
  ) {
    return blockedReceipt('PROXY_INTERCEPTION_FORBIDDEN');
  }

  for (const dirEnvKey of ['ASPIRE_HOME', 'ASPIRE_DASHBOARD_DATA_DIRECTORY']) {
    if (Object.hasOwn(effectiveEnv, dirEnvKey)) {
      const dirCheck = validateScopedWorkstationPath(effectiveEnv[dirEnvKey], osFamily, false);
      if (!dirCheck.ok) {
        return blockedReceipt(
          dirCheck.reason === 'INVALID_PATH' ? 'INSECURE_LOOPBACK_POSTURE' : dirCheck.reason
        );
      }
      if (dirCheck.homeStripped) {
        strippedSet.add('home-directory');
      }
    }
  }

  if (!Object.hasOwn(effectiveEnv, 'NODE_EXTRA_CA_CERTS')) {
    return blockedReceipt('INVALID_OR_UNREADABLE_PEM_CA');
  }

  const caPathCheck = validateScopedWorkstationPath(
    effectiveEnv.NODE_EXTRA_CA_CERTS,
    osFamily,
    true
  );
  if (!caPathCheck.ok) {
    return blockedReceipt(
      caPathCheck.reason === 'INVALID_PATH' ? 'INVALID_OR_UNREADABLE_PEM_CA' : caPathCheck.reason
    );
  }
  if (caPathCheck.homeStripped) {
    strippedSet.add('home-directory');
  }

  const pemCheck = validatePemCertificateContent(observation.pemCa);
  if (!pemCheck.ok) {
    return blockedReceipt(pemCheck.reason);
  }

  return Object.freeze({
    shadow: true,
    compatible: true,
    state: 'compatible',
    nonBlockingOptionalP2: true,
    operationalOrchestratorAllowed: false,
    liveDispatch: false,
    liveMerge: false,
    replacesHostedRunnerValidation: false,
    incrementalSpendUsdCents: 0,
    zeroPrivateData: true,
    reason: 'WORKSTATION_COMPATIBILITY_VERIFIED',
    osFamily,
    arch: observation.arch,
    toolchain: PINNED_WORKSTATION_TOOLCHAIN,
    telemetryOptOutVerified: true,
    loopbackHttpsVerified: true,
    caCertificate: Object.freeze({
      source: 'NODE_EXTRA_CA_CERTS',
      readablePem: true,
      certificateCount: pemCheck.certificateCount,
      osRootTrustStoreModified: false,
      pathRedacted: true,
      homeDirectoryStripped: caPathCheck.homeStripped
    }),
    strippedPrivateCategories: Object.freeze([...strippedSet].sort()),
    diagnosticNoteCount,
    headSha
  });
}

const DEFAULT_FS_DEPS = Object.freeze({
  open: openSync,
  fstat: fstatSync,
  lstat: lstatSync,
  realpath: realpathSync,
  read: readSync,
  close: closeSync,
  openFlags: SAFE_READ_FLAGS
});

function hasSymlinkedAncestor(rawPath, resolvedPath) {
  const rawNorm = rawPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const realNorm = resolvedPath.replaceAll('\\', '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(rawNorm)) {
    return rawNorm.toLowerCase() !== realNorm.toLowerCase();
  }
  if (rawNorm === realNorm) {
    return false;
  }
  if (
    (rawNorm.startsWith('/tmp/') || rawNorm.startsWith('/var/')) &&
    realNorm === `/private${rawNorm}`
  ) {
    return false;
  }
  return true;
}

export function inspectPemCaFile(caPath, fsDeps = DEFAULT_FS_DEPS) {
  if (
    typeof caPath !== 'string' ||
    caPath.trim().length === 0 ||
    caPath.length > MAX_PATH_CHARS ||
    CONTROL_CHAR_RE.test(caPath)
  ) {
    return Object.freeze({
      readable: false,
      isRegularFile: false,
      isSymbolicLink: false,
      pemContent: ''
    });
  }
  let fd;
  try {
    fd = fsDeps.open(caPath, fsDeps.openFlags);
  } catch (error) {
    const isSymlinkLoop = Boolean(error && typeof error === 'object' && error.code === 'ELOOP');
    let detectedSymlink = isSymlinkLoop;
    if (!detectedSymlink) {
      try {
        detectedSymlink = fsDeps.lstat(caPath).isSymbolicLink();
      } catch {
        detectedSymlink = false;
      }
    }
    return Object.freeze({
      readable: false,
      isRegularFile: false,
      isSymbolicLink: detectedSymlink,
      pemContent: ''
    });
  }
  try {
    const info = fsDeps.fstat(fd);
    const linkStat = fsDeps.lstat(caPath);
    if (linkStat.isSymbolicLink()) {
      return Object.freeze({
        readable: false,
        isRegularFile: false,
        isSymbolicLink: true,
        pemContent: ''
      });
    }
    if (typeof fsDeps.realpath === 'function') {
      const resolvedPath = fsDeps.realpath(caPath);
      const resolvedStat = fsDeps.lstat(resolvedPath);
      if (
        resolvedStat.isSymbolicLink() ||
        resolvedStat.dev !== info.dev ||
        resolvedStat.ino !== info.ino ||
        hasSymlinkedAncestor(caPath, resolvedPath) ||
        isOsRootTrustStorePath(resolvedPath)
      ) {
        return Object.freeze({
          readable: false,
          isRegularFile: false,
          isSymbolicLink: true,
          pemContent: ''
        });
      }
    }
    if (
      !info.isFile() ||
      !linkStat.isFile() ||
      info.dev !== linkStat.dev ||
      info.ino !== linkStat.ino ||
      info.size <= 0 ||
      info.size > MAX_PEM_CA_BYTES ||
      (info.mode & 0o444) === 0
    ) {
      return Object.freeze({
        readable: false,
        isRegularFile: info.isFile(),
        isSymbolicLink: false,
        pemContent: ''
      });
    }
    const buffer = Buffer.alloc(MAX_PEM_CA_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fsDeps.read(fd, buffer, offset, buffer.length - offset, null);
      if (bytes === 0) {
        break;
      }
      offset += bytes;
    }
    if (offset === 0 || offset > MAX_PEM_CA_BYTES) {
      return Object.freeze({
        readable: false,
        isRegularFile: true,
        isSymbolicLink: false,
        pemContent: ''
      });
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const pemContent = decoder.decode(buffer.subarray(0, offset));
    return Object.freeze({
      readable: true,
      isRegularFile: true,
      isSymbolicLink: false,
      pemContent
    });
  } catch {
    return Object.freeze({
      readable: false,
      isRegularFile: false,
      isSymbolicLink: false,
      pemContent: ''
    });
  } finally {
    fsDeps.close(fd);
  }
}

function readOwnDataString(source, targetUpperKey) {
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === 'string' && key.toUpperCase() === targetUpperKey) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') {
        return descriptor.value;
      }
    }
  }
  return '';
}

function defaultExecVersion(binary, args, env) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: readOwnDataString(env, 'PATH'),
        ASPIRE_HOME: readOwnDataString(env, 'ASPIRE_HOME'),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        ASPIRE_CLI_TELEMETRY_OPTOUT: 'true',
        ASPIRE_DASHBOARD_TELEMETRY_OPTOUT: 'true'
      }
    }).trim();
  } catch {
    return '';
  }
}

const COLLECTED_ENV_KEY_SET = new Set([
  ...REQUIRED_ENV_KEYS,
  ...OPTIONAL_ENV_KEYS,
  'NODE_TLS_REJECT_UNAUTHORIZED',
  ...PROXY_ENV_KEYS,
  ...OPERATIONAL_ENV_KEYS
]);

const COLLECT_OPTIONS_KEYS = new Set([
  'env',
  'platform',
  'arch',
  'nodeVersion',
  'kernelRelease',
  'operationalOrchestratorMode',
  'osRootTrustStoreModified',
  'execVersion',
  'inspectCa',
  'resolvePath'
]);

const CLI_OPTIONS_KEYS = new Set(['collect', 'evaluate', 'fsDeps', 'write']);

export function collectWorkstationPreflightObservation(options = {}) {
  if (!isPlainRecord(options) || !Object.keys(options).every(key => COLLECT_OPTIONS_KEYS.has(key))) {
    return Object.freeze({ invalidOptions: true });
  }
  const env = Object.hasOwn(options, 'env') ? options.env : process.env;
  if (env === null || typeof env !== 'object' || types.isProxy(env) || Array.isArray(env)) {
    return Object.freeze({ invalidOptions: true });
  }
  const platform = Object.hasOwn(options, 'platform') ? options.platform : process.platform;
  const arch = Object.hasOwn(options, 'arch') ? options.arch : process.arch;
  const kernelRelease = Object.hasOwn(options, 'kernelRelease') ? options.kernelRelease : osRelease();
  const operationalOrchestratorMode = Object.hasOwn(options, 'operationalOrchestratorMode')
    ? options.operationalOrchestratorMode
    : false;
  let effectiveOsRootTrustStoreModified = Object.hasOwn(options, 'osRootTrustStoreModified')
    ? options.osRootTrustStoreModified
    : false;
  const execVersion = Object.hasOwn(options, 'execVersion') ? options.execVersion : defaultExecVersion;
  const inspectCa = Object.hasOwn(options, 'inspectCa') ? options.inspectCa : inspectPemCaFile;
  const resolvePath = Object.hasOwn(options, 'resolvePath') ? options.resolvePath : realpathSync;

  const resolvedOsFamily = resolveWorkstationOsFamily(platform, kernelRelease, true);
  const resolvedPlatform = resolvedOsFamily === null ? 'unsupported' : resolvedOsFamily;
  const isWindowsPlatform = resolvedPlatform === 'windows-11';
  const filteredEnv = {};
  const seenWindowsCollectedKeys = new Set();
  for (const rawKey of Reflect.ownKeys(env)) {
    if (typeof rawKey !== 'string') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(env, rawKey);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return Object.freeze({ invalidOptions: true });
    }
    if (descriptor.value === undefined) {
      continue;
    }
    const upperKey = rawKey.toUpperCase();
    if (isSecretEnvKey(upperKey)) {
      filteredEnv[upperKey] = '[PRESENT]';
      continue;
    }
    if (
      (COLLECTED_ENV_KEY_SET.has(upperKey) || EXTERNAL_OTEL_KEY_RE.test(upperKey)) &&
      typeof descriptor.value === 'string'
    ) {
      if (isWindowsPlatform) {
        if (seenWindowsCollectedKeys.has(upperKey)) {
          return Object.freeze({ invalidOptions: true });
        }
        seenWindowsCollectedKeys.add(upperKey);
        filteredEnv[upperKey] = descriptor.value;
      } else {
        filteredEnv[rawKey] = descriptor.value;
      }
    }
  }

  for (const pathKey of [
    'NODE_EXTRA_CA_CERTS',
    'ASPIRE_HOME',
    'ASPIRE_DASHBOARD_DATA_DIRECTORY'
  ]) {
    if (typeof filteredEnv[pathKey] === 'string' && filteredEnv[pathKey].length > 0) {
      try {
        const resolvedTarget = resolvePath(filteredEnv[pathKey]);
        if (isOsRootTrustStorePath(resolvedTarget)) {
          effectiveOsRootTrustStoreModified = true;
        } else if (
          pathKey !== 'NODE_EXTRA_CA_CERTS' &&
          hasSymlinkedAncestor(filteredEnv[pathKey], resolvedTarget)
        ) {
          filteredEnv[pathKey] = '';
        }
      } catch {
        // Missing paths remain unchanged so read-only evaluators classify them deterministically.
      }
    }
  }

  const resolvedNodeVersion = Object.hasOwn(options, 'nodeVersion')
    ? options.nodeVersion
    : execVersion(process.execPath, ['--version'], env);
  const dotnetSdkVersion = execVersion('dotnet', ['--version'], env);
  const rawAspireVersion = execVersion('aspire', ['--version'], env);
  const aspireCliVersion = rawAspireVersion.split('+')[0].trim();
  const caPath =
    typeof filteredEnv.NODE_EXTRA_CA_CERTS === 'string' ? filteredEnv.NODE_EXTRA_CA_CERTS : '';
  const pemCa = inspectCa(caPath);

  return Object.freeze({
    platform: resolvedPlatform,
    arch,
    nodeVersion: resolvedNodeVersion,
    dotnetSdkVersion,
    aspireCliVersion,
    operationalOrchestratorMode,
    osRootTrustStoreModified: effectiveOsRootTrustStoreModified,
    env: Object.freeze(filteredEnv),
    pemCa
  });
}

function readBoundedObservationFile(filePath, fsDeps) {
  const fd = fsDeps.open(filePath, fsDeps.openFlags);
  try {
    const info = fsDeps.fstat(fd);
    const linkInfo = fsDeps.lstat(filePath);
    if (
      !info.isFile() ||
      linkInfo.isSymbolicLink() ||
      info.dev !== linkInfo.dev ||
      info.ino !== linkInfo.ino ||
      info.size <= 0 ||
      info.size > MAX_OBSERVATION_JSON_BYTES
    ) {
      throw Error('INVALID_OBSERVATION_FILE');
    }
    const buffer = Buffer.alloc(MAX_OBSERVATION_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fsDeps.read(fd, buffer, offset, buffer.length - offset, null);
      if (bytes === 0) {
        break;
      }
      offset += bytes;
    }
    if (offset === 0 || offset > MAX_OBSERVATION_JSON_BYTES) {
      throw Error('INVALID_OBSERVATION_FILE');
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally {
    fsDeps.close(fd);
  }
}

export function runWorkstationPreflightCli(args, options = {}) {
  const defaultWrite = line => process.stdout.write(`${line}\n`);
  if (!isPlainRecord(options) || !Object.keys(options).every(key => CLI_OPTIONS_KEYS.has(key))) {
    defaultWrite(JSON.stringify(blockedReceipt('INPUT_UNKNOWN')));
    return 1;
  }
  const collect = Object.hasOwn(options, 'collect')
    ? options.collect
    : collectWorkstationPreflightObservation;
  const evaluate = Object.hasOwn(options, 'evaluate')
    ? options.evaluate
    : evaluateWorkstationCompatibilityPreflight;
  const fsDeps = Object.hasOwn(options, 'fsDeps') ? options.fsDeps : DEFAULT_FS_DEPS;
  const write = Object.hasOwn(options, 'write') ? options.write : defaultWrite;

  if (!isDenseArray(args, 16)) {
    write(JSON.stringify(blockedReceipt('INPUT_UNKNOWN')));
    return 1;
  }
  try {
    let observation;
    if (args.length === 0) {
      observation = collect();
    } else if (args.length === 1 && args[0] === '--operational-orchestrator') {
      observation = collect({ operationalOrchestratorMode: true });
    } else if (args.length === 2 && args[0] === '--observation' && typeof args[1] === 'string') {
      observation = readBoundedObservationFile(args[1], fsDeps);
    } else {
      write(JSON.stringify(blockedReceipt('INPUT_UNKNOWN')));
      return 1;
    }

    const receipt = evaluate(observation);
    write(JSON.stringify(receipt));
    return receipt.compatible ? 0 : 1;
  } catch {
    write(JSON.stringify(blockedReceipt('INPUT_UNKNOWN')));
    return 1;
  }
}

export function runCliIfDirect(
  entrypoint,
  moduleUrl,
  args,
  setExitCode = value => {
    process.exitCode = value;
  }
) {
  if (typeof entrypoint === 'string' && entrypoint.length > 0 && pathToFileURL(entrypoint).href === moduleUrl) {
    setExitCode(runWorkstationPreflightCli(args));
    return true;
  }
  return false;
}

runCliIfDirect(process.argv[1], import.meta.url, process.argv.slice(2));
