import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, KeyRound, ListChecks, Settings, Table2, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileKind, RobotTreeNode } from '../types';

interface TreeViewProps {
  root: RobotTreeNode;
  selectedPath: string;
  onSelectPath: (path: string) => void;
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

export function TreeView({ root, selectedPath, onSelectPath }: TreeViewProps) {
  const initialOpen = useMemo(() => collectInitialOpen(root), [root]);
  const [openIds, setOpenIds] = useState(initialOpen);

  function toggle(node: RobotTreeNode) {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }

  function renderNode(node: RobotTreeNode, depth: number) {
    const isDirectory = node.kind === 'directory';
    const isOpen = openIds.has(node.id);
    const isSelected = selectedPath === node.path;

    return (
      <div key={node.id}>
        <button
          className={`tree-row ${isSelected ? 'is-selected' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => (isDirectory ? toggle(node) : onSelectPath(node.path))}
          title={node.path || node.name}
        >
          <span className="tree-toggle">{isDirectory ? isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</span>
          <span className={`tree-icon kind-${node.kind}`}>{iconByKind[node.kind]}</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {isDirectory && isOpen ? node.children.map((child) => renderNode(child, depth + 1)) : null}
      </div>
    );
  }

  return <div className="tree-view">{renderNode(root, 0)}</div>;
}
