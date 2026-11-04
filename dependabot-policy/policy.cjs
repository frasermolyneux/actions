'use strict';

function evaluateAuthor(user) {
  const login = user?.login;
  const isDependabot = login === 'dependabot[bot]';
  const isStandardsBot = login === 'mx-io-idp-bot[bot]' ||
    (login === 'mx-io-idp-bot' && user?.type === 'Bot');
  const eligible = isDependabot || isStandardsBot;

  return {
    is_dependabot: String(isDependabot),
    is_eligible_author: String(eligible),
    auto_merge_allowed: String(eligible),
    policy_reason: eligible
      ? 'Auto-merge is allowed for this approved bot author.'
      : 'Auto-merge is not allowed for this pull request author.',
    policy_code: eligible ? 'eligible_author' : 'ineligible_author',
    update_type: 'unknown',
    dependency_names: 'unknown',
    major_label_applied: 'false'
  };
}

module.exports = { evaluateAuthor };
