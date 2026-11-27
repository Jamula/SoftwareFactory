import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALLOWED_LOOPBACK_IPS,
  PINNED_WORKSTATION_TOOLCHAIN,
  REQUIRED_SECURE_LOOPBACK_ENV,
  REQUIRED_TELEMETRY_OPTOUTS,
  SUPPORTED_WORKSTATION_ARCHES,
  SUPPORTED_WORKSTATION_PLATFORMS,
  collectWorkstationPreflightObservation,
  evaluateWorkstationCompatibilityPreflight,
  inspectPemCaFile,
  runCliIfDirect,
  runWorkstationPreflightCli,
  stripPrivateWorkstationIdentifiers
} from '../../tools/engineering-factory/workstation-preflight.mjs';

function createSyntheticLoopbackCertPair() {
  const derLen = n => Buffer.from(n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
  const seq = (...items) => {
    const body = Buffer.concat(items);
    return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
  };
  const set = (...items) => {
    const body = Buffer.concat(items);
    return Buffer.concat([Buffer.from([0x31]), derLen(body.length), body]);
  };
  const oid = bytes => Buffer.concat([Buffer.from([0x06, bytes.length]), Buffer.from(bytes)]);
  const ctx = (tag, body) => Buffer.concat([Buffer.from([0xa0 | tag]), derLen(body.length), body]);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = seq(set(seq(oid([0x55, 0x04, 0x03]), Buffer.from([0x0c, 0x09, ...Buffer.from('localhost')]))));
  const alg = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const validity = seq(
    Buffer.from('170d3235303130313030303030305a', 'hex'),
    Buffer.from('170d3335303130313030303030305a', 'hex')
  );
  const sanVal = seq(Buffer.from([0x87, 0x04, 127, 0, 0, 1]));
  const exts = seq(
    seq(oid([0x55, 0x1d, 0x11]), Buffer.concat([Buffer.from([0x04]), derLen(sanVal.length), sanVal]))
  );
  const tbs = seq(
    ctx(0, Buffer.from([0x02, 0x01, 0x02])),
    Buffer.from([0x02, 0x08, 0x01, ...crypto.randomBytes(7)]),
    alg,
    subject,
    validity,
    subject,
    spki,
    ctx(3, exts)
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(
    tbs,
    alg,
    Buffer.concat([Buffer.from([0x03]), derLen(sig.length + 1), Buffer.from([0x00]), sig])
  );
  return {
    certPem:
      '-----BEGIN CERTIFICATE-----\n' +
      certDer.toString('base64').match(/.{1,64}/g).join('\n') +
      '\n-----END CERTIFICATE-----\n',
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

const { certPem: VALID_PEM_CERT, keyPem: PRIVATE_KEY_PEM } = createSyntheticLoopbackCertPair();

function buildValidObservation(overrides = {}) {
  const baseEnv = {
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    ASPIRE_CLI_TELEMETRY_OPTOUT: 'true',
    ASPIRE_DASHBOARD_TELEMETRY_OPTOUT: 'true',
    ASPIRE_ALLOW_UNSECURED_TRANSPORT: 'false',
    ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: 'false',
    NODE_EXTRA_CA_CERTS: '/tmp/sf-workstation.12345678/aspire-dev.pem',
    ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://127.0.0.1:18890'
  };
  return {
    platform: 'linux',
    arch: 'x64',
    nodeVersion: 'v26.13.1',
    dotnetSdkVersion: '10.0.404',
    aspireCliVersion: '17.0.0',
    operationalOrchestratorMode: false,
    osRootTrustStoreModified: false,
    env: baseEnv,
    pemCa: {
      readable: true,
      isRegularFile: true,
      isSymbolicLink: false,
      pemContent: VALID_PEM_CERT
    },
    ...overrides
  };
}

test('exported workstation preflight constants are frozen and match pinned repository invariants', () => {
  assert.ok(Object.isFrozen(PINNED_WORKSTATION_TOOLCHAIN));
  assert.deepEqual(PINNED_WORKSTATION_TOOLCHAIN, {
    nodeVersion: 'v26.13.1',
    dotnetSdkVersion: '10.0.404',
    aspireCliVersion: '17.0.0'
  });
  assert.deepEqual(SUPPORTED_WORKSTATION_PLATFORMS, ['windows-11', 'macos', 'linux', 'wsl2']);
  assert.deepEqual(SUPPORTED_WORKSTATION_ARCHES, ['x64', 'arm64']);
  assert.deepEqual(REQUIRED_TELEMETRY_OPTOUTS, {
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    ASPIRE_CLI_TELEMETRY_OPTOUT: 'true',
    ASPIRE_DASHBOARD_TELEMETRY_OPTOUT: 'true'
  });
  assert.deepEqual(REQUIRED_SECURE_LOOPBACK_ENV, {
    ASPIRE_ALLOW_UNSECURED_TRANSPORT: 'false',
    ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: 'false'
  });
  assert.deepEqual(ALLOWED_LOOPBACK_IPS, ['127.0.0.1', '::1']);
});

test('verifies Windows 11, macOS, Linux, and WSL2 workstations and strips home-directory PII from receipts', () => {
  const cases = [
    {
      platform: 'windows-11',
      expectedOs: 'windows-11',
      arch: 'x64',
      caPath: 'C:\\Users\\syntheticAlice\\AppData\\Local\\Temp\\sf-workstation-01\\aspire-dev.pem',
      extraEnv: {
        ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE: 'false',
        ASPIRE_HOME: 'C:\\Users\\syntheticAlice\\AppData\\Local\\Temp\\sf-workstation-01\\aspire-home',
        ASPIRE_DASHBOARD_DATA_DIRECTORY:
          'C:\\Users\\syntheticAlice\\AppData\\Local\\Temp\\sf-workstation-01\\dashboard-data',
        ASPIRE_DASHBOARD_PERSISTENCE_MODE: 'Run',
        ASPIRE_CLI_START_TIMEOUT: '60',
        NO_PROXY: 'localhost,127.0.0.1,::1,[::1]'
      },
      expectHomeStripped: true
    },
    {
      platform: 'win32',
      osRelease: '10.0.22631',
      expectedOs: 'windows-11',
      arch: 'arm64',
      caPath: 'D:/sf-temp/aspire-dev.crt',
      extraEnv: {
        aspire_home: 'D:/sf-temp/aspire-home',
        no_proxy: '*'
      },
      expectHomeStripped: false
    },
    {
      platform: 'macos',
      expectedOs: 'macos',
      arch: 'arm64',
      caPath: '/Users/syntheticBob/.cache/sf-workstation.abcd1234/aspire-dev.pem',
      extraEnv: {
        ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL: 'https://localhost:18891',
        NODE_OPTIONS: '--max-old-space-size=4096',
        OPENAI_AGENTS_DISABLE_TRACING: '1',
        no_proxy: 'localhost,127.0.0.1,::1'
      },
      expectHomeStripped: true
    },
    {
      platform: 'darwin',
      osRelease: '24.1.0',
      expectedOs: 'macos',
      arch: 'x64',
      caPath: '/private/var/folders/ab/cd1234/T/sf-workstation.abcd/aspire-dev.pem',
      extraEnv: {},
      expectHomeStripped: true
    },
    {
      platform: 'linux',
      osRelease: '6.8.0-45-generic',
      expectedOs: 'linux',
      arch: 'x64',
      caPath: '/home/syntheticCarol/.cache/sf-workstation.99887766/aspire-dev.pem',
      extraEnv: {},
      expectHomeStripped: true
    },
    {
      platform: 'wsl2',
      osRelease: '5.15.167.4-microsoft-standard-WSL2',
      expectedOs: 'wsl2',
      arch: 'x64',
      caPath: '/run/user/1000/sf-workstation.55443322/aspire-dev.pem',
      extraEnv: {},
      expectHomeStripped: true
    }
  ];

  const headSha = 'cec2745b7b8a21e77ad9f2839d4255d42305d419';
  for (const scenario of cases) {
    const obs = buildValidObservation({
      platform: scenario.platform,
      ...(scenario.osRelease ? { osRelease: scenario.osRelease } : {}),
      arch: scenario.arch,
      authoritativeLeaseStore: false,
      hostedWorkerHost: false,
      replacesHostedRunnerValidation: false,
      incrementalSpendUsdCents: 0,
      headSha,
      observedIpAddresses: ['127.0.0.1', '::1', '[::1]'],
      loopbackEndpoints: ['https://127.0.0.1:18890', 'https://[::1]:18888', 'https://localhost:18891'],
      diagnosticNotes: [
        'Verified loopback 127.0.0.1 and [::1] using /home/syntheticCarol/.cache/aspire-dev.pem'
      ],
      env: {
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        ASPIRE_CLI_TELEMETRY_OPTOUT: 'true',
        ASPIRE_DASHBOARD_TELEMETRY_OPTOUT: 'true',
        ASPIRE_ALLOW_UNSECURED_TRANSPORT: 'false',
        ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: 'false',
        NODE_EXTRA_CA_CERTS: scenario.caPath,
        ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://127.0.0.1:18890',
        ...scenario.extraEnv
      },
      pemCa: {
        readable: true,
        isRegularFile: true,
        isSymbolicLink: false,
        pemContent: `${VALID_PEM_CERT}\n${VALID_PEM_CERT}`
      }
    });

    const receipt = evaluateWorkstationCompatibilityPreflight(obs);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.caCertificate));
    assert.ok(Object.isFrozen(receipt.strippedPrivateCategories));
    assert.ok(Object.isFrozen(receipt.sanitizedNotes));
    assert.equal(receipt.shadow, true);
    assert.equal(receipt.compatible, true);
    assert.equal(receipt.state, 'compatible');
    assert.equal(receipt.nonBlockingOptionalP2, true);
    assert.equal(receipt.operationalOrchestratorAllowed, false);
    assert.equal(receipt.liveDispatch, false);
    assert.equal(receipt.liveMerge, false);
    assert.equal(receipt.replacesHostedRunnerValidation, false);
    assert.equal(receipt.incrementalSpendUsdCents, 0);
    assert.equal(receipt.zeroPrivateData, true);
    assert.equal(receipt.reason, 'WORKSTATION_COMPATIBILITY_VERIFIED');
    assert.equal(receipt.osFamily, scenario.expectedOs);
    assert.equal(receipt.arch, scenario.arch);
    assert.equal(receipt.telemetryOptOutVerified, true);
    assert.equal(receipt.loopbackHttpsVerified, true);
    assert.equal(receipt.headSha, headSha);
    assert.deepEqual(receipt.caCertificate, {
      source: 'NODE_EXTRA_CA_CERTS',
      readablePem: true,
      certificateCount: 2,
      osRootTrustStoreModified: false,
      pathRedacted: true,
      homeDirectoryStripped: scenario.expectHomeStripped
    });
    assert.deepEqual(receipt.sanitizedNotes, [
      'Verified loopback 127.0.0.1 and [::1] using <redacted-home>/.cache/aspire-dev.pem'
    ]);

    const serialized = JSON.stringify(receipt);
    for (const forbiddenSubstring of [
      'syntheticAlice',
      'syntheticBob',
      'syntheticCarol',
      '1000',
      'sf-workstation',
      'aspire-dev.crt',
      'BEGIN CERTIFICATE'
    ]) {
      assert.equal(serialized.includes(forbiddenSubstring), false);
    }
  }
});

test('enforces strict types.isProxy and plain-object own-enumerable-data-descriptor validation', () => {
  const valid = buildValidObservation();

  for (const nonPlain of [
    null,
    undefined,
    'linux',
    42,
    [],
    new Proxy(valid, {}),
    Object.create(null)
  ]) {
    const res = evaluateWorkstationCompatibilityPreflight(nonPlain);
    assert.equal(res.compatible, false);
    assert.equal(res.reason, 'INPUT_UNKNOWN');
  }

  class ObservationSub {}
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(Object.assign(new ObservationSub(), valid)).reason,
    'INPUT_UNKNOWN'
  );

  let getterInvoked = false;
  const withGetter = buildValidObservation();
  Object.defineProperty(withGetter, 'nodeVersion', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 'v26.13.1';
    }
  });
  assert.equal(evaluateWorkstationCompatibilityPreflight(withGetter).reason, 'INPUT_UNKNOWN');
  assert.equal(getterInvoked, false);

  const withHidden = buildValidObservation();
  Object.defineProperty(withHidden, 'extraHidden', { enumerable: false, value: 1 });
  assert.equal(evaluateWorkstationCompatibilityPreflight(withHidden).reason, 'INPUT_UNKNOWN');

  const withSymbol = buildValidObservation();
  withSymbol[Symbol('tag')] = 'x';
  assert.equal(evaluateWorkstationCompatibilityPreflight(withSymbol).reason, 'INPUT_UNKNOWN');

  const tooManyKeys = {};
  for (let i = 0; i < 65; i++) {
    tooManyKeys[`k${i}`] = i;
  }
  assert.equal(evaluateWorkstationCompatibilityPreflight(tooManyKeys).reason, 'INPUT_UNKNOWN');

  assert.equal(
    evaluateWorkstationCompatibilityPreflight({ ...valid, unexpectedField: true }).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight({ ...valid, nodeVersion: undefined }).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight({ ...valid, env: new Proxy(valid.env, {}) }).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight({ ...valid, pemCa: new Proxy(valid.pemCa, {}) }).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight({
      ...valid,
      pemCa: { ...valid.pemCa, extraKey: true }
    }).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight({
      ...valid,
      pemCa: { ...valid.pemCa, pemContent: 123 }
    }).reason,
    'INPUT_UNKNOWN'
  );

  const sparseArray = ['127.0.0.1'];
  sparseArray.length = 2;
  for (const invalidFields of [
    { platform: 123 },
    { osRelease: 123 },
    { privacyMode: 'permissive' },
    { authoritativeLeaseStore: 'false' },
    { incrementalSpendUsdCents: -1 },
    { incrementalSpendUsdCents: 1.5 },
    { headSha: 'not-a-sha' },
    { observedIpAddresses: new Proxy(['127.0.0.1'], {}) },
    { observedIpAddresses: sparseArray },
    { observedIpAddresses: [127] },
    { loopbackEndpoints: 'https://127.0.0.1:18890' },
    { loopbackEndpoints: [42] },
    { diagnosticNotes: ['bad\u0000note'] },
    { env: { ...valid.env, CUSTOM_UNKNOWN_VAR: '1' } },
    { env: { ...valid.env, NO_PROXY: 123 } },
    { env: { ...valid.env, NO_PROXY: 'localhost\u0000' } }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation(invalidFields)).reason,
      'INPUT_UNKNOWN'
    );
  }

  const nonDataIndexArray = ['127.0.0.1'];
  Object.defineProperty(nonDataIndexArray, '0', {
    enumerable: true,
    get() {
      return '127.0.0.1';
    }
  });
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({ observedIpAddresses: nonDataIndexArray })
    ).reason,
    'INPUT_UNKNOWN'
  );
});

