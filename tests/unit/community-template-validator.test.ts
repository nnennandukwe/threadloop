import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCommunityRepository } from '../../scripts/community-template-validator.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('community template validation', () => {
  it('accepts the repository community files', async () => {
    await expect(validateCommunityRepository(process.cwd())).resolves.toEqual([]);
  });

  it('rejects malformed issue forms and unsafe chooser configuration', async () => {
    const repositoryRoot = await makeRepositoryFixture({
      issueForm: `name: Bug report
description: Report a bug.
title: "[Bug]: "
labels: []
assignees: []
body:
  - type: markdown
    attributes:
      value: "Read [the guide](http://example.com/guide)."
  - type: input
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
  - type: textarea
    id: summary
    attributes:
      label: Summary
`,
      chooser: `blank_issues_enabled: true
contact_links:
  - name: Documentation
    url: http://example.com/docs
    about: Read the documentation.
`,
    });

    const errors = await validateCommunityRepository(repositoryRoot);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate body id "summary"'),
        expect.stringContaining('duplicate field label "Summary"'),
        expect.stringContaining('must use HTTPS'),
        expect.stringContaining('blank_issues_enabled must be false'),
      ]),
    );
  });

  it('rejects missing pull request sections and broken local links', async () => {
    const repositoryRoot = await makeRepositoryFixture({
      pullRequestTemplate: `## Summary

See the [missing guide](docs/missing.md).
`,
    });

    const errors = await validateCommunityRepository(repositoryRoot);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing required section "Related issue"'),
        expect.stringContaining('local link target does not exist: docs/missing.md'),
      ]),
    );
  });
});

interface RepositoryFixtureOptions {
  chooser?: string;
  issueForm?: string;
  pullRequestTemplate?: string;
}

async function makeRepositoryFixture(options: RepositoryFixtureOptions): Promise<string> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'threadloop-community-'));
  temporaryDirectories.push(repositoryRoot);

  const templateDirectory = path.join(repositoryRoot, '.github', 'ISSUE_TEMPLATE');
  await mkdir(templateDirectory, { recursive: true });
  await mkdir(path.join(repositoryRoot, 'docs'));

  await writeFile(
    path.join(templateDirectory, 'bug.yml'),
    options.issueForm ??
      `name: Bug report
description: Report a bug.
title: "[Bug]: "
labels: []
assignees: []
body:
  - type: input
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
`,
    'utf8',
  );
  await writeFile(
    path.join(templateDirectory, 'config.yml'),
    options.chooser ??
      `blank_issues_enabled: false
contact_links:
  - name: Documentation
    url: https://example.com/docs
    about: Read the documentation.
`,
    'utf8',
  );
  await writeFile(
    path.join(repositoryRoot, '.github', 'pull_request_template.md'),
    options.pullRequestTemplate ?? validPullRequestTemplate(),
    'utf8',
  );
  await writeFile(path.join(repositoryRoot, 'README.md'), '# Readme\n', 'utf8');
  await writeFile(path.join(repositoryRoot, 'CONTRIBUTING.md'), '# Contributing\n', 'utf8');

  return repositoryRoot;
}

function validPullRequestTemplate(): string {
  return [
    '## Summary',
    '## Related issue',
    '## Changes',
    '## Impact',
    '## Validation',
    '## Risk and recovery',
    '## Reviewer guidance',
    '## Checklist',
    '',
  ].join('\n');
}
