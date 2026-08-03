/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // B-2 (Chapter 7): @oxelot/core must never import a UI framework.
    {
      name: 'no-framework-in-core',
      comment:
        'B-2: packages/core/src/** may not import any UI framework (react, vue, svelte, solid, angular, preact, mithril).',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: {
        path: 'node_modules/(react|vue|svelte|solid|angular|preact|mithril|@vitejs/plugin-react)',
      },
    },
    {
      name: 'no-core-imports-framework',
      comment: 'B-2: @oxelot/core package may not depend on any framework package.',
      severity: 'error',
      from: { path: '^packages/core/package\\.json$' },
      to: { path: '(react|vue|svelte|solid|angular|preact|mithril)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
}
