/**
 * Commit messages are read years later, usually during an audit question about
 * who changed a rule and why. Conventional commits keep that record parseable;
 * the scopes below are the ones this repository actually has.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'adr',
        'tokens',
        'corpus',
        'schema',
        'validation',
        'contracts',
        'web',
        'api',
        'worker',
        'db',
        'infra',
        'ci',
        'deps',
        'docs',
      ],
    ],
    // A subject that cannot fit in a terminal is not a summary.
    'header-max-length': [2, 'always', 100],
    // Off: this repository's subjects begin with acronyms and identifiers
    // (ADR-0006, RLS, FHIR), which the case checker reads as sentence case. The
    // rule would teach people to write worse subjects to satisfy it.
    'subject-case': [0],
  },
};
