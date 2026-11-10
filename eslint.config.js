// ESLint flat config. Each directory gets the globals of the environment its code runs in.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'test/out/', 'dist/'],
  },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  // Extension pages (popup, options, viewer) and shared lib/ modules: ES modules in a window.
  {
    files: ['extension/**/*.js'],
    ignores: ['extension/src/background.js', 'extension/src/content.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  // Service worker: an ES module without a DOM.
  {
    files: ['extension/src/background.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.serviceworker, ...globals.webextensions },
    },
  },
  // Content script: a classic script injected into web pages.
  {
    files: ['extension/src/content.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  // Node tooling and tests. Callbacks passed to page.evaluate() / sw.evaluate() run in the
  // browser, so browser and extension globals are allowed too.
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'formal/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
    },
  },
];
