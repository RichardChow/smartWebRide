import type { DebugState, FlowNode, KeywordIndex, KeywordUsage, Project, RobotCase, RunPlan, SelectionState } from '../types';
import { deriveSelectedCases } from './selectionUtils';

export type DebugControl = 'run' | 'pause' | 'continue' | 'next' | 'stepOver' | 'stop';

export const argumentFiles = [
  { id: 'default.args', label: 'default.args', content: '--loglevel INFO\n--outputdir output/smartWebRide' },
  { id: 'sanity-smoke.args', label: 'sanity-smoke.args', content: '--include sanity\n--exclude unstable\n--variable RUN_MODE:debug' },
  { id: 'local-debug.args', label: 'local-debug.args', content: '--loglevel DEBUG\n--console verbose\n--variable LOCAL_DEBUG:true' }
];

const controlKeywords = new Set(['IF', 'ELSE', 'ELSE IF', 'FOR', 'WHILE', 'TRY', 'EXCEPT', 'FINALLY', 'END']);
const builtInKeywords = new Set([
  'log',
  'log to console',
  'no operation',
  'sleep',
  'set variable',
  'create list',
  'remove tags',
  'should be equal',
  'should contain',
  'run keyword',
  'run keyword if'
]);

function splitRobotStep(step: string): string[] {
  return step.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean);
}

export function getStepKeyword(step: string): string {
  const parts = splitRobotStep(step);
  if (parts.length === 0) return '';
  const first = parts[0];
  const upper = first.toUpperCase();
  if (controlKeywords.has(upper)) return upper;
  if (/^[@$&%]\{.+}\s*=?$/.test(first) && parts[1]) return parts[1];
  return first;
}

export function getStepArguments(step: string): string[] {
  const parts = splitRobotStep(step);
  if (parts.length <= 1) return [];
  if (/^[@$&%]\{.+}\s*=?$/.test(parts[0]) && parts[2]) return parts.slice(2);
  return parts.slice(1);
}

export function collectAllTags(project: Project): string[] {
  return Array.from(new Set(project.cases.flatMap((testCase) => testCase.tags).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, 'zh-CN', { numeric: true })
  );
}

function parseKeywordDefinitions(project: Project): Map<string, KeywordIndex> {
  const definitions = new Map<string, KeywordIndex>();

  for (const [filePath, content] of Object.entries(project.fileContents)) {
    const lines = content.split('\n');
    let section = '';
    let currentKeyword = '';

    lines.forEach((rawLine, index) => {
      const trimmed = rawLine.trim();
      const sectionMatch = trimmed.match(/^\*{3}\s*(.*?)\s*\*{3}$/);
      if (sectionMatch) {
        section = sectionMatch[1].toLowerCase();
        currentKeyword = '';
        return;
      }

      if (!section.includes('keyword') || !trimmed || trimmed.startsWith('#')) return;

      const isIndented = /^\s/.test(rawLine);
      if (!isIndented) {
        currentKeyword = trimmed;
        definitions.set(currentKeyword.toLowerCase(), {
          name: currentKeyword,
          type: filePath.endsWith('.resource') ? 'resource' : 'user',
          sourceFile: filePath,
          line: index + 1,
          arguments: [],
          documentation: '',
          usages: []
        });
        return;
      }

      if (!currentKeyword) return;
      const keyword = definitions.get(currentKeyword.toLowerCase());
      if (!keyword) return;

      if (/^\[Arguments\]/i.test(trimmed)) {
        keyword.arguments = trimmed.replace(/^\[Arguments\]\s*/i, '').split(/\s{2,}|\t+/).filter(Boolean);
      }
      if (/^\[Documentation\]/i.test(trimmed)) {
        keyword.documentation = trimmed.replace(/^\[Documentation\]\s*/i, '').slice(0, 240);
      }
    });
  }

  return definitions;
}

