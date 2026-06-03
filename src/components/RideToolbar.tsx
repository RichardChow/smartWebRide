import { FileDown, FolderOpen, Lock, Pause, Play, Save, Search, SkipForward, Square, StepForward, Wand2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DebugControl } from '../lib/rideLogic';
import type { DebugState, Project, RunPlan, SlaveSession } from '../types';

interface RideToolbarProps {
  project: Project;
  selectedPath: string;
  query: string;
  readOnly: boolean;
  slaveSession: SlaveSession | null;
  debugState: DebugState;
  runPlan: RunPlan;
  onQueryChange: (value: string) => void;
  onDebugControl: (control: DebugControl) => void;
}

const controlButtons: Array<{ id: DebugControl; label: string; icon: ReactNode }> = [
  { id: 'run', label: 'Run', icon: <Play size={16} /> },
  { id: 'pause', label: 'Pause', icon: <Pause size={16} /> },
  { id: 'continue', label: 'Continue', icon: <SkipForward size={16} /> },
  { id: 'next', label: 'Next', icon: <StepForward size={16} /> },
  { id: 'stepOver', label: 'Step Over', icon: <StepForward size={16} /> },
  { id: 'stop', label: 'Stop', icon: <Square size={16} /> }
];

export function RideToolbar({
  project,
  selectedPath,
  query,
  readOnly,
  slaveSession,
  debugState,
  runPlan,
  onQueryChange,
  onDebugControl
}: RideToolbarProps) {
  return (
    <div className={`ride-toolbar ${readOnly ? 'is-readonly' : ''}`} aria-label="RIDE 工具栏">
      <div className="ride-toolbar-group">
        <button className="tool-button" disabled title="第一阶段不打开外部目录">
          <FolderOpen size={16} /> Open
        </button>
        <button className="tool-button" disabled={readOnly} title={readOnly ? '只读会话不能保存' : '后续接入 Agent 写回文件'}>
          <Save size={16} /> Save
        </button>
        <button className="tool-button" disabled title="后续在办公室环境接入 SVN">
          <FileDown size={16} /> SVN
        </button>
      </div>

      <div className="ride-toolbar-group run-actions">
        {controlButtons.map((control) => {
          const available = debugState.availableControls.includes(control.id);
          return (
            <button
              key={control.id}
              className={`tool-button ${control.id === 'run' ? 'run' : ''}`}
              disabled={readOnly || !available}
              onClick={() => onDebugControl(control.id)}
              title={readOnly ? '当前 slave 被占用，只能查看' : `${control.label} mock debug`}
            >
              {control.icon} {control.label}
            </button>
          );
        })}
      </div>

      <div className="ride-search">
        <Search size={16} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Find case / keyword / tag" />
      </div>

      <div className="ride-context">
        <Wand2 size={15} />
        <span>{project.name}</span>
        <strong>{selectedPath || 'no file selected'}</strong>
        <span className={`lock-chip ${readOnly ? 'readonly' : 'editable'}`}>
          <Lock size={14} />
          {readOnly ? '只读' : '可调试'} · {slaveSession?.name ?? runPlan.slaveId}
        </span>
      </div>
    </div>
  );
}
