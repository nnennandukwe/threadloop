import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

const REQUIRED_PULL_REQUEST_SECTIONS = [
  'Summary',
  'Related issue',
  'Changes',
  'Impact',
  'Validation',
  'Risk and recovery',
  'Reviewer guidance',
  'Checklist',
] as const;

const ALLOWED_BODY_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes']);
const FIELD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface LinkReference {
  filePath: string;
  target: string;
}

export async function validateCommunityRepository(repositoryRoot: string): Promise<string[]> {
  const errors: string[] = [];
  const links: LinkReference[] = [];
  const templateDirectory = path.join(repositoryRoot, '.github', 'ISSUE_TEMPLATE');

  const templateEntries = await readDirectory(templateDirectory, errors, repositoryRoot);
  const issueFormPaths = templateEntries
    .filter((entry) => entry !== 'config.yml' && entry !== 'config.yaml' && /\.ya?ml$/u.test(entry))
    .map((entry) => path.join(templateDirectory, entry));

  if (issueFormPaths.length === 0) {
    errors.push('.github/ISSUE_TEMPLATE: expected at least one issue form');
  }

  for (const issueFormPath of issueFormPaths) {
    await validateIssueForm(repositoryRoot, issueFormPath, errors, links);
  }

  const chooserPath = templateEntries.includes('config.yaml')
    ? path.join(templateDirectory, 'config.yaml')
    : path.join(templateDirectory, 'config.yml');
  await validateChooser(repositoryRoot, chooserPath, errors, links);

  const pullRequestTemplatePath = path.join(repositoryRoot, '.github', 'pull_request_template.md');
  await validatePullRequestTemplate(repositoryRoot, pullRequestTemplatePath, errors, links);

  for (const markdownPath of [path.join(repositoryRoot, 'README.md'), path.join(repositoryRoot, 'CONTRIBUTING.md')]) {
    await collectLinksFromMarkdownFile(repositoryRoot, markdownPath, errors, links);
  }

  for (const link of links) {
    await validateLink(repositoryRoot, link, errors);
  }

  return [...new Set(errors)].sort();
}

async function validateIssueForm(
  repositoryRoot: string,
  filePath: string,
  errors: string[],
  links: LinkReference[],
): Promise<void> {
  const value = await readYaml(repositoryRoot, filePath, errors);
  const fileLabel = relativePath(repositoryRoot, filePath);
  if (!isRecord(value)) {
    return;
  }

  requireNonEmptyString(value, 'name', fileLabel, errors);
  requireNonEmptyString(value, 'description', fileLabel, errors);
  requireNonEmptyString(value, 'title', fileLabel, errors);
  requireArray(value, 'labels', fileLabel, errors);
  requireArray(value, 'assignees', fileLabel, errors);

  if (!Array.isArray(value.body) || value.body.length === 0) {
    errors.push(`${fileLabel}: body must be a non-empty array`);
    return;
  }

  const ids = new Set<string>();
  const labels = new Set<string>();

  value.body.forEach((bodyItem, index) => {
    const itemLabel = `${fileLabel}: body[${index}]`;
    if (!isRecord(bodyItem)) {
      errors.push(`${itemLabel} must be an object`);
      return;
    }

    if (typeof bodyItem.type !== 'string' || !ALLOWED_BODY_TYPES.has(bodyItem.type)) {
      errors.push(`${itemLabel} has unsupported type "${String(bodyItem.type)}"`);
      return;
    }

    if (!isRecord(bodyItem.attributes)) {
      errors.push(`${itemLabel}.attributes must be an object`);
      return;
    }

    if (bodyItem.type === 'markdown') {
      if (typeof bodyItem.attributes.value !== 'string' || bodyItem.attributes.value.trim() === '') {
        errors.push(`${itemLabel}.attributes.value must be a non-empty string`);
        return;
      }
      collectMarkdownLinks(bodyItem.attributes.value, filePath, links);
      return;
    }

    if (typeof bodyItem.id !== 'string' || !FIELD_ID_PATTERN.test(bodyItem.id)) {
      errors.push(`${itemLabel}.id must contain only letters, numbers, hyphens, and underscores`);
    } else if (ids.has(bodyItem.id)) {
      errors.push(`${fileLabel}: duplicate body id "${bodyItem.id}"`);
    } else {
      ids.add(bodyItem.id);
    }

    const fieldLabel = bodyItem.attributes.label;
    if (typeof fieldLabel !== 'string' || fieldLabel.trim() === '') {
      errors.push(`${itemLabel}.attributes.label must be a non-empty string`);
    } else if (labels.has(fieldLabel)) {
      errors.push(`${fileLabel}: duplicate field label "${fieldLabel}"`);
    } else {
      labels.add(fieldLabel);
    }

    if (bodyItem.type === 'dropdown') {
      validateStringOptions(bodyItem.attributes.options, `${itemLabel}.attributes.options`, errors);
    }

    if (bodyItem.type === 'checkboxes') {
      validateCheckboxOptions(bodyItem.attributes.options, `${itemLabel}.attributes.options`, errors);
    }

    if (bodyItem.validations !== undefined) {
      if (!isRecord(bodyItem.validations)) {
        errors.push(`${itemLabel}.validations must be an object`);
      } else if (bodyItem.validations.required !== undefined && typeof bodyItem.validations.required !== 'boolean') {
        errors.push(`${itemLabel}.validations.required must be a boolean`);
      }
    }
  });
}

