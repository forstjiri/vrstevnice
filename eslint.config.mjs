import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { configs, plugins } from 'eslint-config-airbnb-extended'
import solid from 'eslint-plugin-solid/configs/recommended'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['**/dist/**', '**/*.d.ts'],
  },
  ...configs.base.recommended,
  ...configs.base.typescript,
  {
    plugins: {
      ...plugins.stylistic.plugins,
      ...plugins.importX.plugins,
      ...plugins.node.plugins,
      ...plugins.typescriptEslint.plugins,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.node,
      },
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: './tsconfig.json' })],
    },
  },
  {
    files: ['src/fe/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },
  {
    files: ['src/fe/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: solid.plugins,
    rules: solid.rules,
  },
  {
    files: ['tests/**/*.ts', 'src/be/**/*.ts'],
    rules: {
      // Test diagnostics and Bun server diagnostics are intentionally logged.
      'no-console': 'off',
    },
  },
  {
    files: ['src/be/**/*.ts'],
    rules: {
      // Bun exposes this virtual module at runtime, outside Node's resolver.
      'import-x/no-unresolved': 'off',
    },
  },
  {
    files: ['src/fe/**/*.ts', 'src/fe/**/*.tsx', 'tests/vitest.config.ts'],
    rules: {
      // These names are part of the browser debug/test integration contracts.
      'no-underscore-dangle': [
        'error',
        { allow: ['__map', '__fitRouteOverview', '__planner', '__dirname'] },
      ],
    },
  },
  {
    files: ['tests/helpers/gh-lifecycle.ts'],
    rules: {
      // GraphHopper startup/shutdown probes must remain sequential.
      'no-await-in-loop': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    rules: {
      // Empty catches intentionally ignore optional local-service failures.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Function declarations are hoisted; retain the rule for variables/classes.
      '@typescript-eslint/no-use-before-define': ['error', { functions: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: {
            unknown: {
              message: 'Use a concrete domain type instead of unknown.',
            },
          },
        },
      ],
    },
  },
]
