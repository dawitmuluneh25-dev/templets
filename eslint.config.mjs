// Flat config. One config at the root rather than one per package: the packages
// are small, and four nearly-identical configs is four places to forget a rule.
// When a package needs different rules it gets its own `eslint.config.mjs`
// and the two are composed here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The prototype is frozen reference material (ADR-0001): it is read for
    // behaviour parity, never linted, never edited. The corpus and the docs are
    // data, not source.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'docs/**',
      'corpus/**',
      'alem-reporting-templates/**',
      'radiology-pwa/**',
      'qa-output/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // A type-only import that is not marked as such changes runtime shape
      // under `verbatimModuleSyntax` and quietly defeats bundler assumptions.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // ADR-0005 is enforced here at the import level and by dependency-cruiser
      // later. Nothing outside packages/tokens may reach into its internals.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/tokens/src/*', '@reporting/tokens/src/*'],
              message:
                'ADR-0005: import the public surface of @reporting/tokens, not its internals.',
            },
          ],
        },
      ],
    },
  },
);
