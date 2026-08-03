import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/*.config.ts',
      '**/*.config.mjs',
      '**/*.config.cjs',
      '.dependency-cruiser.cjs',
      'scripts/*.mjs',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      // Async methods are part of the normative API contract (Ch.5); they may
      // legitimately resolve without awaiting an internal promise.
      '@typescript-eslint/require-await': 'off',
      // Generic signatures (get<T>, set<T>) are part of the normative contract.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // `unknown | Promise<unknown>` is intentional in the worker registry.
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      // Template literals legitimately interpolate numbers (ids, counters).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Pool uses non-null assertions after guard checks.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Arrow shorthand returning void is idiomatic here.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'B-1: @oxelot/core must never touch the DOM' },
        { name: 'window', message: 'B-1: @oxelot/core must never touch the DOM' },
        { name: 'HTMLElement', message: 'B-1: @oxelot/core must never touch the DOM' },
        { name: 'Element', message: 'B-1: @oxelot/core must never touch the DOM' },
        { name: 'Node', message: 'B-1: @oxelot/core must never touch the DOM' },
        { name: 'CSS', message: 'B-1: @oxelot/core must never touch the DOM' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='document']", message: 'B-1: no document.* in core' },
        { selector: "MemberExpression[object.name='window']", message: 'B-1: no window.* in core' },
        { selector: "MemberExpression[property.name='style']", message: 'B-1: no .style in core' },
        { selector: "MemberExpression[property.name='classList']", message: 'B-1: no .classList in core' },
        { selector: "CallExpression[callee.property.name='getElementById']", message: 'B-1: no getElementById in core' },
        { selector: "CallExpression[callee.property.name='querySelector']", message: 'B-1: no querySelector in core' },
      ],
    },
  },
  {
    files: ['packages/react/src/**/*.ts', 'packages/react/src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
)
