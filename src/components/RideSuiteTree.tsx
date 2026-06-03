import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, KeyRound, ListChecks, Settings, Table2, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { buildRideTree, toggleSelection } from '../lib/selectionUtils';
import type { FileKind, Project, RobotCase, RobotTreeNode, SelectionState } from '../types';

interface RideSuiteTreeProps {
  project: Project;
  selectedPath: string;
  selection: SelectionState;
  onSelectionChange: (selection: SelectionState) => void;
  onSelectPath: (path: string) => void;
  onSelectCase: (testCase: RobotCase) => void;
}

const iconByKind: Record<FileKind, ReactNode> = {
  directory: <Folder size={15} />,
  robot: <FileCode2 size={15} />,
  resource: <Wrench size={15} />,
  config: <Settings size={15} />,
  script: <FileText size={15} />,
  data: <Table2 size={15} />,
  text: <FileText size={15} />,
  case: <ListChecks size={15} />,
  keyword: <KeyRound size={15} />,
  other: <FileText size={15} />
};

function collectInitialOpen(node: RobotTreeNode, depth = 0, output = new Set<string>()): Set<string> {
  if (node.kind === 'directory' && depth < 2) output.add(node.id);
  node.children.slice(0, 24).forEach((child) => collectInitialOpen(child, depth + 1, output));
  return output;
}

function CheckboxState({
  checked,
  partial,
  label,
  onChange
}: {
  checked: boolean;
  partial: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

export function RideSuiteTree({ project, selectedPath, selection, onSelectionChange, onSelectPath, onSelectCase }: RideSuiteTreeProps) {
  const rideTree = useMemo(() => buildRideTree(project), [project]);
  const initialOpen = useMemo(() => collectInitialOpen(rideTree), [rideTree]);
  const [openIds, setOpenIds] = useState(initialOpen);
  const checked = useMemo(() => new Set(selection.checkedNodeIds), [selection.checkedNodeIds]);
  const partial = useMemo(() => new Set(selection.partiallyCheckedNodeIds), [selection.partiallyCheckedNodeIds]);

  useEffect(() => {
    setOpenIds(initialOpen);
  }, [initialOpen]);

  function toggleOpen(node: RobotTreeNode) {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }

  function selectNode(node: RobotTreeNode) {
    if (node.kind === 'directory') {
      toggleOpen(node);
      return;
    }

    if (node.kind === 'case') {
      const [filePath] = node.path.split('#');
      const testCase = project.cases.find((item) => item.id === node.id);
      if (testCase) onSelectCase(testCase);
      onSelectPath(filePath);
      return;
    }

    onSelectPath(node.path);
    if (node.children.length > 0) toggleOpen(node);
  }

  function renderNode(node: RobotTreeNode, depth: number): ReactNode {
    const isOpen = openIds.has(node.id);
    const hasChildren = node.children.length > 0;
    const isSelected = selectedPath === node.path || (node.kind === 'case' && selectedPath === node.path.split('#')[0]);

    return (
      <div key={node.id}>
        <div
          role="button"
          tabIndex={0}
          className={`tree-row ride-tree-row ${isSelected ? 'is-selected' : ''} ${partial.has(node.id) ? 'is-partial' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => selectNode(node)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectNode(node);
            }
          }}
          title={node.path || node.name}
        >
          <span className="tree-toggle">{hasChildren ? isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</span>
          <CheckboxState
            checked={checked.has(node.id)}
            partial={partial.has(node.id)}
            label={`选择 ${node.name}`}
            onChange={(nextChecked) => onSelectionChange(toggleSelection(rideTree, selection, node.id, nextChecked))}
          />
          <span className={`tree-icon kind-${node.kind}`}>{iconByKind[node.kind]}</span>
          <span className="tree-name">{node.name}</span>
          {node.kind === 'case' ? <span className="tree-case-mark">case</span> : null}
        </div>
        {hasChildren && isOpen ? node.children.map((child) => renderNode(child, depth + 1)) : null}
      </div>
    );
  }

  return <div className="tree-view ride-suite-tree">{renderNode(rideTree, 0)}</div>;
}
