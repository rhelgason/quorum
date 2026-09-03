/**
 * What the panel says in each state.
 *
 * Separated from the element so the state → wording mapping is testable
 * without a DOM, and so a translator has one file to look at rather than a
 * render function.
 */

import type { PanelState } from '../../core/src/state.ts';
import type { SubmissionKind } from '../../core/src/protocol.ts';

export interface PanelCopy {
  heading: string;
  placeholder: string;
  submit: string;
  cancel: string;
  /** Status line under the actions. Empty when there is nothing to say. */
  status: string;
  /** Whether the composer is shown at all. */
  showComposer: boolean;
}

const PROMPTS: Record<SubmissionKind, { heading: string; placeholder: string }> = {
  // The default flow asks what the user would change, not what is broken —
  // this is a prioritization product, not a bug tracker (ADR-0012).
  feature_request: {
    heading: 'What would you change?',
    placeholder: 'The one thing that would make this better…',
  },
  bug: { heading: "What's not working?", placeholder: 'What happened, and what did you expect?' },
  question: { heading: 'What are you stuck on?', placeholder: 'Ask away…' },
  praise: { heading: 'What worked well?', placeholder: 'Nice to hear it…' },
  rage: { heading: "What's not working?", placeholder: 'Anything you want to add is optional.' },
};

/**
 * `en` is the only bundled locale. An unknown one falls back to it rather than
 * rendering empty strings — a widget in the wrong language is usable, a widget
 * with no labels is not.
 */
export function copyFor(state: PanelState, kind: SubmissionKind): PanelCopy {
  const prompt = PROMPTS[kind];
  const base: PanelCopy = {
    heading: prompt.heading,
    placeholder: prompt.placeholder,
    submit: 'Send',
    cancel: 'Cancel',
    status: '',
    showComposer: true,
  };

  switch (state) {
    case 'idle':
    case 'opening':
    case 'composing':
      return base;

    case 'picking':
      return { ...base, status: 'Click the element you mean. Escape to cancel.' };

    case 'capturing':
      return { ...base, submit: 'Sending…', status: 'Collecting page context…' };

    case 'submitting':
      return { ...base, submit: 'Sending…', status: 'Sending…' };

    case 'done':
      // Named, so it is clear a human will see it — a thank-you that implies
      // nothing happens next teaches people not to bother again.
      return { ...base, showComposer: false, heading: 'Thanks — that’s logged.', status: '' };

    case 'queued':
      // Say what actually happened. "Failed to send" would be a lie, and
      // "Sent" would be one too.
      return {
        ...base,
        showComposer: false,
        heading: 'Saved — we’ll send it when you’re back online.',
        status: '',
      };

    case 'error':
      return {
        ...base,
        submit: 'Try again',
        status: 'That didn’t send. Your text is still here.',
      };
  }
}