test('rejects operational orchestrator, authoritative lease store, worker host, and incremental spend', () => {
  for (const operationalOverride of [
    { operationalOrchestratorMode: true },
    { authoritativeLeaseStore: true },
    { hostedWorkerHost: true },
    { replacesHostedRunnerValidation: true },
    { env: { ...buildValidObservation().env, FACTORY_OPERATIONAL_ORCHESTRATOR: 'true' } },
    { env: { ...buildValidObservation().env, FACTORY_LEASE_STORE_HOST: 'workstation' } },
    { env: { ...buildValidObservation().env, RUNNER_ENVIRONMENT: 'self-hosted' } }
  ]) {
    const res = evaluateWorkstationCompatibilityPreflight(buildValidObservation(operationalOverride));
    assert.equal(res.compatible, false);
    assert.equal(res.operationalOrchestratorAllowed, false);
    assert.equal(res.reason, 'OPERATIONAL_ORCHESTRATOR_FORBIDDEN');
  }

  const paid = evaluateWorkstationCompatibilityPreflight(
    buildValidObservation({ incrementalSpendUsdCents: 100 })
  );
  assert.equal(paid.compatible, false);
  assert.equal(paid.reason, 'INCREMENTAL_SPEND_FORBIDDEN');
});

test('enforces pinned Node v26.13.1, .NET SDK 10.0.404, Aspire CLI 17.0.0, and supported OS/arch', () => {
  for (const unsupportedPlatformCase of [
    { platform: 'windows-10' },
    { platform: 'win32' },
    { platform: 'win32', osRelease: '10.0.19045' },
    { platform: 'win32', osRelease: 'not-a-version' },
    { platform: 'win32', osRelease: '10.0.22631\u0000' },
    { platform: 'windows-11', osRelease: '10.0.19045' },
    { platform: 'darwin' },
    { platform: 'darwin', osRelease: '19.6.0' },
    { platform: 'darwin', osRelease: 'bad\u0000' },
    { platform: 'macos', osRelease: '18.7.0' },
    { platform: 'wsl2', osRelease: '4.4.0-19041-Microsoft' },
    { platform: 'wsl2', osRelease: 'bad' },
    { platform: 'linux', osRelease: '4.4.0-19041-Microsoft' },
    { platform: 'linux', osRelease: '' },
    { platform: 'linux', arch: 'ia32' }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation(unsupportedPlatformCase)).reason,
      'UNSUPPORTED_PLATFORM'
    );
  }
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({ platform: 'win32', osRelease: '11.0.28000', env: { ...buildValidObservation().env, NODE_EXTRA_CA_CERTS: 'C:\\Temp\\aspire-dev.pem' } })
    ).osFamily,
    'windows-11'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({ platform: 'linux', osRelease: '6.6.36.3-microsoft-standard-WSL2' })
    ).osFamily,
    'wsl2'
  );
  for (const badNode of ['26.13.1', 'v26.13.0', 'v22.14.0', '']) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation({ nodeVersion: badNode })).reason,
      'NODE_VERSION_MISMATCH'
    );
  }
  for (const badDotnet of ['v10.0.404', '10.0.403', '9.0.100', '']) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation({ dotnetSdkVersion: badDotnet })).reason,
      'DOTNET_SDK_VERSION_MISMATCH'
    );
  }
  for (const badAspire of ['v17.0.0', '17.0.1', '17.0.0-preview.1', '']) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation({ aspireCliVersion: badAspire })).reason,
      'ASPIRE_CLI_VERSION_MISMATCH'
    );
  }
});