async function validateChooser(
  repositoryRoot: string,
  filePath: string,
  errors: string[],
  links: LinkReference[],
): Promise<void> {
  const value = await readYaml(repositoryRoot, filePath, errors);
  const fileLabel = relativePath(repositoryRoot, filePath);
  if (!isRecord(value)) {
    return;
  }

  if (value.blank_issues_enabled !== false) {
    errors.push(`${fileLabel}: blank_issues_enabled must be false`);
  }

  if (!Array.isArray(value.contact_links) || value.contact_links.length === 0) {
    errors.push(`${fileLabel}: contact_links must be a non-empty array`);
    return;
  }

  const names = new Set<string>();
  value.contact_links.forEach((contactLink, index) => {
    const itemLabel = `${fileLabel}: contact_links[${index}]`;
    if (!isRecord(contactLink)) {
      errors.push(`${itemLabel} must be an object`);
      return;
    }

    for (const key of ['name', 'url', 'about']) {
      if (typeof contactLink[key] !== 'string' || contactLink[key].trim() === '') {
        errors.push(`${itemLabel}.${key} must be a non-empty string`);
      }
    }

    if (typeof contactLink.name === 'string') {
      if (names.has(contactLink.name)) {
        errors.push(`${fileLabel}: duplicate contact link name "${contactLink.name}"`);
      }
      names.add(contactLink.name);
    }

    if (typeof contactLink.url === 'string') {
      links.push({ filePath, target: contactLink.url });
    }
  });
}

