import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const manifest = readFileSync(new URL('./action.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const script = /      run: \|\n((?:        .*\n|\n)+)/.exec(manifest)[1].replace(/^        /gm, '');

test('publish reuses Release builds and preserves framework output layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-publish-test-'));
  try {
    const src = join(root, 'src');
    const project = join(src, 'Web');
    const runner = join(root, 'runner');
    mkdirSync(project, { recursive: true });
    mkdirSync(runner);
    writeFileSync(join(project, 'Web.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFrameworks>net9.0;net10.0</TargetFrameworks></PropertyGroup><ItemGroup><Content Include=".hidden" CopyToPublishDirectory="Always" /></ItemGroup></Project>');
    writeFileSync(join(project, 'Program.cs'), 'System.Console.WriteLine("hello");');
    writeFileSync(join(project, '.hidden'), 'included');
    const env = { ...process.env, RUNNER_TEMP: runner.replaceAll('\\', '/'), SRC_FOLDER: src.replaceAll('\\', '/'), DOTNET_PROJECT: 'Web', PUBLISH_FRAMEWORKS: 'net9.0,\nnet10.0', MSYS_NO_PATHCONV: '1', DOTNET_NOLOGO: '1' };
    const publish = () => spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
    let result = publish();
    assert.notEqual(result.status, 0, 'unbuilt project must fail rather than build');
    result = spawnSync('dotnet', ['build', join(project, 'Web.csproj'), '--configuration', 'Release', '/p:ContinuousIntegrationBuild=true', '/p:IncludeSymbols=true', '/p:SymbolPackageFormat=snupkg'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const built = readFileSync(join(project, 'bin', 'Release', 'net9.0', 'Web.dll'));
    writeFileSync(join(project, 'Program.cs'), 'this is deliberately not valid C#');
    result = publish();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const framework of ['net9.0', 'net10.0']) {
      assert.ok(existsSync(join(runner, 'dotnet-publish', 'Web', framework, 'Web.dll')));
      assert.ok(existsSync(join(runner, 'dotnet-publish', 'Web', framework, '.hidden')));
    }
    assert.deepEqual(readFileSync(join(runner, 'dotnet-publish', 'Web', 'net9.0', 'Web.dll')), built);
    env.PUBLISH_FRAMEWORKS = 'net8.0';
    assert.notEqual(publish().status, 0, 'unbuilt framework must fail');
    env.PUBLISH_FRAMEWORKS = '../escape';
    assert.notEqual(publish().status, 0, 'invalid framework must fail');
    env.DOTNET_PROJECT = '../escape';
    assert.notEqual(publish().status, 0, 'invalid project must fail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('single-framework publish retains the root output layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-publish-single-'));
  try {
    const project = join(root, 'src', 'Web');
    const runner = join(root, 'runner');
    mkdirSync(project, { recursive: true });
    mkdirSync(runner);
    writeFileSync(join(project, 'Web.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>');
    writeFileSync(join(project, 'Program.cs'), 'System.Console.WriteLine("hello");');
    const result = spawnSync('dotnet', ['build', join(project, 'Web.csproj'), '--configuration', 'Release', '/p:ContinuousIntegrationBuild=true', '/p:IncludeSymbols=true', '/p:SymbolPackageFormat=snupkg'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const publish = spawnSync('bash', ['-c', script], {
      env: { ...process.env, RUNNER_TEMP: runner.replaceAll('\\', '/'), SRC_FOLDER: join(root, 'src').replaceAll('\\', '/'), DOTNET_PROJECT: 'Web', PUBLISH_FRAMEWORKS: '', MSYS_NO_PATHCONV: '1' },
      encoding: 'utf8',
    });
    assert.equal(publish.status, 0, publish.stdout + publish.stderr);
    assert.ok(existsSync(join(runner, 'dotnet-publish', 'Web', 'Web.dll')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upload preserves existing artifact semantics and release registration', () => {
  assert.match(manifest, /if-no-files-found: error/);
  assert.match(manifest, /include-hidden-files: true/);
  const release = readFileSync(resolve('.github/workflows/actions-versioning.yml'), 'utf8');
  assert.match(release, /^\s+dotnet-web-publish$/m);
});
