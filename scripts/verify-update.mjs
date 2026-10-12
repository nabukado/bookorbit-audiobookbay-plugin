/**
 * Verifies the signed update for this plugin.
 *
 *   node scripts/verify-update.mjs [type]              verify updates/<type>.json against the runtime
 *   node scripts/verify-update.mjs [type] --preflight   only check the runtime is packageable
 *   node scripts/verify-update.mjs [type] --selftest    check the signing pipeline itself
 *
 * The checks mirror what BookOrbit's plugin update service enforces before it will install anything,
 * so a manifest that passes here is one it should accept. `--selftest` needs no key and writes nothing:
 * it generates a throwaway Ed25519 pair, runs the documented marker substitution to build a candidate
 * source, and verifies the resulting signature, which is what catches a broken marker or a wrong
 * signing input.
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = args.filter((value) => value.startsWith('-'));
const positional = args.filter((value) => !value.startsWith('-'));
const type = positional[0] ?? 'audiobookbay';
const runtimePath = resolve(root, 'indexers', type, 'index.mjs');

/** BookOrbit's isManifest: the shape it will accept, clause for clause. */
function assertManifestShape(manifest, expectedType) {
  assert.equal(manifest.schemaVersion, 1, 'schemaVersion must be 1');
  assert.equal(manifest.type, expectedType, 'manifest type must match the plugin type');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'version must be a semantic version');
  assert.match(manifest.sourceUrl, /^https:\/\//, 'sourceUrl must be https');
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters');
  assert.match(manifest.signature, /^[A-Za-z0-9+/]+={0,2}$/, 'signature must be base64');
}

/** Everything BookOrbit checks before installing: digest, signature, and the URLs agreeing. */
function verifySignedUpdate({ source, manifest, update, type: pluginType, version }) {
  assertManifestShape(manifest, pluginType);
  assert.equal(manifest.version, version, 'the manifest version must match the plugin version');
  assert.ok(update, 'the plugin must embed an update channel before a manifest means anything');
  assert.match(update.manifestUrl, /^https:\/\//, 'the embedded manifest URL must be https');
  assert.match(update.ed25519PublicKey, /^[A-Za-z0-9_-]{43}$/, 'the embedded key must be a base64url Ed25519 key');
  assert.equal(
    update.manifestUrl,
    manifest.sourceUrl.replace(`/indexers/${pluginType}/index.mjs`, `/updates/${pluginType}.json`),
    'the embedded manifest URL and the manifest sourceUrl must describe the same host and path',
  );
  assert.equal(manifest.sha256, createHash('sha256').update(source).digest('hex'), 'the digest must match the exact runtime bytes');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: update.ed25519PublicKey }, format: 'jwk' });
  assert.equal(verify(null, source, key, Buffer.from(manifest.signature, 'base64')), true, 'the signature must verify against the embedded public key');
}

const source = await readFile(runtimePath);
const plugin = (await import(`../indexers/${type}/index.mjs`)).default;
assert.equal(plugin.apiVersion, 1, 'apiVersion must be 1');
assert.equal(plugin.type, type, 'the plugin type must match its directory');
assert.match(plugin.version, /^\d+\.\d+\.\d+$/, 'the plugin version must be a semantic version');

if (flags.includes('--preflight')) {
  console.log(`Packaging preflight passed: ${type} ${plugin.version}; runtime file exists`);
  process.exit(0);
}

if (flags.includes('--selftest')) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'jwk' }).x;

  // The same substitution the signing script performs, so a marker that no longer matches the runtime
  // fails here rather than at release time.
  const marker = /^const UPDATE_CHANNEL = .*; \/\/ scripts\/sign-update\.mjs fills this with the publisher's public key and URL\.$/m;
  const unsigned = source.toString('utf8');
  assert.ok(marker.test(unsigned), 'the update-channel marker is missing from the runtime, so signing would fail');
  const channel = { manifestUrl: `https://example.invalid/updates/${type}.json`, ed25519PublicKey: rawPublicKey };
  const signed = unsigned.replace(marker, `const UPDATE_CHANNEL = ${JSON.stringify(channel)}; // scripts/sign-update.mjs fills this with the publisher's public key and URL.`);
  assert.notEqual(signed, unsigned, 'the marker substitution must change the source');

  const manifest = {
    schemaVersion: 1,
    type,
    version: plugin.version,
    sourceUrl: `https://example.invalid/indexers/${type}/index.mjs`,
    sha256: createHash('sha256').update(signed).digest('hex'),
    signature: sign(null, Buffer.from(signed), privateKey).toString('base64'),
  };
  verifySignedUpdate({ source: signed, manifest, update: channel, type, version: plugin.version });
  console.log(`Signing pipeline self-test passed: marker substitutes, digest and signature verify for ${type} ${plugin.version}`);
  process.exit(0);
}

const manifestPath = resolve(root, 'updates', `${type}.json`);
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error(`No signed update manifest at updates/${type}.json (${error.code ?? error.message}).`);
  console.error('The plugin installs and runs without one; automatic updates start working once a release is signed.');
  console.error('To prepare one, see the "Signed updates" section of the README.');
  process.exit(1);
}

assert.deepEqual(
  Object.keys(manifest),
  ['schemaVersion', 'type', 'version', 'sourceUrl', 'sha256', 'signature'],
  'the manifest must carry exactly the expected keys',
);
verifySignedUpdate({ source, manifest, update: plugin.update, type, version: plugin.version });
console.log(`Signed update verified: ${type} ${plugin.version}`);
