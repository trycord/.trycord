// The workflows that run here.
//
// A workflow is a trigger, some conditions and some steps. It runs with a
// capability grant set, it is bounded, and every run of it is recorded with
// what each step did and why it failed.
//
// A dry run is the same walk with nothing carried out: it says what would have
// happened and does nothing, which is the only honest way to ask before doing.
// A run that reaches a step asking for an approval waits there until somebody
// decides, and the decision is shown in the history with everything else.

import { el } from '../../../packages/dom.js';
import { State } from '../../../packages/store.js';
import { icon } from '../../../packages/icons.js';
import { formatDateTime } from '../../../packages/locale.js';
import { card, row, blank, fault, fold, facts, hold, memo } from '../../ui/page.js';
import { confirmDialog, openDialog, errorToast, toast } from '../../ui/overlays.js';
import {
  approveRun, dryRunWorkflow, grantWorkflowCapability, pauseWorkflow, readRun,
  readWorkflow, readWorkflowRuns, readWorkflows, resumeWorkflow, revokeWorkflowCapability,
  runWorkflow,
} from './api.js';
import {
  capabilityChip, capabilityLabel, grantedSet, isOperator, runStateChip, workflowStateChip,
} from './parts.js';

// What wakes a workflow.
export function triggerLabel(trigger) {
  const value = trigger && typeof trigger === 'object' ? trigger : {};
  if (value.type === 'event') return 'on ' + (value.event || 'an event');
  if (value.type === 'schedule') {
    return 'every ' + Math.round((Number(value.everyMs) || 0) / 60000) + ' minutes';
  }
  return 'by hand';
}

// What one step of a workflow is.
export function stepLabel(step) {
  const value = step && typeof step === 'object' ? step : {};
  if (value.type === 'approval') return 'waits for an approval';
  if (value.type === 'code') return 'runs extension code';
  return value.action || 'a step';
}

// How long a run took, in the reader's own words.
export function duration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return value + ' ms';
  return (value / 1000).toFixed(1) + ' s';
}

