import js from '@eslint/js'
import globals from 'globals'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import importPlugin from 'eslint-plugin-import'
import sonarjs from 'eslint-plugin-sonarjs'
import pluginPromise from 'eslint-plugin-promise'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['*.config.mjs', 'performance-results/**']),
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.nodeBuiltin,
        ...globals.node
      },
      parserOptions: {
        ecmaVersion: 2020
      }
    },
    plugins: { js, unicorn: eslintPluginUnicorn },
    extends: ['js/recommended']
  },
  importPlugin.flatConfigs.recommended,
  sonarjs.configs.recommended,
  pluginPromise.configs['flat/recommended'],
  {
    rules: {
      // Clean Code: Function Complexity (adapted for blockchain consensus)
      complexity: ['warn', 20],
      'max-depth': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 100, skipComments: true, skipBlankLines: true }],
      'max-params': ['error', 4],
      'max-statements': ['warn', 30],

      // Clean Code: Naming Conventions
      camelcase: [
        'error',
        {
          properties: 'always',
          ignoreDestructuring: false,
          allow: ['^[A-Z_]+$']
        }
      ],
      'id-length': ['error', { min: 1, exceptions: ['_'] }],

      // Clean Code: Code Quality
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-template': 'warn',
      'prefer-arrow-callback': 'warn',
      'no-magic-numbers': 'off',
      eqeqeq: ['error', 'always'],
      'no-nested-ternary': 'error',
      'no-return-await': 'error',

      // Clean Code: Error Handling
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Clean Code: Comments
      'no-inline-comments': 'off',
      'no-warning-comments': 'off',

      // SonarJS: Adjusted for Clean Code
      'sonarjs/x-powered-by': 'off',
      'sonarjs/todo-tag': 'off',
      'sonarjs/no-small-switch': 'off',
      'sonarjs/pseudo-random': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      'sonarjs/cognitive-complexity': ['warn', 20],
      'sonarjs/no-duplicate-string': ['warn', { threshold: 10 }],
      'sonarjs/no-identical-functions': 'warn',

      // Unicorn: Clean Code Enhancements
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/explicit-length-check': 'off',
      'unicorn/no-array-reduce': 'off',

      // Promise: Async Best Practices (relaxed for legacy patterns)
      'promise/prefer-await-to-then': 'off',
      'promise/prefer-await-to-callbacks': 'off',

      // Import: Module Organization
      'import/order': 'off',
      'import/newline-after-import': 'off',
      'import/no-duplicates': 'error'
    }
  },
  {
    files: ['**/__tests__/**/*.js', '**/*.test.js'],
    languageOptions: {
      globals: {
        ...globals.jest
      }
    },
    rules: {
      'no-magic-numbers': 'off',
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'no-unused-vars': 'off',
      'sonarjs/no-unused-vars': 'off',
      'sonarjs/no-dead-store': 'off'
    }
  }
])
