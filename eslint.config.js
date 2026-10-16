// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeApis = {
  group: ['node:*', 'fs', 'fs/*', 'path', 'buffer'],
  message: 'Platform-independent code must not use Node APIs.',
};

export default defineConfig(
  // .claude/ holds local worktrees (copies of the repository).
  globalIgnores(['dist/', 'coverage/', '.claude/']),
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
    // Parsers stay platform-independent (see tsconfig.portable.json) and do not know
    // about the engine layers.
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
              message: 'src/formats must not depend on engine layers.',
            },
          ],
        },
      ],
    },
  },
  {
    // The VFS core also runs in Node; only src/vfs/browser may use browser APIs.
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
