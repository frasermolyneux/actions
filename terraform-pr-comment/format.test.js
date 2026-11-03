const assert = require('node:assert/strict');
const test = require('node:test');

const { buildDeprecationSection, escapeMarkdownTableCell } = require('./format');

test('Markdown table cells escape backslashes before pipes', () => {
  assert.equal(escapeMarkdownTableCell('path\\to|value'), 'path\\\\to\\|value');
});

test('deprecation tables cannot use a backslash to neutralize pipe escaping', () => {
  const section = buildDeprecationSection([{
    title: 'Deprecated path\\|override',
    detail: 'Use path\\|replacement',
  }]);

  assert.match(section, /\| Deprecated path\\\\\\\|override \| Use path\\\\\\\|replacement \|/);
});
