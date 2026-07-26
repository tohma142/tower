import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

/**
 * Flat ESLint config.
 *
 * Three environments share one rule set: `src/server` and `src/game` run in Node,
 * `src/client` runs in the browser, and `src/shared` runs in both — which is why
 * shared code may not reference `process`, `window`, or `document`.
 */
export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    settings: {
      'import/resolver': {
        node: { extensions: ['.js'] },
      },
    },
    rules: {
      // Import hygiene — CLAUDE.md requires grouped, ordered imports, enforced not hand-sorted.
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-cycle': 'error',
      'import/extensions': ['error', 'ignorePackages', { js: 'always' }],

      // Correctness rules that map directly to CLAUDE.md conventions.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-param-reassign': 'error',
      'no-implicit-coercion': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'require-await': 'error',
      'no-return-await': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],

      // Security rules from CLAUDE.md.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },

  // Node-side code: server, game simulation, entry point, tooling.
  {
    files: ['src/index.js', 'src/config.js', 'src/logger.js', 'src/server/**/*.js', 'src/game/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Structured logging only — the logger writes to stdout itself.
      'no-console': 'error',
    },
  },

  // Browser-side code.
  {
    files: ['src/client/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // The client logs through src/client/log.js, which is the one allowed console user.
      'no-console': 'error',
    },
  },
  {
    files: ['src/client/log.js'],
    rules: {
      'no-console': 'off',
    },
  },

  // Shared code must run unmodified in both Node and the browser, so it gets
  // neither set of globals — referencing `process` or `document` here is an error.
  {
    files: ['src/shared/**/*.js'],
    languageOptions: {
      globals: {},
    },
  },
];
