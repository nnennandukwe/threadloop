import { isAlias, isScalar, parseDocument, visit } from 'yaml';
import {
  diagnostic,
  validateShape,
  workflowProfileSchema,
  type ValidationResult,
  type WorkflowProfile,
} from './contracts.js';

export function parseWorkflowProfile(source: string): ValidationResult<WorkflowProfile> {
  try {
    const document = parseDocument(source, {
      version: '1.2',
      schema: 'core',
      uniqueKeys: true,
      resolveKnownTags: false,
    });
    if (document.errors.length || document.warnings.length || document.directives.yaml.version !== '1.2') {
      throw new Error('Expected one valid YAML 1.2 document without warnings or duplicate keys.');
    }
    visit(document, {
      Node(_key, node) {
        if (isAlias(node) || node.tag || node.anchor)
          throw new Error('Aliases, anchors, and explicit tags are not supported.');
        if (isScalar(node) && typeof node.value === 'number' && !Number.isSafeInteger(node.value)) {
          throw new Error('Numeric values must be finite safe integers.');
        }
      },
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<') {
          throw new Error('Mapping keys must be strings; merge keys are not supported.');
        }
      },
    });
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    return validateShape(workflowProfileSchema, value);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'YAML_INVALID',
          '$',
          null,
          error instanceof Error ? error.message : 'Invalid YAML.',
          'Use a single YAML 1.2 document with plain JSON-compatible values and quote the schema version.',
        ),
      ],
    };
  }
}
