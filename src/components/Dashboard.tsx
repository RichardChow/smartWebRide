import { Activity, ArrowRight, CheckCircle2, Clock, GitCompare, Server, Workflow, XCircle } from 'lucide-react';
import { executionNodes } from '../data/mockRuntime';
import { formatBytes } from '../lib/projectUtils';
import type { AppView, Project } from '../types';

interface DashboardProps {
  projects: Project[];
  currentProject: Project;
  onSelectProject: (id: string) => void;
  onNavigate: (view: AppView) => void;
}

export function Dashboard({ projects, currentProject, onSelectProject, onNavigate }: DashboardProps) {
  const totalCases = projects.reduce((sum, item) => sum + item.totalCases, 0);
  const totalRobot = projects.reduce((sum, item) => sum + item.totalRobotFiles, 0);

  return (
    <div className="view-stack">
      <section className="hero-band">
        <div>
          <p className="eyebrow">Phase 1 Prototype</p>
          <h1>smartWebRide 调试工作台</h1>
          <p className="subtle-text">
            当前只接本地真实 Robot 目录 fixture，执行、报告、SVN、Jenkins 均为 mock 占位。
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={() => onNavigate('explorer')}>
            <Workflow size={17} /> 进入项目浏览
          </button>
          <button className="secondary-button" onClick={() => onNavigate('run')}>
            <Activity size={17} /> 模拟执行
          </button>
        </div>
      </section>

      <section className="metrics-grid">
        <div className="metric-tile">
          <span>项目</span>
          <strong>{projects.length}</strong>
        </div>
        <div className="metric-tile">
          <span>Robot 文件</span>
          <strong>{totalRobot}</strong>
        </div>
        <div className="metric-tile">
          <span>Case 索引</span>
          <strong>{totalCases}</strong>
        </div>
        <div className="metric-tile">
          <span>当前项目体量</span>
          <strong>{formatBytes(currentProject.totalSize)}</strong>
        </div>
      </section>

      <section className="split-grid">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>Demo 项目</h2>
              <p>来自 `test_data/Case` 的真实目录。</p>
            </div>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                className={`project-row ${project.id === currentProject.id ? 'is-selected' : ''}`}
                onClick={() => onSelectProject(project.id)}
              >
                <div>
                  <strong>{project.name}</strong>
                  <span>{project.description}</span>
                </div>
                <div className="project-row-meta">
                  <span>{project.totalRobotFiles} robot</span>
                  <span>{project.totalCases} cases</span>
                  <ArrowRight size={16} />
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>节点占位</h2>
              <p>办公室 slave 后续接入，家庭阶段仅模拟状态。</p>
            </div>
          </div>
          <div className="node-list">
            {executionNodes.map((node) => (
              <div key={node.id} className="node-row">
                <Server size={18} />
                <div>
                  <strong>{node.name}</strong>
                  <span>{node.host} · {node.system}</span>
                </div>
                <StatusBadge status={node.status} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="timeline-strip">
          <button onClick={() => onNavigate('editor')}>
            <CheckCircle2 size={16} /> Web RIDE 界面
          </button>
          <button onClick={() => onNavigate('run')}>
            <Clock size={16} /> 执行调试 mock
          </button>
          <button onClick={() => onNavigate('reports')}>
            <XCircle size={16} /> 报告摘要
          </button>
          <button onClick={() => onNavigate('changes')}>
            <GitCompare size={16} /> 变更 diff 占位
          </button>
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}