async function validatePullRequestTemplate(
  repositoryRoot: string,
  filePath: string,
  errors: string[],
  links: LinkReference[],
): Promise<void> {
  const content = await readTextFile(repositoryRoot, filePath, errors);
  if (content === undefined) {
    return;
  }

  const fileLabel = relativePath(repositoryRoot, filePath);
  const headings = new Set(
    [...content.matchAll(/^##\s+(.+?)\s*$/gmu)].map((match) => match[1]?.trim()).filter(isString),
  );

  for (const section of REQUIRED_PULL_REQUEST_SECTIONS) {
    if (!headings.has(section)) {
      errors.push(`${fileLabel}: missing required section "${section}"`);
    }
  }

  if (!/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#/iu.test(content)) {
    errors.push(`${fileLabel}: expected an issue-closing placeholder such as "Closes #123"`);
  }

  collectMarkdownLinks(content, filePath, links);
}

async function collectLinksFromMarkdownFile(
  repositoryRoot: string,
  filePath: string,
  errors: string[],
  links: LinkReference[],
): Promise<void> {
  const content = await readTextFile(repositoryRoot, filePath, errors);
  if (content !== undefined) {
    collectMarkdownLinks(content, filePath, links);
  }
}

function collectMarkdownLinks(content: string, filePath: string, links: LinkReference[]): void {
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const destinationStart = content.indexOf('](', searchFrom);
    if (destinationStart === -1) {
      return;
    }

    const targetStart = destinationStart + 2;
    let targetEnd = targetStart;
    while (targetEnd < content.length) {
      const character = content[targetEnd];
      if (character === ')' || character === undefined || /\s/u.test(character)) {
        break;
      }
      targetEnd += 1;
    }

    const target = content.slice(targetStart, targetEnd);
    if (target !== '') {
      links.push({ filePath, target });
    }

    searchFrom = Math.max(targetEnd + 1, targetStart);
  }
}

async function validateLink(repositoryRoot: string, link: LinkReference, errors: string[]): Promise<void> {
  const fileLabel = relativePath(repositoryRoot, link.filePath);
  const normalizedTarget = stripMarkdownTarget(link.target);
  if (normalizedTarget === '' || normalizedTarget.startsWith('#')) {
    return;
  }

  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(normalizedTarget)) {
    if (!normalizedTarget.startsWith('https://')) {
      errors.push(`${fileLabel}: external URL must use HTTPS: ${link.target}`);
      return;
    }

    try {
      new URL(normalizedTarget);
    } catch {
      errors.push(`${fileLabel}: malformed HTTPS URL: ${link.target}`);
    }
    return;
  }

  const withoutFragment = normalizedTarget.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  if (withoutFragment === '') {
    return;
  }

  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(withoutFragment);
  } catch {
    errors.push(`${fileLabel}: malformed local link: ${link.target}`);
    return;
  }

  const targetPath = decodedTarget.startsWith('/')
    ? path.join(repositoryRoot, decodedTarget.slice(1))
    : path.resolve(path.dirname(link.filePath), decodedTarget);

  if (!isWithinRepository(repositoryRoot, targetPath)) {
    errors.push(`${fileLabel}: local link leaves the repository: ${link.target}`);
    return;
  }

  try {
    await access(targetPath);
  } catch {
    errors.push(`${fileLabel}: local link target does not exist: ${link.target}`);
  }
}

async function readYaml(repositoryRoot: string, filePath: string, errors: string[]): Promise<unknown> {
  const content = await readTextFile(repositoryRoot, filePath, errors);
  if (content === undefined) {
    return undefined;
  }

  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) {
    const fileLabel = relativePath(repositoryRoot, filePath);
    for (const error of document.errors) {
      errors.push(`${fileLabel}: invalid YAML: ${error.message}`);
    }
    return undefined;
  }

  return document.toJS();
}

async function readTextFile(repositoryRoot: string, filePath: string, errors: string[]): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    errors.push(`${relativePath(repositoryRoot, filePath)}: file is missing or unreadable`);
    return undefined;
  }
}

async function readDirectory(directoryPath: string, errors: string[], repositoryRoot: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch {
    errors.push(`${relativePath(repositoryRoot, directoryPath)}: directory is missing or unreadable`);
    return [];
  }
}

function validateStringOptions(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((option) => !isNonEmptyString(option))) {
    errors.push(`${label} must be a non-empty array of strings`);
    return;
  }

  if (new Set(value).size !== value.length) {
    errors.push(`${label} must not contain duplicate options`);
  }
}

function validateCheckboxOptions(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }

  const optionLabels = new Set<string>();
  value.forEach((option, index) => {
    if (!isRecord(option) || !isNonEmptyString(option.label)) {
      errors.push(`${label}[${index}].label must be a non-empty string`);
      return;
    }

    if (optionLabels.has(option.label)) {
      errors.push(`${label} must not contain duplicate labels`);
    }
    optionLabels.add(option.label);

    if (option.required !== undefined && typeof option.required !== 'boolean') {
      errors.push(`${label}[${index}].required must be a boolean`);
    }
  });
}

function requireNonEmptyString(value: Record<string, unknown>, key: string, label: string, errors: string[]): void {
  if (!isNonEmptyString(value[key])) {
    errors.push(`${label}: ${key} must be a non-empty string`);
  }
}

function requireArray(value: Record<string, unknown>, key: string, label: string, errors: string[]): void {
  if (!Array.isArray(value[key])) {
    errors.push(`${label}: ${key} must be an array`);
  }
}

function relativePath(repositoryRoot: string, filePath: string): string {
  return path.relative(repositoryRoot, filePath).replaceAll(path.sep, '/');
}

function stripMarkdownTarget(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

function isWithinRepository(repositoryRoot: string, targetPath: string): boolean {
  const relative = path.relative(repositoryRoot, targetPath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
