import { Edit3, FileSearch, Search } from 'lucide-react';
import { searchCases } from '../lib/projectUtils';
import type { AppView, Project } from '../types';
import { TreeView } from './TreeView';

interface ProjectExplorerProps {
  project: Project;
  selectedPath: string;
  query: string;
  onQueryChange: (value: string) => void;
  onSelectPath: (path: string) => void;
  onNavigate: (view: AppView) => void;
}

export function ProjectExplorer({ project, selectedPath, query, onQueryChange, onSelectPath, onNavigate }: ProjectExplorerProps) {
  const cases = searchCases(project, query, 120);
  const stats = Object.entries(project.fileStats).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="workspace-layout">
      <aside className="left-pane">
        <div className="pane-title">文件树</div>
        <TreeView root={project.tree} selectedPath={selectedPath} onSelectPath={onSelectPath} />
      </aside>
      <main className="main-pane">
        <div className="panel-heading">
          <div>
            <h2>{project.name}</h2>
            <p>{project.root}</p>
          </div>
          <button className="primary-button" onClick={() => onNavigate('editor')}>
            <Edit3 size={16} /> 打开编辑
          </button>
        </div>

        <div className="stats-row">
          {stats.map(([extension, count]) => (
            <span key={extension} className="file-stat">
              {extension} <strong>{count}</strong>
            </span>
          ))}
        </div>

        <div className="search-box">
          <Search size={17} />
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索 case、tag、suite 或文件路径" />
        </div>

        <div className="case-table-wrap">
          <table className="case-table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Suite</th>
                <th>Tags</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((item) => (
                <tr key={item.id} onClick={() => onSelectPath(item.filePath)}>
                  <td>
                    <FileSearch size={15} /> {item.name}
                  </td>
                  <td>{item.suiteName}</td>
                  <td>{item.tags.slice(0, 4).join(', ') || '-'}</td>
                  <td>{item.filePath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
