import { Lock, Play, Server, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { executionNodes } from '../data/mockRuntime';
import { createMockRunSession, searchCases } from '../lib/projectUtils';
import type { Project, RunSession } from '../types';

interface RunViewProps {
  project: Project;
  query: string;
  onQueryChange: (value: string) => void;
}

export function RunView({ project, query, onQueryChange }: RunViewProps) {
  const [selectedNode, setSelectedNode] = useState(executionNodes[0]?.id ?? '');
  const [session, setSession] = useState<RunSession | null>(null);
  const cases = useMemo(() => searchCases(project, query, 24), [project, query]);

  function startRun() {
    setSession(createMockRunSession(project, query || cases[0]?.name || project.name, selectedNode));
  }

  return (
    <div className="run-layout">
      <section className="panel run-control">
        <div className="panel-heading">
          <div>
            <h2>执行调试</h2>
            <p>当前为 mock run，不启动真实 Robot。</p>
          </div>
          <button className="primary-button" onClick={startRun}>
            <Play size={16} /> 启动 mock run
          </button>
        </div>

        <label className="field-label">
          运行目标
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="输入 case、suite 或 tag" />
        </label>

        <div className="node-grid">
          {executionNodes.map((node) => (
            <button
              key={node.id}
              className={`node-choice ${selectedNode === node.id ? 'is-selected' : ''}`}
              onClick={() => setSelectedNode(node.id)}
            >
              <Server size={18} />
              <strong>{node.name}</strong>
              <span>{node.host}</span>
              <small>{node.status === 'locked' ? `locked by ${node.owner}` : node.status}</small>
            </button>
          ))}
        </div>

        <div className="case-suggestions">
          {cases.slice(0, 12).map((item) => (
            <button key={item.id} onClick={() => onQueryChange(item.name)}>
              {item.name}
            </button>
          ))}
        </div>
      </section>

      <section className="panel console-panel">
        <div className="panel-heading">
          <div>
            <h2>实时日志</h2>
            <p>模拟 WebSocket/SSE 日志流。</p>
          </div>
          <button className="secondary-button" disabled>
            <Square size={15} /> 停止占位
          </button>
        </div>
        <div className="terminal" data-testid="run-log">
          {session ? session.logs.map((line) => <div key={line}>{line}</div>) : <div>[idle] 选择目标后启动 mock run</div>}
        </div>
        {session ? (
          <div className="run-summary">
            <span><Play size={15} /> {session.status}</span>
            <span>PASS {session.passed}</span>
            <span>FAIL {session.failed}</span>
            <span>SKIP {session.skipped}</span>
            <span><Lock size={15} /> {selectedNode}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