export function workflowsSection() {
  const listHost = el('div', { class: 'rowlist' });
  const detailHost = el('div', { class: 'fold' });
  let workflows = [];
  let selectedId = null;

  const me = () => (State.user && State.user.id) || null;

  // Whether the reader may act on this workflow. The server decides, and this
  // only keeps the console from offering a control that would be refused.
  const mayManage = (workflow) => isOperator() || (me() && workflow.ownerId === me());

  // -- the list ----------------------------------------------------------------

  function paintList() {
    if (!workflows.length) {
      listHost.replaceChildren(blank({
        glyph: 'activity',
        title: 'No workflows here',
        text: 'Nothing on this instance runs on a trigger yet.',
      }));
      return;
    }
    listHost.replaceChildren(...workflows.map((workflow) => row({
      lead: el('span', { class: 'role-dot' }, icon('activity', { size: 15 })),
      title: workflow.name,
      sub: triggerLabel(workflow.trigger) + (workflow.description ? ' · ' + workflow.description : ''),
      meta: workflowStateChip(workflow.state),
      active: workflow.id === selectedId,
      onClick: () => open(workflow.id),
    })));
  }

  // -- one workflow ------------------------------------------------------------

  async function open(workflowId) {
    selectedId = workflowId;
    paintList();
    detailHost.replaceChildren(card({ label: 'The workflow', body: hold('Reading the workflow') }));
    try {
      const answer = await readWorkflow(workflowId);
      const workflow = (answer && answer.workflow) || null;
      if (!workflow) {
        detailHost.replaceChildren(card({
          label: 'The workflow',
          body: blank({ glyph: 'activity', title: 'It is not here', text: 'That workflow does not exist.' }),
        }));
        return;
      }
      detailHost.replaceChildren(await detailCard(workflow));
    } catch (error) {
      detailHost.replaceChildren(card({ label: 'The workflow', body: fault(error, () => open(workflowId)) }));
    }
  }

  async function detailCard(workflow) {
    const runsHost = el('div', { class: 'rowlist' });
    const grantsHost = el('div', { class: 'fold fold--tight' });
    const cardNode = card({
      label: workflow.name,
      glyph: 'activity',
      note: 'version ' + (workflow.version || 1),
      actions: el('span', { class: 'chips' }, workflowStateChip(workflow.state)),
      body: el('div', { class: 'fold' },
        workflow.description ? el('p', { class: 'lede' }, workflow.description) : null,
        facts([
          { value: triggerLabel(workflow.trigger), label: 'It runs' },
          { value: (workflow.steps || []).length, label: 'Steps' },
          { value: (workflow.grants || []).length, label: 'Capabilities' },
        ]),
        stepsBlock(workflow),
        grantsHost,
        el('p', { class: 'form-note' }, 'Its runs:'),
        runsHost),
      foot: actionsBlock(workflow),
    });

    const runs = await readRuns(workflow);
    // The capabilities this workflow's own steps have asked for are the ones
    // its runs record. They are what an administrator may grant, and what the
    // steps will be refused without.
    const observed = await observedCapabilities(runs);
    grantsHost.replaceChildren(grantsBlock(workflow, observed));
    paintRuns(workflow, runsHost, runs);
    return cardNode;
  }

  // The steps of a workflow, as it declares them.
  function stepsBlock(workflow) {
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    if (!steps.length) {
      return el('p', { class: 'form-note' }, 'It has no steps. A run of it does nothing and records that it did.');
    }
    const rows = steps.map((step, index) => el('div', { class: 'settings-item' },
      el('div', { class: 'settings-item-main' },
        el('p', { class: 'settings-item-label' }, (index + 1) + '. ' + stepLabel(step)),
        step && step.type === 'approval'
          ? el('p', { class: 'settings-note' }, 'The run waits here until somebody decides.')
          : null)));
    return el('div', { class: 'fold fold--tight' },
      el('p', { class: 'form-note' }, 'Its steps:'),
      el('div', { class: 'fold fold--tight' }, rows));
  }

  // The capabilities the workflow holds, and how to give it another.
  function grantsBlock(workflow, observed) {
    const granted = Array.isArray(workflow.grants) ? workflow.grants : [];
    const held = grantedSet(granted);
    const blocks = [el('p', { class: 'form-note' }, 'The capabilities it holds:')];

    if (granted.length) {
      blocks.push(el('div', { class: 'fold fold--tight' }, granted.map((capability) => el('div', { class: 'settings-item' },
        el('div', { class: 'settings-item-main' },
          el('p', { class: 'settings-item-label' }, capabilityLabel(capability),
            el('span', { class: 'form-note' }, ' ' + capability))),
        el('div', { class: 'settings-item-control' }, capabilityChip(capability, true)),
        isOperator()
          ? el('div', { class: 'settings-item-actions' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Take back ' + capabilityLabel(capability) + ' from ' + workflow.name,
              onClick: async () => {
                const yes = await confirmDialog({
                  title: 'Take this capability back?',
                  body: workflow.name + ' stops being able to use ' + capabilityLabel(capability)
                    + ' on its next call.',
                  confirmLabel: 'Take it back',
                  danger: true,
                });
                if (!yes) return;
                try {
                  await revokeWorkflowCapability(workflow.id, capability, null);
                  toast('Taken back');
                  await open(workflow.id);
                } catch (error) { errorToast(error); }
              },
            }, 'Take it back'))
          : null))));
    } else {
      blocks.push(el('p', { class: 'form-note' },
        'None. It may only do what its owner could do by hand.'));
    }

    if (isOperator()) {
      const listId = 'workflow-capabilities-' + workflow.id;
      const name = el('input', {
        class: 'input', type: 'text', list: listId,
        'aria-label': 'The capability to grant to ' + workflow.name,
        placeholder: 'messages.read',
      });
      const choices = el('datalist', { id: listId },
        ...observed.map((capability) => el('option', { value: capability })));
      const give = el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        'aria-label': 'Grant a capability to ' + workflow.name,
        onClick: async () => {
          const capability = name.value.trim();
          if (!capability) {
            toast('Name the capability to grant.', { type: 'error' });
            return;
          }
          give.disabled = true;
          try {
            await grantWorkflowCapability(workflow.id, capability, null);
            toast('Granted ' + capabilityLabel(capability));
            await open(workflow.id);
          } catch (error) { errorToast(error); } finally { give.disabled = false; }
        },
      }, 'Grant it');
      blocks.push(el('div', { class: 'form-stack' },
        el('p', { class: 'form-note' },
          'Grant another capability. The server knows which capabilities this instance has, '
          + 'and refuses one it does not know.'),
        name,
        choices,
        give));
    }
    return el('div', { class: 'fold fold--tight' }, blocks);
  }

  // What may be done to the workflow.
  function actionsBlock(workflow) {
    if (!mayManage(workflow)) return null;
    const buttons = [];
    buttons.push(el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      'aria-label': 'Run ' + workflow.name + ' now',
      onClick: async () => {
        try {
          const answer = await runWorkflow(workflow.id, {});
          const run = (answer && answer.run) || {};
          toast('Ran: ' + (run.status || 'done'));
          await open(workflow.id);
        } catch (error) { errorToast(error); }
      },
    }, 'Run it'));
    buttons.push(el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
      'aria-label': 'See what a run of ' + workflow.name + ' would do, without doing it',
      onClick: () => openDryRun(workflow),
    }, 'Dry run'));
    if (workflow.state === 'active') {
      buttons.push(el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        'aria-label': 'Pause ' + workflow.name,
        onClick: async () => {
          try {
            await pauseWorkflow(workflow.id);
            toast('Paused');
            await open(workflow.id);
          } catch (error) { errorToast(error); }
        },
      }, 'Pause'));
    } else {
      buttons.push(el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        'aria-label': 'Let ' + workflow.name + ' run again',
        onClick: async () => {
          try {
            await resumeWorkflow(workflow.id);
            toast('Resumed');
            await open(workflow.id);
          } catch (error) { errorToast(error); }
        },
      }, 'Resume'));
    }
    return el('div', { class: 'actionline' }, buttons);
  }

  // -- the history ---------------------------------------------------------------

  async function readRuns(workflow) {
    const answer = await readWorkflowRuns(workflow.id);
    return (answer && answer.runs) || [];
  }

  // The capabilities the steps of the newest run asked for. They are the ones
  // this workflow has tried to use, and the ones an administrator may grant.
  async function observedCapabilities(runs) {
    if (!runs.length) return [];
    try {
      const answer = await readRun(runs[0].id);
      const steps = (answer && answer.steps) || [];
      const found = [];
      for (const step of steps) {
        const capability = step && step.capability ? String(step.capability) : '';
        if (capability && found.indexOf(capability) === -1) found.push(capability);
      }
      return found;
    } catch {
      return [];
    }
  }

  function paintRuns(workflow, host, runs) {
    if (!runs.length) {
      host.replaceChildren(blank({
        glyph: 'clock',
        title: 'It has not run yet',
        text: 'Nothing has been recorded for this workflow.',
      }));
      return;
    }
    host.replaceChildren(...runs.map((run) => runRow(workflow, run)));
  }

  function runRow(workflow, run) {
    const waiting = run.status === 'awaiting_approval';
    return row({
      lead: el('span', { class: 'role-dot' }, icon(waiting ? 'clock' : 'activity', { size: 15 })),
      title: formatDateTime(run.startedAt) || (run.id || 'a run'),
      sub: run.reason ? run.reason : (run.dryRun ? 'a dry run: nothing was done' : 'no reason was recorded'),
      meta: el('span', { class: 'chips' },
        runStateChip(run.status),
        el('span', { class: 'chip chip--quiet' }, duration(run.durationMs))),
      side: el('div', { class: 'cardrow-side' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'See the steps of the run of ' + workflow.name,
          onClick: () => openRun(run),
        }, 'The steps'),
        waiting ? el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          'aria-label': 'Approve the run of ' + workflow.name + ' that is waiting',
          onClick: () => decide(workflow, run, true),
        }, 'Approve') : null,
        waiting ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Refuse the run of ' + workflow.name + ' that is waiting',
          onClick: () => decide(workflow, run, false),
        }, 'Refuse') : null),
    });
  }

  // One run, with every step of it.
  function openRun(run) {
    const body = el('div', { class: 'fold' });
    const dialog = openDialog({
      title: 'One run',
      sub: run.status ? 'It ended as ' + String(run.status).replace(/_/g, ' ') : '',
      body,
    });
    body.replaceChildren(hold('Reading the run'));
    readRun(run.id).then((answer) => {
      const detail = (answer && answer.run) ? answer : { run, steps: [] };
      const steps = detail.steps || [];
      const granted = grantedSet((detail.workflow && detail.workflow.grants) || []);
      body.replaceChildren(el('div', { class: 'fold fold--tight' },
        el('p', { class: 'form-note' }, detail.run && detail.run.reason
          ? 'Why it ended: ' + detail.run.reason
          : 'No reason was recorded for this run.'),
        steps.length
          ? el('div', { class: 'fold fold--tight' }, steps.map((step) => stepRow(step, granted)))
          : el('p', { class: 'form-note' }, 'It recorded no steps.')));
    }).catch((error) => {
      body.replaceChildren(fault(error, null));
    });
    return dialog;
  }

  // One step of a run: what it did, why it failed, and how long it took.
  function stepRow(step, granted) {
    const capability = step && step.capability ? String(step.capability) : null;
    const held = capability ? granted.has(capability) : true;
    return el('div', { class: 'settings-item' },
      el('div', { class: 'settings-item-main' },
        el('p', { class: 'settings-item-label' }, (step.index + 1) + '. ' + stepLabel(step)),
        el('p', { class: 'settings-note' }, step.error
          ? 'It failed: ' + step.error
          : (step.output && step.output.note ? step.output.note : 'It did not record a reason.')),
        capability
          ? el('p', { class: 'settings-note' }, held
            ? 'It used ' + capabilityLabel(capability) + ', which the workflow holds.'
            : 'It needed ' + capabilityLabel(capability) + ', which the workflow does not hold.')
          : null),
      el('div', { class: 'settings-item-control' },
        el('span', { class: 'chips' },
          runStateChip(step.status),
          capability ? capabilityChip(capability, held) : null,
          el('span', { class: 'chip chip--quiet' }, duration(step.durationMs)))));
  }

  // Approving or refusing a run that is waiting.
  async function decide(workflow, run, approved) {
    if (approved) {
      const yes = await confirmDialog({
        title: 'Approve this run?',
        body: 'The workflow carries on from the step that was waiting. Whatever it does next, it does as '
          + 'the owner of ' + workflow.name + '.',
        confirmLabel: 'Approve it',
      });
      if (!yes) return;
    } else {
      const yes = await confirmDialog({
        title: 'Refuse this run?',
        body: 'The run is cancelled and stops here. It stays in the history as a refusal.',
        confirmLabel: 'Refuse it',
        danger: true,
      });
      if (!yes) return;
    }
    try {
      const answer = await approveRun(run.id, { approved });
      toast(approved ? 'Approved' : 'Refused');
      if (answer && answer.status) toast('The run is now ' + answer.status);
      await open(workflow.id);
    } catch (error) { errorToast(error); }
  }

  // The dry run: what would have happened, and the fact that nothing did.
  function openDryRun(workflow) {
    const body = el('div', { class: 'fold' });
    const dialog = openDialog({
      title: 'What a run would do',
      sub: 'Nothing is carried out. This is the plan, not the result.',
      body,
    });
    body.replaceChildren(hold('Working out the plan'));
    dryRunWorkflow(workflow.id, {}).then((answer) => {
      const plan = (answer && answer.plan) || [];
      const run = (answer && answer.run) || {};
      const rows = plan.map((step) => el('div', { class: 'settings-item' },
        el('div', { class: 'settings-item-main' },
          el('p', { class: 'settings-item-label' }, (step.index + 1) + '. ' + stepLabel(step)),
          el('p', { class: 'settings-note' }, step.note
            || (step.description || 'The step would be carried out.'))),
        el('div', { class: 'settings-item-control' },
          el('span', { class: 'chips' },
            step.permitted === false
              ? el('span', { class: 'chip chip--warn' }, 'would be refused')
              : el('span', { class: 'chip chip--on' }, 'would be allowed')))));
      body.replaceChildren(el('div', { class: 'fold fold--tight' },
        memo({
          tone: 'info',
          title: 'Nothing was done',
          text: 'A dry run reads the workflow and writes nothing. No message is posted and no capability is spent.',
        }),
        run.reason ? el('p', { class: 'form-note' }, 'It would end as ' + (run.status || 'unknown')
          + (run.reason ? ': ' + run.reason : '.')) : null,
        plan.length
          ? el('div', { class: 'fold fold--tight' }, rows)
          : el('p', { class: 'form-note' }, 'It would do nothing at all.')));
    }).catch((error) => {
      body.replaceChildren(fault(error, null));
    });
    return dialog;
  }

  // -- the section ---------------------------------------------------------------

  async function paint() {
    listHost.replaceChildren(hold('Reading the workflows'));
    try {
      const answer = await readWorkflows();
      workflows = (answer && answer.workflows) || [];
      paintList();
      if (!selectedId && workflows.length) await open(workflows[0].id);
      else if (selectedId && !workflows.some((entry) => entry.id === selectedId)) {
        selectedId = null;
        detailHost.replaceChildren(card({
          label: 'The workflow',
          body: blank({ glyph: 'activity', title: 'Pick one', text: 'Choose a workflow to see it.' }),
        }));
      }
    } catch (error) {
      listHost.replaceChildren(fault(error, paint));
    }
  }

  return {
    node: fold([
      el('div', { class: 'deck' },
        card({ label: 'The workflows here', glyph: 'activity', flush: true, body: listHost }),
        detailHost),
    ]),
    onMount: () => paint(),
    cleanup() {},
  };
}

export default { workflowsSection };
