const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

function goExecutable() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Go', 'bin', 'go.exe')]
    : ['/usr/local/go/bin/go', '/usr/bin/go'];
  const cache = process.platform === 'win32' ? 'C:\\hostedtoolcache\\windows\\go' : '/opt/hostedtoolcache/go';
  if (fs.existsSync(cache)) {
    for (const version of fs.readdirSync(cache).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort().reverse())
      candidates.push(path.join(cache, version, 'x64', 'bin', process.platform === 'win32' ? 'go.exe' : 'go'));
  }
  const executable = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!executable) throw new Error('A trusted installed Go metadata reader is unavailable');
  return fs.realpathSync(executable);
}

function fileHash(file) {
  const before = fs.statSync(file);
  if (!before.isFile() || before.size <= 0 || before.size > 1024 * 1024 * 1024)
    throw new Error('Binary file is absent or exceeds the inspection bound');
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('Binary changed during inspection');
  return hash.digest('hex');
}

function packageHash(directory) {
  const files = fs.readdirSync(directory).sort();
  if (!files.length || files.length > 20 || files.some(name => /[\r\n]/.test(name) ||
      !fs.lstatSync(path.join(directory, name)).isFile()))
    throw new Error('Provider package contains unsupported entries');
  const lines = files.map(name => `${fileHash(path.join(directory, name))}  ${name}\n`).join('');
  return 'h1:' + crypto.createHash('sha256').update(lines).digest('base64');
}

function parseBuildInfo(text, platform) {
  const version = text.split(/\r?\n/, 1)[0].match(/:\s+go(\d+\.\d+(?:\.\d+)?)$/)?.[1];
  const values = key => [...text.matchAll(new RegExp(`^\\s*build\\s+${key}=([a-z0-9]+)\\s*$`, 'gm'))].map(match => match[1]);
  const os = values('GOOS'), arch = values('GOARCH');
  if (!version || os.length !== 1 || arch.length !== 1 || `${os[0]}_${arch[0]}` !== platform)
    throw new Error('Stable Go version and target platform were not established');
  return version.split('.').length === 2 ? version + '.0' : version;
}

function inventory(context, terraformBinary) {
  const artifacts = [], gaps = [];
  let go;
  try { go = goExecutable(); } catch {
    return { method: 'go-buildinfo-v1', status: 'unavailable', artifacts, gaps: ['Trusted Go binary metadata reader is unavailable.'] };
  }
  function inspect(kind, address, version, file, hash = null) {
    const before = fileHash(file);
    const info = cp.execFileSync(go, ['version', '-m', file], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, cwd: path.dirname(go)
    });
    const goVersion = parseBuildInfo(info, context.platform);
    if (fileHash(file) !== before) throw new Error('Binary changed during inspection');
    artifacts.push({ kind, address, version, platform: context.platform, binarySha256: before, goVersion, packageHash: hash });
  }
  try { inspect('cli', 'hashicorp/terraform', context.terraformVersion, terraformBinary); }
  catch { gaps.push('CLI: stable Go build metadata or binary identity could not be verified.'); }
  const lock = fs.readFileSync(path.join(context.root, '.terraform.lock.hcl'), 'utf8');
  for (const [address, version] of Object.entries(context.providerSelections).sort()) {
    try {
      const directory = fs.realpathSync(path.join(context.root, '.terraform', 'providers', address, version, context.platform));
      const hash = packageHash(directory);
      const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const block = lock.match(new RegExp(`provider\\s+"${escaped}"\\s*\\{([^}]+)\\}`))?.[1];
      if (!block?.includes(`"${hash}"`)) throw new Error('Installed package does not match a committed h1 checksum');
      const name = address.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^terraform-provider-${name}_v${version.replaceAll('.', '\\.')}(?:_x\\d+)?(?:\\.exe)?$`);
      const files = fs.readdirSync(directory).filter(file => pattern.test(file));
      if (files.length !== 1) throw new Error('Provider binary identity is ambiguous');
      inspect('provider', address, version, path.join(directory, files[0]), hash);
      if (packageHash(directory) !== hash) throw new Error('Provider package changed during inspection');
    } catch {
      const index = artifacts.findIndex(item => item.address === address);
      if (index >= 0) artifacts.splice(index, 1);
      gaps.push(`${address}: installed package checksum or stable Go build metadata is unavailable.`);
    }
  }
  return { method: 'go-buildinfo-v1', status: gaps.length ? 'partial' : 'observed', artifacts, gaps };
}
module.exports = { inventory, parseBuildInfo, packageHash };
