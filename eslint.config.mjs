import eslint from '@eslint/js';
import security from 'eslint-plugin-security';
import globals from 'globals';
import typescriptEslint from 'typescript-eslint';

export default typescriptEslint.config(
  {
    ignores: ['.gsd/**', '.threadloop/**', 'coverage/**', 'dist/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Root-level build and test configuration. Linted without type-aware rules
    // because these files sit outside the tsconfig projects; without this block
    // they match no configuration and fail `eslint --max-warnings=0` whenever
    // lint-staged passes one explicitly.
    files: ['*.config.ts'],
    extends: [eslint.configs.recommended, ...typescriptEslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    extends: [eslint.configs.recommended, ...typescriptEslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      security,
    },
    rules: {
      'security/detect-bidi-characters': 'error',
      'security/detect-child-process': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-unsafe-regex': 'error',
    },
  },
);
