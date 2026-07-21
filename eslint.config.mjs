import { configs, plugins } from 'eslint-config-airbnb-extended'
import solid from 'eslint-plugin-solid/configs/recommended'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['**/dist/**', '**/*.d.ts'],
  },
  ...configs.base.all,
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
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
      },
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
]
