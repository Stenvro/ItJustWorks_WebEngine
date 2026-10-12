// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeApis = {
  group: ['node:*', 'fs', 'fs/*', 'path', 'buffer'],
  message: 'Platform-onafhankelijke code mag geen Node-API’s gebruiken.',
};

export default defineConfig(
  globalIgnores(['dist/', 'coverage/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Parsers blijven platform-onafhankelijk (zie tsconfig.portable.json) en kennen
    // de engine-lagen niet.
    files: ['src/formats/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            nodeApis,
            {
              regex: String.raw`^(\.\./)+(vfs|render|world|physics|animation|audio|scripting|ai|gameplay|ui|save)(/|$)`,
              message: 'src/formats mag niet afhangen van engine-lagen.',
            },
          ],
        },
      ],
    },
  },
  {
    // De VFS-kern draait ook in Node; alleen src/vfs/browser mag browser-API's gebruiken.
    files: ['src/vfs/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/vfs/browser/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [nodeApis] }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
