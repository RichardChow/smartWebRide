import type { Project, RobotCase, RobotTreeNode, SelectionState } from '../types';

type NodeState = 'checked' | 'partial' | 'none';

export function createInitialSelectionState(): SelectionState {
  return {
    checkedNodeIds: [],
    partiallyCheckedNodeIds: [],
    includedTags: [],
    excludedTags: [],
    argumentFile: 'default.args'
  };
}

export function buildRideTree(project: Project): RobotTreeNode {
  const casesByFile = new Map<string, RobotCase[]>();
  for (const testCase of project.cases) {
    const cases = casesByFile.get(testCase.filePath) ?? [];
    cases.push(testCase);
    casesByFile.set(testCase.filePath, cases);
  }

  function clone(node: RobotTreeNode): RobotTreeNode {
    const children = node.children.map(clone);
    if (node.kind === 'robot') {
      const caseNodes: RobotTreeNode[] = (casesByFile.get(node.path) ?? []).map((testCase) => ({
        id: testCase.id,
        name: testCase.name,
        path: `${testCase.filePath}#${testCase.line}`,
        kind: 'case',
        extension: 'case',
        size: 0,
        children: []
      }));
      return { ...node, children: [...children, ...caseNodes] };
    }
    return { ...node, children };
  }

  return clone(project.tree);
}

export function flattenRideTree(node: RobotTreeNode): RobotTreeNode[] {
  return [node, ...node.children.flatMap((child) => flattenRideTree(child))];
}

export function findRideNode(root: RobotTreeNode, nodeId: string): RobotTreeNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const found = findRideNode(child, nodeId);
    if (found) return found;
  }
  return undefined;
}

export function collectDescendantIds(node: RobotTreeNode): string[] {
  return [node.id, ...node.children.flatMap(collectDescendantIds)];
}

export function toggleSelection(root: RobotTreeNode, state: SelectionState, nodeId: string, nextChecked?: boolean): SelectionState {
  const target = findRideNode(root, nodeId);
  if (!target) return state;

  const checked = new Set(state.checkedNodeIds);
  const descendants = collectDescendantIds(target);
  const shouldCheck = nextChecked ?? !checked.has(nodeId);

  for (const id of descendants) {
    if (shouldCheck) checked.add(id);
    else checked.delete(id);
  }

  const resolved = resolveSelection(root, checked);
  return {
    ...state,
    checkedNodeIds: Array.from(resolved.checked),
    partiallyCheckedNodeIds: Array.from(resolved.partial)
  };
}

export function resolveSelection(root: RobotTreeNode, initialChecked: Set<string>): { checked: Set<string>; partial: Set<string> } {
  const checked = new Set(initialChecked);
  const partial = new Set<string>();

  function visit(node: RobotTreeNode): NodeState {
    if (node.children.length === 0) return checked.has(node.id) ? 'checked' : 'none';

    const childStates = node.children.map(visit);
    const allChecked = childStates.every((state) => state === 'checked');
    const someChecked = childStates.some((state) => state === 'checked' || state === 'partial');

    if (allChecked && childStates.length > 0) {
      checked.add(node.id);
      partial.delete(node.id);
      return 'checked';
    }

    checked.delete(node.id);
    if (someChecked) {
      partial.add(node.id);
      return 'partial';
    }

    partial.delete(node.id);
    return 'none';
  }

  visit(root);
  return { checked, partial };
}

export function deriveSelectedCases(project: Project, state: SelectionState): RobotCase[] {
  const checked = new Set(state.checkedNodeIds);
  return project.cases.filter((testCase) => checked.has(testCase.id) || checked.has(`${project.id}:${testCase.filePath}`));
}

export function getSelectionSummary(project: Project, state: SelectionState): string {
  const selectedCases = deriveSelectedCases(project, state);
  if (selectedCases.length > 0) return `${selectedCases.length} cases`;
  if (state.includedTags.length > 0 || state.excludedTags.length > 0) return '按 tag 过滤';
  return '未选择 case';
}
