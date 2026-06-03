import { GitCompare, LockKeyhole, Plus, RotateCcw } from 'lucide-react';
import { buildMockDiff } from '../lib/projectUtils';
import type { Project } from '../types';

interface ChangesViewProps {
  project: Project;
}

export function ChangesView({ project }: ChangesViewProps) {
  const changes = buildMockDiff(project);

  return (
    <div className="changes-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>变更预览</h2>
            <p>第一阶段只展示 mock diff，不访问办公室 SVN。</p>
          </div>
          <button className="secondary-button" disabled>
            <LockKeyhole size={16} /> 提交占位
          </button>
        </div>
        <div className="change-list">
          {changes.map((change) => (
            <div key={change.id} className="change-row">
              {change.status === 'added' ? <Plus size={16} /> : <RotateCcw size={16} />}
              <div>
                <strong>{change.path}</strong>
                <span>{change.status}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel diff-panel">
        <div className="panel-heading">
          <div>
            <h2><GitCompare size={18} /> svn diff 占位</h2>
            <p>后续真实接入时保持 VcsChange 模型不变。</p>
          </div>
        </div>
        {changes.map((change) => (
          <pre key={change.id} className="diff-block">{change.diff}</pre>
        ))}
      </section>
    </div>
  );
}
