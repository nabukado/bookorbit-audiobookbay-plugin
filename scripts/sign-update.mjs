import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const type = process.argv[2];
const keyPath = process.env.BOOKORBIT_PLUGIN_SIGNING_KEY;
const publicKeyPath = process.env.BOOKORBIT_PLUGIN_PUBLIC_KEY;
const updateRoot = process.env.BOOKORBIT_PLUGIN_UPDATE_ROOT?.replace(/\/$/, '');
if (type !== 'audiobookbay') throw new Error('Usage: BOOKORBIT_PLUGIN_SIGNING_KEY=/outside/repo/key.pem BOOKORBIT_PLUGIN_UPDATE_ROOT=https://host/path node scripts/sign-update.mjs audiobookbay');
if (!keyPath || !updateRoot) throw new Error('A signing key path and HTTPS update root are required');
if (resolve(keyPath).startsWith(`${root}${sep}`)) throw new Error('Keep the private signing key outside this repository');
try {
  const url = new URL(updateRoot);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
}
catch { throw new Error('The update root must be an HTTPS URL'); }

const key = createPrivateKey(await readFile(keyPath));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be Ed25519');
const publicKey = createPublicKey(key).export({ format: 'jwk' }).x;
if (publicKeyPath) {
  const suppliedPublicKey = createPublicKey(await readFile(publicKeyPath)).export({ format: 'jwk' }).x;
  if (suppliedPublicKey !== publicKey) throw new Error('The supplied public key does not match the signing key');
}
const manifestUrl = `${updateRoot}/updates/${type}.json`;
const sourceUrl = `${updateRoot}/indexers/${type}/index.mjs`;
const sourcePath = resolve(root, 'indexers', type, 'index.mjs');
const original = await readFile(sourcePath, 'utf8');
const marker = /^const UPDATE_CHANNEL = .*; \/\/ scripts\/sign-update\.mjs fills this with the publisher's public key and URL\.$/m;
if (!marker.test(original)) throw new Error('The update channel marker is missing');
const channel = JSON.stringify({ manifestUrl, ed25519PublicKey: publicKey });
const source = original.replace(marker, `const UPDATE_CHANNEL = ${channel}; // scripts/sign-update.mjs fills this with the publisher's public key and URL.`);
const plugin = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
if (plugin?.type !== type || typeof plugin.version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(plugin.version)) {
  throw new Error('The plugin type or version is invalid');
}
const manifest = {
  schemaVersion: 1,
  type,
  version: plugin.version,
  sourceUrl,
  sha256: createHash('sha256').update(source).digest('hex'),
  signature: sign(null, Buffer.from(source), key).toString('base64'),
};

// `--dry-run` proves the whole flow without touching the working tree, which is what makes the
// signing path testable and lets a wrong update root be caught before anything is rewritten.
if (process.argv.includes('--dry-run')) {
  process.stdout.write(`Dry run: nothing was written. Would produce, for ${type} ${plugin.version}:\n`);
  process.stdout.write(`  embedded channel : ${channel}\n`);
  process.stdout.write(`  updates/${type}.json :\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2).split('\n').map((line) => `    ${line}`).join('\n')}\n`);
  process.stdout.write(`  source bytes     : ${Buffer.byteLength(source)} (sha256 ${manifest.sha256})\n`);
  process.exit(0);
}

await writeFile(sourcePath, source);
await mkdir(resolve(root, 'updates'), { recursive: true });
await writeFile(resolve(root, 'updates', `${type}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Updated updates/${type}.json for ${type} ${plugin.version}\n`);
