const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function gitExecutable() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'git.exe')]
    : ['/usr/bin/git', '/usr/local/bin/git'];
  const executable = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!executable) throw new Error('Git must be installed in a trusted system installation directory');
  return fs.realpathSync(executable);
}
const environmentName = (explicit = '', varFile = '') =>
  explicit || path.posix.basename(varFile.replaceAll('\\', '/'), '.tfvars');
function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes repository');
  return candidate;
}
function regular(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Expected a regular file');
  return fs.readFileSync(file);
}
function selections(lock) {
  const result = {};
  const blocks = [...lock.matchAll(/provider\s+"([^"]+)"\s*\{([^}]+)\}/g)];
  for (const [, address, body] of blocks) {
    const version = body.match(/^\s*version\s*=\s*"(\d+\.\d+\.\d+)"/m)?.[1];
    if (!/^[a-z0-9.-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(address) || !version ||
        !/hashes\s*=\s*\[[\s\S]*?"(?:h1:[A-Za-z0-9+/=]+|zh:[a-f0-9]{64})"/.test(body) ||
        result[address]) throw new Error('Invalid provider lock selection/checksums');
    result[address] = version;
  }
  if (!blocks.length) throw new Error('A real provider lock is required');
  return result;
}
function prepare(workspace, folder, requested = '') {
  workspace = fs.realpathSync(workspace);
  const root = inside(workspace, fs.realpathSync(path.resolve(workspace, folder)));
  const pin = regular(path.join(root, '.terraform-version')).toString().trim();
  if (!/^\d+\.\d+\.\d+$/.test(pin) || (requested && requested !== pin)) {
    throw new Error('Root .terraform-version must contain an exact stable version matching terraform-version');
  }
  const lock = regular(path.join(root, '.terraform.lock.hcl'));
  const relative = path.relative(workspace, root).split(path.sep).join('/') || '.';
  const tracked = cp.execFileSync(gitExecutable(), ['ls-files', '--error-unmatch',
    path.posix.join(relative, '.terraform-version'), path.posix.join(relative, '.terraform.lock.hcl')], { cwd: workspace });
  if (!tracked.length) throw new Error('Pin and lock must be committed');
  cp.execFileSync(gitExecutable(), ['diff', '--exit-code', 'HEAD', '--',
    path.posix.join(relative, '.terraform-version'), path.posix.join(relative, '.terraform.lock.hcl')], { cwd: workspace });
  return {
    root, rootDirectory: relative, terraformVersion: pin, lockSha256: sha256(lock),
    providerSelections: selections(lock.toString()),
    sourceCommit: cp.execFileSync(gitExecutable(), ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()
  };
}
function executable() {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const installed = cp.execFileSync(command, ['terraform'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  const binary = path.join(path.dirname(installed), process.platform === 'win32' ? 'terraform-bin.exe' : 'terraform-bin');
  return fs.existsSync(binary) ? binary : installed;
}
function observe(context, requireProviders = false) {
  const data = JSON.parse(cp.execFileSync(executable(), ['version', '-json'], {
    cwd: context.root, encoding: 'utf8', maxBuffer: 1024 * 1024
  }));
  if (data.terraform_version !== context.terraformVersion || !/^[a-z0-9]+_[a-z0-9]+$/.test(data.platform)) {
    throw new Error('Installed Terraform does not match root pin/platform');
  }
  if (sha256(regular(path.join(context.root, '.terraform.lock.hcl'))) !== context.lockSha256) {
    throw new Error('Provider lock changed during execution');
  }
  const selected = data.provider_selections || {};
  if (requireProviders && (Object.keys(selected).length !== Object.keys(context.providerSelections).length ||
      Object.entries(context.providerSelections).some(([address, version]) => selected[address] !== version))) {
    throw new Error('Selected providers do not match committed lock');
  }
  return { ...context, platform: data.platform, observedProviderSelections: data.provider_selections || {} };
}
function planFile(context, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '.terraform.lock.hcl') {
    throw new Error('Plan filename must be a simple filename');
  }
  return path.join(context.root, name);
}
function planIdentity(context, name, environment) {
  if (typeof environment !== 'string' || !environment.trim()) throw new Error('Saved plans require a nonempty environment identity');
  return {
    schemaVersion: 'terraform-saved-plan-v1', sourceCommit: context.sourceCommit,
    rootDirectory: context.rootDirectory, terraformVersion: context.terraformVersion,
    lockSha256: context.lockSha256, environment,
    planSha256: sha256(regular(planFile(context, name)))
  };
}
function verifyPlan(context, name, directory, environment) {
  const file = planFile(context, name);
  const saved = JSON.parse(regular(path.join(directory, `${name}.metadata.json`)));
  const staged = { ...context, root: directory };
  const expected = planIdentity(staged, name, environment);
  for (const key of Object.keys(expected)) {
    if (saved[key] !== expected[key]) throw new Error(`Saved plan identity mismatch: ${key}`);
  }
  if (sha256(regular(path.join(directory, '.terraform.lock.hcl'))) !== context.lockSha256) {
    throw new Error('Saved plan provider lock differs from checkout');
  }
  fs.copyFileSync(path.join(directory, name), file);
}
function output(key, value) {
  if (/[\r\n]/.test(String(value))) throw new Error('Invalid output');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
function contextFile(directory) {
  return JSON.parse(regular(path.join(directory, 'context.json')));
}
function main() {
  const mode = process.argv[2];
  if (mode === 'prepare') {
    const context = prepare(process.env.GITHUB_WORKSPACE, process.env.TF_ROOT, process.env.TF_VERSION);
    // Use a new, non-symlink directory; never clean an input-selected path.
    const parent = path.join(fs.realpathSync(process.env.GITHUB_WORKSPACE), '.terraform-execution');
    fs.mkdirSync(parent, { recursive: true });
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Unsafe execution directory');
    const directory = fs.mkdtempSync(path.join(parent, 'run-'));
    fs.writeFileSync(path.join(directory, 'context.json'), JSON.stringify(context));
    output('directory', directory);
    output('version', context.terraformVersion);
    return;
  }
  const directory = process.env.TF_CONTEXT;
  const context = contextFile(directory);
  if (mode === 'observe') {
    fs.writeFileSync(path.join(directory, 'context.json'), JSON.stringify(observe(context)));
  } else if (mode === 'save-plan') {
    const name = process.env.TF_PLAN;
    fs.writeFileSync(`${planFile(context, name)}.metadata.json`,
      JSON.stringify(planIdentity(observe(context, true), name,
        environmentName(process.env.TF_ENVIRONMENT, process.env.TF_VAR_FILE))));
  } else if (mode === 'verify-plan') {
    verifyPlan(observe(context, true), process.env.TF_PLAN, path.join(directory, 'saved-plan'), process.env.TF_ENVIRONMENT || '');
  } else {
    throw new Error('Unknown toolchain operation');
  }
}
module.exports = { prepare, selections, observe, planIdentity, verifyPlan, sha256, inside, contextFile, output, environmentName, gitExecutable };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`Terraform toolchain rejected: ${error.message}`); process.exitCode = 1; }
}
