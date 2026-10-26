const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { parseBuildInfo, packageHash, inventory } = require('./binary.cjs');
const { executable } = require('../terraform-setup/context.cjs');

test('Go build metadata reads the compiler and target, not dependency versions or private flags', () => {
  const info = '/private/tool: go1.26.9\n\tdep example/module v1.99.0 h1:irrelevant\n\tbuild GOOS=linux\n\tbuild GOARCH=amd64\n\tbuild -ldflags=private-do-not-collect\n';
  assert.equal(parseBuildInfo(info, 'linux_amd64'), '1.26.9');
  assert.equal(parseBuildInfo(info.replace('go1.26.9', 'go1.26'), 'linux_amd64'), '1.26.0');
  for (const invalid of [info.replace('go1.26.9', 'go1.27rc1'), info.replace('GOOS=linux', 'GOOS=windows'),
    info + '\tbuild GOARCH=amd64\n', info.replace('\tbuild GOOS=linux\n', ''), info.replace('go1.26.9', '(devel)')])
    assert.throws(() => parseBuildInfo(invalid, 'linux_amd64'));
});

test('Native readonly initialization produces checksum-bound CLI/provider Go metadata without an apply', {
  skip: process.env.TERRAFORM_BINARY_TEST !== '1'
}, t => {
  const directory = fs.mkdtempSync(path.join(__dirname, 'generated-native-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = executable();
  const terraform = args => cp.execFileSync(binary, args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
  const version = JSON.parse(terraform(['version', '-json']));
  fs.writeFileSync(path.join(directory, 'main.tf'), 'terraform {\n  required_providers {\n    random = { source = "hashicorp/random", version = "= 3.7.2" }\n  }\n}\n');
  terraform(['init', '-backend=false', '-input=false']);
  terraform(['init', '-backend=false', '-input=false', '-lockfile=readonly']);
  const result = inventory({ root: directory, terraformVersion: version.terraform_version,
    platform: version.platform, providerSelections: { 'registry.terraform.io/hashicorp/random': '3.7.2' } }, binary);
  assert.equal(result.status, 'observed', result.gaps.join(' '));
  assert.equal(result.artifacts.length, 2);
  assert.ok(result.artifacts.every(artifact => /^\d+\.\d+\.\d+$/.test(artifact.goVersion)));
  assert.match(result.artifacts.find(artifact => artifact.kind === 'provider').packageHash, /^h1:/);
  assert.ok(!JSON.stringify(result).includes(directory));
});

test('Provider h1 hashes bind package filenames and contents and reject symlinks or nested entries', t => {
  const directory = fs.mkdtempSync(path.join(__dirname, 'generated-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'LICENSE.txt'), 'license');
  fs.writeFileSync(path.join(directory, 'terraform-provider-example_v1.0.0_x5'), 'binary');
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  const expected = 'h1:' + crypto.createHash('sha256').update(
    `${hash('license')}  LICENSE.txt\n${hash('binary')}  terraform-provider-example_v1.0.0_x5\n`).digest('base64');
  assert.equal(packageHash(directory), expected);
  fs.writeFileSync(path.join(directory, 'terraform-provider-example_v1.0.0_x5'), 'changed');
  assert.notEqual(packageHash(directory), expected);
  fs.mkdirSync(path.join(directory, 'unsupported'));
  assert.throws(() => packageHash(directory), /unsupported entries/);
});
