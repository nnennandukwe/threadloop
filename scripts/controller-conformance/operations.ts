import { compileWorkflowProfile, type Diagnostic } from 'threadloop-contracts/workflow';
import { selectWorkflowDecision } from '../../src/domain/workflow-controller.js';
import { runExecutionScenario } from './execution-scenario.js';

export type Operation = 'compile_graph' | 'decide' | 'execution_scenario';

function invalid(diagnostics: Diagnostic[]) {
  return {
    status: 'invalid',
    diagnostics: diagnostics.map(({ code, path, identifier }) => ({ code, path, identifier })),
  };
}
export function runControllerOperation(operation: Operation, input: unknown) {
  switch (operation) {
    case 'compile_graph': {
      const compiled = compileWorkflowProfile(JSON.stringify(input));
      return compiled.ok ? { status: 'compiled', compiled_graph: compiled.value } : invalid(compiled.diagnostics);
    }
    case 'decide': {
      const decision = selectWorkflowDecision(input);
      return decision.ok ? { status: 'decision', decision: decision.value } : invalid(decision.diagnostics);
    }
    case 'execution_scenario':
      return runExecutionScenario(input);
  }
}
