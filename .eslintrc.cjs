module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'node_modules', '*.js', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // Playwright fixtures are destructured as `({}, use) => ...` when a
    // fixture doesn't depend on any other fixture - this is the documented
    // pattern, not a mistake.
    'no-empty-pattern': 'off',
    // Hard waits are banned: every Playwright action and web-first assertion
    // already waits for what it needs. A fixed sleep is either too short
    // (flaky) or too long (slow) - use an assertion or an auto-waiting action.
    'no-restricted-properties': [
      'error',
      {
        property: 'waitForTimeout',
        message: 'Hard waits are banned - use a web-first assertion (assertions.*) or an auto-waiting action instead.',
      },
    ],
    // 'networkidle' is discouraged by Playwright itself (it never settles on pages that poll or stream).
    'no-restricted-syntax': [
      'error',
      {
        selector: "Literal[value='networkidle']",
        message: "Don't wait for 'networkidle' - wait for the specific element/state you need instead.",
      },
    ],
  },
  overrides: [
    {
      // Layering: a spec says WHAT happens; the technical ids (wnd[0]/usr/...) belong in a page object
      // (tests/sapgui/pages/). A warning, not an error: a freshly converted recording is full of ids
      // until someone tidies it up.
      files: ['tests/sapgui/*.spec.ts'],
      rules: {
        'no-restricted-syntax': [
          'warn',
          {
            selector: "Literal[value=/^wnd\\[/]",
            message: 'Put SAP technical ids in a page object (tests/sapgui/pages/) and use it from the test - one place to fix when a screen changes.',
          },
          {
            selector: "Literal[value='networkidle']",
            message: "Don't wait for 'networkidle' - wait for the specific element/state you need instead.",
          },
        ],
      },
    },
  ],
};
