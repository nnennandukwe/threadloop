import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

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

const text = z.string().trim().min(1);
const fieldId = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must contain only letters, numbers, hyphens, and underscores');

const issueForm = z.object({
  name: text,
  description: text,
  title: text,
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  body: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('markdown'), attributes: z.object({ value: text }) }),
        z.object({
          type: z.enum(['input', 'textarea', 'dropdown', 'checkboxes']),
          id: fieldId,
          attributes: z.looseObject({
            label: text,
            options: z.union([z.array(text).min(1), z.array(z.looseObject({ label: text })).min(1)]).optional(),
          }),
          validations: z.object({ required: z.boolean().optional() }).optional(),
        }),
      ]),
    )
    .min(1)
    .superRefine((fields, context) => {
      for (const key of ['id', 'label'] as const) {
        const seen = new Set<string>();
        for (const field of fields) {
          const value = 'id' in field ? (key === 'id' ? field.id : field.attributes.label) : undefined;
          if (value !== undefined && seen.has(value)) {
            const noun = key === 'id' ? 'body id' : 'field label';
            context.addIssue({ code: 'custom', message: `duplicate ${noun} "${value}"` });
          }
          if (value !== undefined) seen.add(value);
        }
      }
    }),
});

const chooser = z.object({
  blank_issues_enabled: z.literal(false, { message: 'must be false' }),
  contact_links: z.array(z.object({ name: text, url: text, about: text })).min(1),
});

/**
 * Checks what GitHub would not reject on its own: issue forms and the chooser parse into the shape the templates
 * rely on, the pull request template keeps its required sections, and every link in the community files resolves.
 */
export async function validateCommunityRepository(repositoryRoot: string): Promise<string[]> {
  const errors: string[] = [];
  const links: Array<{ file: string; target: string }> = [];
  const label = (file: string) => path.relative(repositoryRoot, file).split(path.sep).join('/');
  const read = async (file: string) => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      errors.push(`${label(file)}: could not be read`);
      return undefined;
    }
  };
  const readYaml = async (file: string) => {
    const content = await read(file);
    if (content === undefined) return undefined;
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length > 0) {
      errors.push(`${label(file)}: invalid YAML`);
      return undefined;
    }
    return document.toJS() as unknown;
  };
  const check = <T>(schema: z.ZodType<T>, value: unknown, file: string) => {
    const result = schema.safeParse(value);
    for (const issue of result.error?.issues ?? []) {
      errors.push(`${label(file)}: ${issue.path.join('.') || '(root)'} ${issue.message}`);
    }
    return result.data;
  };
  const collectLinks = (content: string, file: string) => {
    // A destination is either wrapped in angle brackets, where spaces and parentheses are allowed, or bare.
    // Either form may backslash-escape punctuation, which CommonMark reads as the literal character.
    for (const match of content.matchAll(/\]\((?:<((?:\\.|[^<>\\\n])*)>|((?:\\.|[^)\s\\])+))/g)) {
      const target = (match[1] ?? match[2]) as string;
      links.push({ file, target: target.replace(/\\([!-/:-@[-`{-~])/g, '$1') });
    }
  };

  const templates = path.join(repositoryRoot, '.github', 'ISSUE_TEMPLATE');
  const entries = await readdir(templates).catch(() => [] as string[]);
  const forms = entries.filter((entry) => /\.ya?ml$/.test(entry) && !/^config\.ya?ml$/.test(entry));
  if (forms.length === 0) {
    errors.push('.github/ISSUE_TEMPLATE: expected at least one issue form');
  }
  // Links are collected from the raw documents, so a template with other errors still has its links checked.
  for (const form of forms) {
    const file = path.join(templates, form);
    const value = await readYaml(file);
    check(issueForm, value, file);
    for (const field of rawArray(value, 'body')) {
      const markdown = (field as { attributes?: { value?: unknown } } | null)?.attributes?.value;
      if (typeof markdown === 'string') collectLinks(markdown, file);
    }
  }

  const chooserFile = path.join(templates, entries.includes('config.yaml') ? 'config.yaml' : 'config.yml');
  const chooserValue = await readYaml(chooserFile);
  check(chooser, chooserValue, chooserFile);
  for (const contact of rawArray(chooserValue, 'contact_links')) {
    const url = (contact as { url?: unknown } | null)?.url;
    if (typeof url === 'string') links.push({ file: chooserFile, target: url });
  }

  const pullRequestTemplate = path.join(repositoryRoot, '.github', 'pull_request_template.md');
  const template = await read(pullRequestTemplate);
  if (template !== undefined) {
    const headings = new Set([...template.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]));
    for (const section of REQUIRED_PULL_REQUEST_SECTIONS.filter((required) => !headings.has(required))) {
      errors.push(`${label(pullRequestTemplate)}: missing required section "${section}"`);
    }
    if (!/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#/i.test(template)) {
      errors.push(`${label(pullRequestTemplate)}: expected an issue-closing placeholder such as "Closes #123"`);
    }
    collectLinks(template, pullRequestTemplate);
  }
  for (const file of ['README.md', 'CONTRIBUTING.md'].map((name) => path.join(repositoryRoot, name))) {
    const content = await read(file);
    if (content !== undefined) collectLinks(content, file);
  }

  for (const { file, target } of links) {
    const where = label(file);
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(target)) {
      if (!target.startsWith('https://') || !URL.canParse(target)) {
        errors.push(`${where}: external URL must use HTTPS: ${target}`);
      }
      continue;
    }
    const local = target.split('#', 1)[0]?.split('?', 1)[0] ?? '';
    if (local === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(local);
    } catch {
      errors.push(`${where}: malformed local link: ${target}`);
      continue;
    }
    const resolved = decoded.startsWith('/')
      ? path.join(repositoryRoot, decoded.slice(1))
      : path.resolve(path.dirname(file), decoded);
    const relative = path.relative(repositoryRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(`${where}: local link leaves the repository: ${target}`);
    } else if (
      !(await access(resolved).then(
        () => true,
        () => false,
      ))
    ) {
      errors.push(`${where}: local link target does not exist: ${target}`);
    }
  }

  return [...new Set(errors)].sort();
}

function rawArray(value: unknown, key: string): unknown[] {
  const entry = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(entry) ? entry : [];
}
