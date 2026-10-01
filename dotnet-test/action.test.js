'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('release order publishes reporting dependencies before their consumers', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'actions-versioning.yml'), 'utf8');
  const actions = /ACTIONS=\(([\s\S]*?)\)/.exec(workflow)[1].trim().split(/\s+/);
  for (const [dependency, consumer] of [
    ['dotnet-test-report', 'dotnet-test'],
    ...['dotnet-ci', 'dotnet-web-ci', 'dotnet-func-ci', 'dotnet-playwright-tests'].map(consumer => ['dotnet-test', consumer]),
  ]) {
    assert.ok(actions.includes(dependency) && actions.includes(consumer));
    assert.ok(actions.indexOf(dependency) < actions.indexOf(consumer), `${dependency} must be published before ${consumer}`);
  }
});
