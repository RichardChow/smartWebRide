import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { buildFlowNodes, buildKeywordIndex, collectAllTags, createInitialDebugState, createRunPlan, transitionDebugState } from './rideLogic';
import { buildRideTree, createInitialSelectionState, deriveSelectedCases, toggleSelection } from './selectionUtils';

const payload = JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'fixtures', 'generated-fixtures.example.json'), 'utf8')) as {
  projects: Project[];
};
const project = payload.projects[0];

describe('RIDE selection and run planning', () => {
  it('checks a single case and marks its parent file as partial', () => {
    const tree = buildRideTree(project);
    const target = project.cases[0];
    const selection = toggleSelection(tree, createInitialSelectionState(), target.id, true);

    expect(selection.checkedNodeIds).toContain(target.id);
    expect(selection.partiallyCheckedNodeIds).toContain(`${project.id}:${target.filePath}`);
    expect(deriveSelectedCases(project, selection).map((item) => item.id)).toEqual([target.id]);
  });

  it('checks a robot file and selects all cases under that file', () => {
    const tree = buildRideTree(project);
    const target = project.cases[0];
    const selection = toggleSelection(tree, createInitialSelectionState(), `${project.id}:${target.filePath}`, true);
    const selected = deriveSelectedCases(project, selection);

    expect(selected.length).toBeGreaterThan(1);
    expect(selected.every((item) => item.filePath === target.filePath)).toBe(true);
  });

  it('collects tags and produces robot command preview with argumentfile', () => {
    const tags = collectAllTags(project);
    const selection = {
      ...createInitialSelectionState(),
      includedTags: [tags[0]],
      excludedTags: ['unstable'],
      argumentFile: 'sanity-smoke.args'
    };
    const plan = createRunPlan(project, 'vm1', selection, false);

    expect(plan.commandPreview).toContain('robot -A sanity-smoke.args');
    expect(plan.commandPreview).toContain(`-i ${tags[0]}`);
    expect(plan.commandPreview).toContain('-e unstable');
  });
});

describe('RIDE keyword and debug logic', () => {
  it('builds keyword index with usages and control keyword classification', () => {
    const index = buildKeywordIndex(project);
    const ifKeyword = index.find((keyword) => keyword.name === 'IF');
    const removeTags = index.find((keyword) => keyword.name.toLowerCase() === 'remove tags');

    expect(ifKeyword?.type).toBe('control');
    expect(removeTags?.type).toBe('builtin');
    expect(index.some((keyword) => keyword.usages.length > 0)).toBe(true);
  });

  it('transitions debug controls through pause, next and stop', () => {
    const running = transitionDebugState(createInitialDebugState(), 'run');
    const paused = transitionDebugState(running, 'pause');
    const next = transitionDebugState(paused, 'next');
    const stopped = transitionDebugState(next, 'stop');

    expect(running.availableControls).toContain('pause');
    expect(paused.availableControls).toContain('continue');
    expect(next.currentStep).toBe(1);
    expect(stopped.status).toBe('stopped');
  });

  it('builds flow nodes for the selected Robot case', () => {
    const running = transitionDebugState(createInitialDebugState(), 'run');
    const nodes = buildFlowNodes(project.cases[0], running);

    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((node) => node.type === 'if' || node.type === 'for')).toBe(true);
    expect(nodes[0].status).toBe('active');
  });
});