test('enforces telemetry opt-outs, loopback HTTPS posture, proxy restrictions, and scoped PEM CA without OS root trust edits', () => {
  const baseEnv = buildValidObservation().env;

  for (const telemetryBadEnv of [
    { ...baseEnv, DOTNET_CLI_TELEMETRY_OPTOUT: '0' },
    { ...baseEnv, ASPIRE_CLI_TELEMETRY_OPTOUT: 'false' },
    { ...baseEnv, ASPIRE_DASHBOARD_TELEMETRY_OPTOUT: 'TRUE' },
    { ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://127.0.0.1:4318' },
    { ...baseEnv, OPENAI_AGENTS_DISABLE_TRACING: '0' }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation({ env: telemetryBadEnv })).reason,
      'TELEMETRY_OPTOUT_MISSING'
    );
  }

  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({ env: { ...baseEnv, NODE_TLS_REJECT_UNAUTHORIZED: '0' } })
    ).reason,
    'TLS_VERIFICATION_OVERRIDE_FORBIDDEN'
  );

  for (const proxyBadEnv of [
    { ...baseEnv, HTTPS_PROXY: 'http://127.0.0.1:8080' },
    { ...baseEnv, https_proxy: 'http://127.0.0.1:8080' },
    { ...baseEnv, NODE_USE_ENV_PROXY: '1' },
    { ...baseEnv, NODE_OPTIONS: '--use-env-proxy' },
    { ...baseEnv, NO_PROXY: '' },
    { ...baseEnv, no_proxy: 'corp.internal' },
    { ...baseEnv, NO_PROXY: 'localhost', no_proxy: '127.0.0.1' },
    { ...baseEnv, NO_PROXY: 'localhost,corp.internal' }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation({ env: proxyBadEnv })).reason,
      'PROXY_INTERCEPTION_FORBIDDEN'
    );
  }

  // POSIX rejects lowercase configuration settings while Windows rejects colliding keys
  const { NODE_EXTRA_CA_CERTS: _omittedCa, ...envWithoutCa } = baseEnv;
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(buildValidObservation({ env: envWithoutCa })).reason,
    'INVALID_OR_UNREADABLE_PEM_CA'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({
        env: { ...envWithoutCa, node_extra_ca_certs: '/tmp/aspire-dev.pem' }
      })
    ).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({
        platform: 'windows-11',
        env: {
          ...baseEnv,
          NODE_EXTRA_CA_CERTS: 'C:\\Temp\\aspire-dev.pem',
          dotnet_cli_telemetry_optout: '0'
        }
      })
    ).reason,
    'INPUT_UNKNOWN'
  );

  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({ osRootTrustStoreModified: true })
    ).reason,
    'OS_ROOT_TRUST_MODIFIED'
  );
  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({
        platform: 'windows-11',
        env: {
          ...baseEnv,
          NODE_EXTRA_CA_CERTS: 'C:\\Temp\\aspire-dev.pem',
          ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE: 'true'
        }
      })
    ).reason,
    'OS_ROOT_TRUST_MODIFIED'
  );

  for (const osStoreCase of [
    { platform: 'linux', caPath: '/etc/ssl/certs/aspire-dev.pem' },
    { platform: 'linux', caPath: '/home/dev/.pki/nssdb/aspire-dev.pem' },
    { platform: 'linux', caPath: '/var/home/dev/.pki/nssdb/aspire-dev.pem' },
    { platform: 'macos', caPath: '/private/etc/ssl/aspire-dev.pem' },
    { platform: 'macos', caPath: '/Library/Keychains/System.keychain.pem' },
    { platform: 'macos', caPath: '/System/Volumes/Data/Library/Keychains/System.keychain.pem' },
    { platform: 'macos', caPath: '/Users/dev/Library/Keychains/login.pem' },
    { platform: 'macos', caPath: '/System/Volumes/Data/Users/dev/Library/Keychains/login.pem' },
    { platform: 'wsl2', caPath: '/mnt/c/ProgramData/Microsoft/Crypto/aspire-dev.pem' },
    { platform: 'windows-11', caPath: 'Cert:\\CurrentUser\\Root\\aspire-dev.pem' },
    { platform: 'windows-11', caPath: 'file:///C:/Temp/aspire-dev.pem' },
    { platform: 'windows-11', caPath: 'C:\\Windows\\System32\\aspire-dev.pem' },
    { platform: 'linux', caPath: '/tmp/aspire-dev.pem', aspireHome: '/etc/ssl' }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(
        buildValidObservation({
          platform: osStoreCase.platform,
          env: {
            ...baseEnv,
            NODE_EXTRA_CA_CERTS: osStoreCase.caPath,
            ...(osStoreCase.aspireHome ? { ASPIRE_HOME: osStoreCase.aspireHome } : {})
          }
        })
      ).reason,
      'OS_ROOT_TRUST_MODIFIED'
    );
  }

  for (const insecureEnv of [
    { ...baseEnv, ASPIRE_ALLOW_UNSECURED_TRANSPORT: 'true' },
    { ...baseEnv, ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: 'true' },
    { ...baseEnv, ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'http://127.0.0.1:18890' },
    { ...baseEnv, ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://127.0.0.1:18890/' },
    { ...baseEnv, ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://localhost:18890?' },
    { ...baseEnv, ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://localhost:70000' },
    { ...baseEnv, ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://127.0.0.1/v1/traces' },
    { ...baseEnv, ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://[invalid' },
    { ...baseEnv, ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: '' },
    { ...baseEnv, ASPIRE_DASHBOARD_PERSISTENCE_MODE: 'Disk' },
    { ...baseEnv, ASPIRE_CLI_START_TIMEOUT: '0' },
    { ...baseEnv, ASPIRE_CLI_START_TIMEOUT: '601' },
    { ...baseEnv, ASPIRE_HOME: 'relative/aspire-home' }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation({ env: insecureEnv })).reason,
      'INSECURE_LOOPBACK_POSTURE'
    );
  }

  assert.equal(
    evaluateWorkstationCompatibilityPreflight(
      buildValidObservation({ loopbackEndpoints: ['http://127.0.0.1:18888'] })
    ).reason,
    'INSECURE_LOOPBACK_POSTURE'
  );

  for (const invalidCaCase of [
    { platform: 'linux', caPath: '   ' },
    { platform: 'linux', caPath: 'relative/aspire-dev.pem' },
    { platform: 'linux', caPath: '//network/share/aspire-dev.pem' },
    { platform: 'linux', caPath: '/tmp/../etc/aspire-dev.pem' },
    { platform: 'linux', caPath: '/tmp/aspire-dev.txt' },
    { platform: 'windows-11', caPath: '/tmp/aspire-dev.pem' },
    { platform: 'windows-11', caPath: 'C:\\Temp\\..\\aspire-dev.pem' }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(
        buildValidObservation({
          platform: invalidCaCase.platform,
          env: { ...baseEnv, NODE_EXTRA_CA_CERTS: invalidCaCase.caPath }
        })
      ).reason,
      'INVALID_OR_UNREADABLE_PEM_CA'
    );
  }

  for (const badPemCa of [
    { readable: false, isRegularFile: true, isSymbolicLink: false, pemContent: VALID_PEM_CERT },
    { readable: true, isRegularFile: false, isSymbolicLink: false, pemContent: VALID_PEM_CERT },
    { readable: true, isRegularFile: true, isSymbolicLink: true, pemContent: VALID_PEM_CERT },
    { readable: true, isRegularFile: true, isSymbolicLink: false, pemContent: '' },
    { readable: true, isRegularFile: true, isSymbolicLink: false, pemContent: '   ' },
    {
      readable: true,
      isRegularFile: true,
      isSymbolicLink: false,
      pemContent: `leading-junk\n${VALID_PEM_CERT}`
    },
    {
      readable: true,
      isRegularFile: true,
      isSymbolicLink: false,
      pemContent: `${VALID_PEM_CERT}trailing-junk`
    },
    {
      readable: true,
      isRegularFile: true,
      isSymbolicLink: false,
      pemContent: '-----BEGIN CERTIFICATE-----\nUNCLOSED'
    },
    {
      readable: true,
      isRegularFile: true,
      isSymbolicLink: false,
      pemContent: '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n'
    }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation({ pemCa: badPemCa })).reason,
      'INVALID_OR_UNREADABLE_PEM_CA'
    );
  }
});

test('rejects and strips private workstation identifiers, tokens, MACs, and non-loopback IPs', () => {
  const baseEnv = buildValidObservation().env;

  for (const piiKey of ['username', 'hostname', 'homeDir', 'macAddress', 'loginUrl']) {
    const res = evaluateWorkstationCompatibilityPreflight({
      ...buildValidObservation(),
      [piiKey]: 'synthetic-private-value'
    });
    assert.equal(res.compatible, false);
    assert.equal(res.reason, 'PRIVATE_IDENTIFIER_FORBIDDEN');
    assert.equal(JSON.stringify(res).includes('synthetic-private-value'), false);
  }

  for (const identityVar of ['USER', 'USERNAME', 'HOME', 'HOSTNAME', 'COMPUTERNAME']) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(
        buildValidObservation({ env: { ...baseEnv, [identityVar]: 'syntheticUser' } })
      ).reason,
      'PRIVATE_IDENTIFIER_FORBIDDEN'
    );
  }

  for (const secretScenario of [
    { env: { ...baseEnv, DASHBOARD__API__SECONDARYAPIKEY: 'ABCDEF' } },
    { env: { ...baseEnv, DASHBOARD__API__PRIMARYAPIKEY: 'ABCDEF' } },
    { env: { ...baseEnv, OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-otlp-api-key=secret' } },
    { env: { ...baseEnv, GITHUB_TOKEN: 'ghp_1234567890abcdef' } },
    {
      env: {
        ...baseEnv,
        ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://127.0.0.1:18888/login?t=secret123'
      }
    },
    { loopbackEndpoints: ['https://localhost:18888/login?t=secret123'] },
    { diagnosticNotes: ['Bearer secret_token_value'] },
    { diagnosticNotes: ['AZURE_CLIENT_SECRET=secret_az_val'] },
    { diagnosticNotes: ['{"GITHUB_TOKEN":"synthetic-private-token-value"}'] },
    { diagnosticNotes: ['{\\"GITHUB_TOKEN\\":\\"synthetic-private-token-value\\"}'] },
    { diagnosticNotes: ['{"x-api-key":"secret_json_header"}'] },
    { diagnosticNotes: ['X-API-Key: secret_header_val'] },
    { diagnosticNotes: ['npm_1234567890abcdef1234567890abcdef'] },
    {
      pemCa: {
        readable: true,
        isRegularFile: true,
        isSymbolicLink: false,
        pemContent: `${VALID_PEM_CERT}\n${PRIVATE_KEY_PEM}`
      }
    },
    {
      pemCa: {
        readable: true,
        isRegularFile: true,
        isSymbolicLink: false,
        pemContent: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecretpgp\n-----END PGP PRIVATE KEY BLOCK-----'
      }
    }
  ]) {
    const res = evaluateWorkstationCompatibilityPreflight(buildValidObservation(secretScenario));
    assert.equal(res.compatible, false);
    assert.equal(res.reason, 'SECRET_OR_TOKEN_FORBIDDEN');
    assert.equal(JSON.stringify(res).includes('secret'), false);
  }

  for (const badIpScenario of [
    { observedIpAddresses: ['127.0.0.1', '192.168.1.44'] },
    { observedIpAddresses: ['127.0.0.2'] },
    { observedIpAddresses: ['0.0.0.0'] },
    { observedIpAddresses: ['fe80::1'] },
    { observedIpAddresses: ['::1%eth0'] },
    { observedIpAddresses: ['not-an-ip'] },
    { loopbackEndpoints: ['https://workstation.local:18890'] },
    { loopbackEndpoints: ['https://2130706433:18890'] },
    { loopbackEndpoints: ['https://127.1:18890'] },
    { loopbackEndpoints: ['https://[0:0:0:0:0:0:0:1]:18890'] },
    {
      env: {
        ...baseEnv,
        ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL: 'https://10.0.0.12:18890'
      }
    },
    { diagnosticNotes: ['Connected to 172.16.0.10.'] },
    { diagnosticNotes: ['Connected to 2001:db8::1.'] },
    { diagnosticNotes: ['addr:2001:db8::1'] },
    { diagnosticNotes: ['2001:db8::1: connection refused'] }
  ]) {
    const res = evaluateWorkstationCompatibilityPreflight(buildValidObservation(badIpScenario));
    assert.equal(res.compatible, false);
    assert.equal(res.reason, 'NON_LOOPBACK_ADDRESS_FORBIDDEN');
  }

  for (const piiNoteScenario of [
    { loopbackEndpoints: ['https://alice@127.0.0.1:18890'] },
    { env: { ...baseEnv, NODE_OPTIONS: '--title=00:1A:2B:3C:4D:5E' } },
    { diagnosticNotes: ['nic:00:1a:2b:3c:4d:5e: up'] },
    { diagnosticNotes: ['Active session for alice@example.com'] }
  ]) {
    assert.equal(
      evaluateWorkstationCompatibilityPreflight(buildValidObservation(piiNoteScenario)).reason,
      'PRIVATE_IDENTIFIER_FORBIDDEN'
    );
  }

  const strippedMode = evaluateWorkstationCompatibilityPreflight(
    buildValidObservation({
      privacyMode: 'strip',
      diagnosticNotes: [
        'Session {"username":"syntheticDev"} email syntheticDev@example.org at /Users/syntheticDev/work',
        'Spaced C:\\Users\\Jane Doe\\certs\\aspire-dev.pem and C:\\Users\\Jane Doe\\source\\repo and "C:\\Users\\Jane Doe"',
        'WSL /mnt/c/Users/Jane Doe/source/repo and //wsl.localhost/Ubuntu/home/Jane Doe/source/repo',
        'macOS /System/Volumes/Data/Users/Jane Doe/certs/cert.pem and /users/alice/.cache/cert.pem',
        'Linux /var/home/jane doe/certs/cert.pem on ::1.'
      ]
    })
  );
  assert.equal(strippedMode.compatible, true);
  assert.deepEqual(strippedMode.strippedPrivateCategories, ['home-directory', 'username']);
  const strippedSerialized = JSON.stringify(strippedMode);
  for (const forbidden of ['syntheticDev', 'Jane', 'Doe', 'jane', 'doe', 'alice']) {
    assert.equal(strippedSerialized.includes(forbidden), false);
  }

  assert.equal(
    stripPrivateWorkstationIdentifiers('C:\\Users\\Jane Doe').sanitizedText,
    '<redacted-home>'
  );
  assert.equal(stripPrivateWorkstationIdentifiers(null), null);
  assert.equal(stripPrivateWorkstationIdentifiers('bad\u0007text'), null);

  const clean = stripPrivateWorkstationIdentifiers(
    'Node v26.13.1 .NET 10.0.404 Aspire 17.0.0 loopback 127.0.0.1 [::1] ::1. :foo 10:05:12 999.999.999.999 [dead:beef] host@domain.123 -----BEGIN CERTIFICATE-----'
  );
  assert.equal(clean.containsPrivateData, false);
  assert.deepEqual(clean.strippedCategories, []);

  const redacted = stripPrivateWorkstationIdentifiers(
    [
      'wsl=\\\\wsl$\\Ubuntu\\home\\alice\\cert.pem',
      'win=C:\\Users\\alice\\temp',
      'url=https://alice:pw@127.0.0.1:18888/login?t=tok999',
      'env=GITHUB_TOKEN=ghp_abcd1234',
      'hdr=x-otlp-api-key: otlp_secret_val',
      'mac1=AA-BB-CC-DD-EE-FF',
      'mac2=001a.2b3c.4d5e',
      'ip4=192.168.1.50.',
      'ip6=[fe80::1%eth0]',
      'ip6raw=addr:2001:db8::1.',
      `key=${PRIVATE_KEY_PEM}`,
      'pgp=-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecretpgp\n-----END PGP PRIVATE KEY BLOCK-----',
      'unclosed=-----BEGIN RSA PRIVATE KEY-----secrettail'
    ].join(' ')
  );
  assert.equal(redacted.containsPrivateData, true);
  assert.deepEqual(redacted.strippedCategories, [
    'home-directory',
    'mac-address',
    'non-loopback-ip',
    'token',
    'username'
  ]);
  for (const leaked of ['alice', 'tok999', 'ghp_abcd1234', 'otlp_secret_val', 'AA-BB-CC', '001a.2b3c', '192.168.1.50', 'fe80', '2001:db8', 'secretpgp', 'secrettail']) {
    assert.equal(redacted.sanitizedText.includes(leaked), false);
  }
  assert.equal(redacted.sanitizedText.includes('127.0.0.1'), true);
});

test('inspectPemCaFile, collectWorkstationPreflightObservation, and CLI remain read-only and fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-preflight-test-'));
  try {
    const validPemPath = join(dir, 'aspire-dev.pem');
    writeFileSync(validPemPath, VALID_PEM_CERT, { mode: 0o600 });
    const inspected = inspectPemCaFile(validPemPath);
    assert.equal(inspected.readable, true);
    assert.equal(inspected.isRegularFile, true);
    assert.equal(inspected.isSymbolicLink, false);
    assert.equal(inspected.pemContent, VALID_PEM_CERT);

    assert.deepEqual(inspectPemCaFile(''), {
      readable: false,
      isRegularFile: false,
      isSymbolicLink: false,
      pemContent: ''
    });
    assert.deepEqual(inspectPemCaFile(join(dir, 'missing.pem')), {
      readable: false,
      isRegularFile: false,
      isSymbolicLink: false,
      pemContent: ''
    });

    const emptyPath = join(dir, 'empty.pem');
    writeFileSync(emptyPath, '', { mode: 0o600 });
    assert.equal(inspectPemCaFile(emptyPath).readable, false);

    const symlinkPath = join(dir, 'symlink.pem');
    symlinkSync(validPemPath, symlinkPath);
    const symlinkInspected = inspectPemCaFile(symlinkPath);
    assert.equal(symlinkInspected.readable, false);
    assert.equal(symlinkInspected.isSymbolicLink, true);

    assert.equal(
      inspectPemCaFile('/synthetic/eloop.pem', {
        open() {
          const err = new Error('ELOOP');
          err.code = 'ELOOP';
          throw err;
        },
        fstat: () => ({}),
        lstat: () => ({ isSymbolicLink: () => true }),
        read: () => 0,
        close() {},
        openFlags: 0
      }).isSymbolicLink,
      true
    );

    assert.equal(
      inspectPemCaFile('/synthetic/race-symlink.pem', {
        open: () => 9,
        fstat: () => ({ isFile: () => true, dev: 1, ino: 1, size: 10, mode: 0o600 }),
        lstat: () => ({ isSymbolicLink: () => true, isFile: () => false, dev: 1, ino: 2 }),
        read: () => 0,
        close() {},
        openFlags: 0
      }).isSymbolicLink,
      true
    );

    assert.equal(
      inspectPemCaFile('/synthetic/zero-read.pem', {
        open: () => 9,
        fstat: () => ({ isFile: () => true, dev: 1, ino: 1, size: 10, mode: 0o600 }),
        lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 1 }),
        read: () => 0,
        close() {},
        openFlags: 0
      }).readable,
      false
    );

    assert.equal(
      inspectPemCaFile('/synthetic/bad-utf8.pem', {
        open: () => 9,
        fstat: () => ({ isFile: () => true, dev: 1, ino: 1, size: 2, mode: 0o600 }),
        lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 1 }),
        read: (_fd, buf, offset) => {
          if (offset > 0) return 0;
          buf[0] = 0xff;
          buf[1] = 0xfe;
          return 2;
        },
        close() {},
        openFlags: 0
      }).readable,
      false
    );

    // Exercise defaultExecVersion both succeeding (node --version) and failing (empty PATH for dotnet/aspire)
    const envWithSymbol = {
      PATH: '',
      USER: 'ambientUser',
      HOME: '/home/ambientUser',
      GITHUB_TOKEN: 'ghp_secret',
      http_proxy: 'http://10.0.0.5:8080',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.com',
      UNDEFINED_VAR: undefined,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      dotnet_cli_telemetry_optout: '0',
      [Symbol('ignored')]: 'x'
    };
    const liveCollected = collectWorkstationPreflightObservation({
      env: envWithSymbol,
      platform: 'linux',
      kernelRelease: '5.15.167.4-microsoft-standard-WSL2'
    });
    assert.ok(Object.isFrozen(liveCollected));
    assert.ok(Object.isFrozen(liveCollected.env));
    assert.equal(liveCollected.platform, 'wsl2');
    assert.ok(liveCollected.nodeVersion.startsWith('v'));
    assert.equal(liveCollected.dotnetSdkVersion, '');
    assert.equal(liveCollected.aspireCliVersion, '');
    assert.equal(Object.hasOwn(liveCollected.env, 'USER'), false);
    assert.equal(Object.hasOwn(liveCollected.env, 'HOME'), false);
    assert.equal(liveCollected.env.GITHUB_TOKEN, '[PRESENT]');
    assert.equal(liveCollected.env.http_proxy, 'http://10.0.0.5:8080');
    assert.equal(liveCollected.env.DOTNET_CLI_TELEMETRY_OPTOUT, '1');
    assert.equal(liveCollected.env.dotnet_cli_telemetry_optout, '0');
    assert.equal(liveCollected.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, 'https://collector.example.com');

    // WSL1 and Windows 10 releases are classified as unsupported during collection
    assert.equal(
      collectWorkstationPreflightObservation({
        env: {},
        platform: 'linux',
        kernelRelease: '4.4.0-19041-Microsoft',
        nodeVersion: 'v26.13.1',
        execVersion: () => '10.0.404'
      }).platform,
      'unsupported'
    );
    assert.equal(
      collectWorkstationPreflightObservation({
        env: {},
        platform: 'win32',
        kernelRelease: '10.0.19045',
        nodeVersion: 'v26.13.1',
        execVersion: () => '10.0.404'
      }).platform,
      'unsupported'
    );
    const win11Collected = collectWorkstationPreflightObservation({
      env: { node_extra_ca_certs: validPemPath },
      platform: 'win32',
      kernelRelease: '10.0.22631',
      nodeVersion: 'v26.13.1',
      execVersion: () => '10.0.404'
    });
    assert.equal(win11Collected.platform, 'windows-11');
    assert.equal(win11Collected.env.NODE_EXTRA_CA_CERTS, validPemPath);

    assert.deepEqual(
      collectWorkstationPreflightObservation({
        env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', dotnet_cli_telemetry_optout: '0' },
        platform: 'win32',
        kernelRelease: '10.0.22631',
        nodeVersion: 'v26.13.1',
        execVersion: () => '10.0.404'
      }),
      { invalidOptions: true }
    );

    assert.deepEqual(collectWorkstationPreflightObservation(null), { invalidOptions: true });
    assert.deepEqual(collectWorkstationPreflightObservation(new Proxy({}, {})), { invalidOptions: true });
    assert.deepEqual(collectWorkstationPreflightObservation({ env: new Proxy({}, {}) }), {
      invalidOptions: true
    });
    const envWithGetter = {};
    Object.defineProperty(envWithGetter, 'HTTP_PROXY', {
      enumerable: true,
      get() {
        throw Error('must not invoke getter');
      }
    });
    assert.deepEqual(collectWorkstationPreflightObservation({ env: envWithGetter }), {
      invalidOptions: true
    });

    const mockedCollected = collectWorkstationPreflightObservation({
      env: {
        PATH: '/usr/bin',
        ASPIRE_HOME: '/tmp/aspire-home',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        ASPIRE_CLI_TELEMETRY_OPTOUT: 'true',
        ASPIRE_DASHBOARD_TELEMETRY_OPTOUT: 'true',
        ASPIRE_ALLOW_UNSECURED_TRANSPORT: 'false',
        ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: 'false',
        NODE_EXTRA_CA_CERTS: validPemPath
      },
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v26.13.1',
      kernelRelease: '6.8.0-generic',
      execVersion: bin => (bin === 'dotnet' ? '10.0.404' : '17.0.0+abc1234')
    });
    assert.equal(mockedCollected.platform, 'linux');
    assert.equal(mockedCollected.aspireCliVersion, '17.0.0');

    const lines = [];
    const okExit = runWorkstationPreflightCli([], {
      collect: () => mockedCollected,
      write: line => lines.push(line)
    });
    assert.equal(okExit, 0);
    assert.equal(JSON.parse(lines.at(-1)).compatible, true);

    const orchExit = runWorkstationPreflightCli(['--operational-orchestrator'], {
      collect: opts => ({ ...mockedCollected, ...opts }),
      write: line => lines.push(line)
    });
    assert.equal(orchExit, 1);
    assert.equal(JSON.parse(lines.at(-1)).reason, 'OPERATIONAL_ORCHESTRATOR_FORBIDDEN');

    const obsPath = join(dir, 'observation.json');
    writeFileSync(obsPath, JSON.stringify(buildValidObservation()), { mode: 0o600 });
    assert.equal(
      runWorkstationPreflightCli(['--observation', obsPath], {
        write: line => lines.push(line)
      }),
      0
    );

    const emptyObsPath = join(dir, 'obs-empty.json');
    writeFileSync(emptyObsPath, '', { mode: 0o600 });
    assert.equal(
      runWorkstationPreflightCli(['--observation', emptyObsPath], {
        write: line => lines.push(line)
      }),
      1
    );

    const obsSymlink = join(dir, 'obs-link.json');
    symlinkSync(obsPath, obsSymlink);
    assert.equal(
      runWorkstationPreflightCli(['--observation', obsSymlink], {
        write: line => lines.push(line)
      }),
      1
    );
    assert.equal(
      runWorkstationPreflightCli(['--observation', obsPath], {
        fsDeps: {
          open: () => 5,
          fstat: () => ({ isFile: () => true, dev: 1, ino: 1, size: 10 }),
          lstat: () => ({ isSymbolicLink: () => false, dev: 1, ino: 1 }),
          read: () => 0,
          close() {},
          openFlags: 0
        },
        write: line => lines.push(line)
      }),
      1
    );
    assert.equal(
      runWorkstationPreflightCli(['--unknown-flag'], { write: line => lines.push(line) }),
      1
    );
    assert.equal(
      runWorkstationPreflightCli([], {
        collect: () => {
          throw Error('simulated collector failure');
        },
        write: line => lines.push(line)
      }),
      1
    );
    assert.equal(
      runWorkstationPreflightCli(new Proxy(['--unknown-flag'], {}), { write: line => lines.push(line) }),
      1
    );
    assert.equal(
      runWorkstationPreflightCli(null, { write: line => lines.push(line) }),
      1
    );

    const origWriteForBadOpts = process.stdout.write;
    process.stdout.write = () => true;
    try {
      assert.equal(runWorkstationPreflightCli([], null), 1);
      assert.equal(runWorkstationPreflightCli([], new Proxy({}, {})), 1);
    } finally {
      process.stdout.write = origWriteForBadOpts;
    }

    const moduleHref = pathToFileURL(join(dir, 'workstation-preflight.mjs')).href;
    let recordedCode = null;
    assert.equal(runCliIfDirect('', moduleHref, [], code => { recordedCode = code; }), false);
    assert.equal(recordedCode, null);

    const previousExitCode = process.exitCode;
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      assert.equal(
        runCliIfDirect(join(dir, 'workstation-preflight.mjs'), moduleHref, ['--bad'], code => {
          recordedCode = code;
        }),
        true
      );
      assert.equal(recordedCode, 1);
      assert.equal(
        runCliIfDirect(join(dir, 'workstation-preflight.mjs'), moduleHref, ['--observation', obsPath]),
        true
      );
      assert.equal(process.exitCode, 0);
    } finally {
      process.stdout.write = origWrite;
      process.exitCode = previousExitCode;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
