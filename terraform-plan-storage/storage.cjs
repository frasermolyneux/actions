const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const magic = Buffer.from('TFPLAN01');
const maxSmallFile = 10 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function details(context, directory, name, identifier, env) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '.terraform.lock.hcl') {
    throw new Error('Plan filename must be a simple filename');
  }
  if (!identifier || !identifier.trim() || /[\r\n]/.test(identifier)) throw new Error('A plan identifier is required');
  if (!/^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY || '') ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('Repository, run and attempt are required for saved plan storage');
  }
  const dataDirectory = path.resolve(context.root, env.TF_DATA_DIR || '.terraform');
  const backend = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'terraform.tfstate'), 'utf8')).backend;
  const account = backend?.config?.storage_account_name;
  if (backend?.type !== 'azurerm' || typeof account !== 'string' || !/^[a-z0-9]{3,24}$/.test(account)) {
    throw new Error('Initialized azurerm backend must specify a valid storage account name');
  }
  return {
    account,
    blob: `${hash(env.GITHUB_REPOSITORY.toLowerCase())}/${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}/${hash(identifier)}.tfplanbundle`,
    bundle: path.join(directory, 'saved-plan.bundle')
  };
}
function fileSize(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('Expected a regular saved plan file');
  return stat.size;
}
function copyBytes(source, destination, size) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let remaining = size;
  while (remaining > 0) {
    const read = fs.readSync(source, buffer, 0, Math.min(buffer.length, remaining), null);
    if (!read) throw new Error('Truncated saved plan bundle');
    let written = 0;
    while (written < read) written += fs.writeSync(destination, buffer, written, read - written);
    remaining -= read;
  }
}
function pack(root, name, bundle) {
  const files = [path.join(root, name), path.join(root, `${name}.metadata.json`), path.join(root, '.terraform.lock.hcl')];
  const sizes = files.map(fileSize);
  if (!sizes[0] || !sizes[1] || !sizes[2] || sizes[1] > maxSmallFile || sizes[2] > maxSmallFile) {
    throw new Error('Invalid saved plan file size');
  }
  const header = Buffer.alloc(32);
  magic.copy(header);
  sizes.forEach((size, index) => header.writeBigUInt64BE(BigInt(size), 8 + index * 8));
  const out = fs.openSync(bundle, 'wx', 0o600);
  let complete = false;
  try {
    fs.writeSync(out, header);
    for (let i = 0; i < files.length; i++) {
      const input = fs.openSync(files[i], 'r');
      try { copyBytes(input, out, sizes[i]); } finally { fs.closeSync(input); }
    }
    complete = true;
  } finally {
    fs.closeSync(out);
    if (!complete) fs.unlinkSync(bundle);
  }
}
function unpack(bundle, directory, name) {
  const total = fileSize(bundle);
  const input = fs.openSync(bundle, 'r');
  try {
    const header = Buffer.alloc(32);
    if (fs.readSync(input, header, 0, header.length, null) !== header.length || !header.subarray(0, 8).equals(magic)) {
      throw new Error('Invalid saved plan bundle');
    }
    const sizes = [8, 16, 24].map(offset => header.readBigUInt64BE(offset));
    if (sizes.some(size => size === 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) ||
        sizes[1] > BigInt(maxSmallFile) || sizes[2] > BigInt(maxSmallFile) ||
        sizes.reduce((sum, size) => sum + size, 32n) !== BigInt(total)) {
      throw new Error('Invalid saved plan bundle sizes');
    }
    fs.mkdirSync(directory);
    const names = [name, `${name}.metadata.json`, '.terraform.lock.hcl'];
    for (let i = 0; i < names.length; i++) {
      const out = fs.openSync(path.join(directory, names[i]), 'wx', 0o600);
      try { copyBytes(input, out, Number(sizes[i])); } finally { fs.closeSync(out); }
    }
  } finally { fs.closeSync(input); }
}
function main() {
  const directory = process.env.TF_CONTEXT;
  const context = JSON.parse(fs.readFileSync(path.join(directory, 'context.json'), 'utf8'));
  const name = process.env.TF_PLAN;
  const transfer = details(context, directory, name, process.env.TF_PLAN_ID, process.env);
  if (process.argv[2] === 'prepare') {
    if (process.env.TF_STORAGE_OPERATION === 'upload') pack(context.root, name, transfer.bundle);
    else if (process.env.TF_STORAGE_OPERATION !== 'download') throw new Error('Invalid transfer operation');
    process.stdout.write(JSON.stringify(transfer));
  } else if (process.argv[2] === 'unpack' && process.env.TF_STORAGE_OPERATION === 'download') {
    unpack(transfer.bundle, path.join(directory, 'saved-plan'), name);
  } else throw new Error('Invalid saved plan storage command');
}
module.exports = { details, pack, unpack };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`Saved plan storage rejected: ${error.message}`); process.exitCode = 1; }
}