function classifyKeyword(name: string, definitions: Map<string, KeywordIndex>): KeywordIndex['type'] {
  const normalized = name.toLowerCase();
  if (controlKeywords.has(name.toUpperCase())) return 'control';
  if (/^[@$&%]\{/.test(name)) return 'variable';
  if (builtInKeywords.has(normalized)) return 'builtin';
  if (definitions.has(normalized)) return definitions.get(normalized)?.type ?? 'user';
  if (name.includes('.')) return 'library';
  return 'unresolved';
}

export function buildKeywordIndex(project: Project): KeywordIndex[] {
  const definitions = parseKeywordDefinitions(project);
  const index = new Map<string, KeywordIndex>();

  for (const definition of definitions.values()) {
    index.set(definition.name.toLowerCase(), { ...definition, usages: [] });
  }

  for (const testCase of project.cases) {
    testCase.steps.forEach((step, stepIndex) => {
      const name = getStepKeyword(step);
      if (!name) return;
      const key = name.toLowerCase();
      const type = classifyKeyword(name, definitions);
      const existing = index.get(key);
      const usage: KeywordUsage = {
        filePath: testCase.filePath,
        caseName: testCase.name,
        line: testCase.line + stepIndex + 1
      };

      if (existing) {
        existing.usages.push(usage);
        return;
      }

      index.set(key, {
        name,
        type,
        sourceFile: type === 'builtin' ? 'Robot Framework BuiltIn' : type === 'control' ? 'Robot Framework syntax' : '',
        line: 0,
        arguments: getStepArguments(step).map((_, index) => `arg${index + 1}`),
        documentation:
          type === 'builtin'
            ? 'Robot Framework BuiltIn keyword. 后续接入 libdoc 后显示完整文档。'
            : type === 'control'
              ? 'Robot Framework 控制结构。'
              : '当前 fixture 未解析到定义，后续由 Agent 在 slave working copy 中补全。',
        usages: [usage]
      });
    });
  }

  return Array.from(index.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

export function findKeyword(index: KeywordIndex[], name: string): KeywordIndex | undefined {
  return index.find((keyword) => keyword.name.toLowerCase() === name.toLowerCase());
}

export function getKeywordType(index: KeywordIndex[], name: string): KeywordIndex['type'] {
  return findKeyword(index, name)?.type ?? 'unresolved';
}

function quoteRobotArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function createRunPlan(project: Project, slaveId: string, selection: SelectionState, readOnly: boolean): RunPlan {
  const selectedCases = deriveSelectedCases(project, selection);
  const selectedSuites = Array.from(new Set(selectedCases.map((testCase) => testCase.filePath)));
  const parts = ['robot'];

  if (selection.argumentFile) parts.push('-A', quoteRobotArg(selection.argumentFile));
  for (const tag of selection.includedTags) parts.push('-i', quoteRobotArg(tag));
  for (const tag of selection.excludedTags) parts.push('-e', quoteRobotArg(tag));
  for (const testCase of selectedCases.slice(0, 8)) parts.push('-t', quoteRobotArg(testCase.name));
  if (selectedCases.length > 8) parts.push(`# ... ${selectedCases.length - 8} more cases`);
  parts.push(quoteRobotArg(project.root));

  return {
    projectId: project.id,
    slaveId,
    selectedSuites,
    selectedCases,
    includeTags: selection.includedTags,
    excludeTags: selection.excludedTags,
    argumentFile: selection.argumentFile,
    commandPreview: readOnly ? `# read-only session\n${parts.join(' ')}` : parts.join(' '),
    readOnly
  };
}

export function createInitialDebugState(): DebugState {
  return controlsForStatus('idle', 0);
}

export function transitionDebugState(state: DebugState, control: DebugControl): DebugState {
  if (control === 'run') return controlsForStatus('running', 0);
  if (control === 'pause' && state.status === 'running') return controlsForStatus('paused', state.currentStep);
  if (control === 'continue' && state.status === 'paused') return controlsForStatus('running', state.currentStep);
  if (control === 'next' && state.status === 'paused') return controlsForStatus('paused', state.currentStep + 1);
  if (control === 'stepOver' && state.status === 'paused') return controlsForStatus('paused', state.currentStep + 1);
  if (control === 'stop' && state.status !== 'idle') return controlsForStatus('stopped', state.currentStep);
  return state;
}

function controlsForStatus(status: DebugState['status'], currentStep: number): DebugState {
  const availableControls: DebugState['availableControls'] =
    status === 'idle' || status === 'stopped'
      ? ['run']
      : status === 'running'
        ? ['pause', 'stop']
        : status === 'paused'
          ? ['continue', 'next', 'stepOver', 'stop']
          : [];
  return { status, currentStep, availableControls };
}

export function buildFlowNodes(testCase: RobotCase | null, debugState: DebugState): FlowNode[] {
  if (!testCase) return [];
  const steps = testCase.steps.length > 0 ? testCase.steps : ['No Operation'];
  return steps.map((step, index) => {
    const keyword = getStepKeyword(step) || step;
    const upper = keyword.toUpperCase();
    const type: FlowNode['type'] =
      upper === 'IF' ? 'if' : upper === 'FOR' ? 'for' : upper === 'WHILE' ? 'while' : upper === 'TRY' ? 'try' : upper === 'END' ? 'end' : 'step';
    const status: FlowNode['status'] =
      debugState.status === 'idle' || debugState.status === 'stopped'
        ? 'idle'
        : index < debugState.currentStep
          ? 'passed'
          : index === debugState.currentStep
            ? 'active'
            : 'idle';

    return {
      id: `${testCase.id}:flow:${index}`,
      label: keyword,
      type,
      sourceLine: testCase.line + index + 1,
      status
    };
  });
}
