export default {
  '*.{js,mjs,cjs,ts,tsx,json,jsonc,yaml,yml,md}': 'prettier --check',
  '*.{js,mjs,cjs,ts,tsx}': 'eslint --max-warnings=0',
  '*.md': 'markdownlint-cli2',
  '*.{ts,tsx}': () => ['npm run typecheck', 'npm run dead-code'],
  '{package.json,tsconfig*.json,eslint.config.mjs,knip.json}': () => ['npm run typecheck', 'npm run dead-code'],
  '{.github/ISSUE_TEMPLATE/*.{yml,yaml},.github/pull_request_template.md,README.md,CONTRIBUTING.md,scripts/*community*.ts}':
    () => 'npm run check:community',
};
