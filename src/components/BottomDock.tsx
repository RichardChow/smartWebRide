import { FileText, GitCompare, ListChecks, Pause, PlayCircle, Route, Settings2, Square, StepForward, Tags } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { argumentFiles, type DebugControl } from '../lib/rideLogic';
import { buildMockDiff } from '../lib/projectUtils';
import type { DebugState, FlowNode, Project, RobotCase, RunPlan, RunSession, SelectionState } from '../types';

interface BottomDockProps {
  project: Project;
  selectedCase: RobotCase | null;
  runSession: RunSession | null;
  runPlan: RunPlan;
  selection: SelectionState;
  allTags: string[];
  debugState: DebugState;
  flowNodes: FlowNode[];
  readOnly: boolean;
  onTagModeChange: (tag: string, mode: 'include' | 'exclude' | 'none') => void;
  onArgumentFileChange: (argumentFile: string) => void;
  onDebugControl: (control: DebugControl) => void;
}

type DockTab = 'runner' | 'log' | 'report' | 'flow' | 'diff';

const dockTabs: Array<{ id: DockTab; label: string; icon: ReactNode }> = [
  { id: 'runner', label: 'Runner', icon: <PlayCircle size={15} /> },
  { id: 'log', label: 'Log', icon: <FileText size={15} /> },
  { id: 'report', label: 'Report', icon: <ListChecks size={15} /> },
  { id: 'flow', label: 'Flow', icon: <Route size={15} /> },
  { id: 'diff', label: 'Diff', icon: <GitCompare size={15} /> }
];

const debugControls: Array<{ id: DebugControl; label: string; icon: ReactNode }> = [
  { id: 'run', label: 'Run', icon: <PlayCircle size={15} /> },
  { id: 'pause', label: 'Pause', icon: <Pause size={15} /> },
  { id: 'continue', label: 'Continue', icon: <StepForward size={15} /> },
  { id: 'next', label: 'Next', icon: <StepForward size={15} /> },
  { id: 'stepOver', label: 'Step Over', icon: <StepForward size={15} /> },
  { id: 'stop', label: 'Stop', icon: <Square size={15} /> }
];

export function BottomDock({
  project,
  selectedCase,
  runSession,
  runPlan,
  selection,
  allTags,
  debugState,
  flowNodes,
  readOnly,
  onTagModeChange,
  onArgumentFileChange,
  onDebugControl
}: BottomDockProps) {
  const [activeTab, setActiveTab] = useState<DockTab>('runner');
  const changes = buildMockDiff(project);
  const visibleTags = allTags.slice(0, 48);

  return (
    <section className="bottom-dock">
      <div className="dock-tabs">
        {dockTabs.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)}>
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      <div className="dock-content">
        {activeTab === 'runner' ? (
          <div className="runner-console-grid">
            <div className="runner-grid">
              <div>
                <strong>Selected</strong>
                <span>{runPlan.selectedCases.length ? `${runPlan.selectedCases.length} cases` : selectedCase?.name ?? project.name}</span>
              </div>
              <div>
                <strong>Slave</strong>
                <span>{runPlan.slaveId}</span>
              </div>
              <div>
                <strong>Debug</strong>
                <span data-testid="debug-status">{debugState.status}</span>
              </div>
              <div>
                <strong>Permission</strong>
                <span>{readOnly ? 'read-only' : 'debug enabled'}</span>
              </div>
            </div>

            <div className="debug-control-row" aria-label="Mock debug controls">
              {debugControls.map((control) => (
                <button
                  key={control.id}
                  className={control.id === 'run' ? 'primary-button mini' : 'secondary-button mini'}
                  disabled={readOnly || !debugState.availableControls.includes(control.id)}
                  onClick={() => onDebugControl(control.id)}
                >
                  {control.icon} {control.label}
                </button>
              ))}
            </div>

            <div className="runner-config-strip">
              <label>
                <Settings2 size={15} /> Argument file
                <select value={selection.argumentFile} onChange={(event) => onArgumentFileChange(event.target.value)}>
                  {argumentFiles.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.label}
                    </option>
                  ))}
                </select>
              </label>
              <pre className="command-preview" data-testid="command-preview">{runPlan.commandPreview}</pre>
            </div>

            <div className="tag-selector-panel">
              <div className="tag-selector-title">
                <Tags size={15} />
                <strong>Tags</strong>
                <span>点击一次 include，再点 exclude，再点清除</span>
              </div>
              <div className="tag-chip-grid">
                {visibleTags.map((tag) => {
                  const mode = selection.includedTags.includes(tag) ? 'include' : selection.excludedTags.includes(tag) ? 'exclude' : 'none';
                  const nextMode = mode === 'none' ? 'include' : mode === 'include' ? 'exclude' : 'none';
                  return (
                    <button key={tag} className={`tag-chip mode-${mode}`} onClick={() => onTagModeChange(tag, nextMode)}>
                      {mode === 'include' ? '+ ' : mode === 'exclude' ? '- ' : ''}
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'log' ? (
          <div className="dock-terminal" data-testid="ride-dock-log">
            {(runSession?.logs ?? ['[idle] 勾选 case 或选择 tag 后点击 Run。']).map((line) => <div key={line}>{line}</div>)}
          </div>
        ) : null}

        {activeTab === 'report' ? (
          <div className="dock-report">
            <span>PASS {runSession?.passed ?? Math.max(1, project.totalCases - 3)}</span>
            <span>FAIL {runSession?.failed ?? 2}</span>
            <span>SKIP {runSession?.skipped ?? 1}</span>
            <span>{project.totalCases} indexed cases</span>
          </div>
        ) : null}

        {activeTab === 'flow' ? (
          <div className="flow-view" data-testid="flow-view">
            {flowNodes.length > 0 ? (
              flowNodes.map((node, index) => (
                <div key={node.id} className={`flow-node type-${node.type} status-${node.status}`}>
                  <span className="flow-index">{index + 1}</span>
                  <div>
                    <strong>{node.label}</strong>
                    <span>{node.type} · line {node.sourceLine}</span>
                  </div>
                </div>
              ))
            ) : (
              <p className="subtle-text">选择 case 后展示步骤流程。</p>
            )}
          </div>
        ) : null}

        {activeTab === 'diff' ? (
          <div className="dock-diff">
            {changes.slice(0, 2).map((change) => (
              <pre key={change.id}>{change.diff}</pre>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
