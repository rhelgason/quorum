/**
 * The panel state machine.
 *
 * It lives in core rather than in any view because the web component and the
 * native iOS/Android UIs all drive it. That is how the flow stays consistent
 * across platforms without sharing rendering code — see
 * `docs/adr/0008-native-mobile-ui-no-webview.md`.
 *
 *   idle → opening → composing → [picking] → capturing → submitting → done
 *                        ↑___________|            |
 *                                             queued (offline)
 */

export type PanelState =
  | 'idle'
  | 'opening'
  | 'composing'
  /** Element picker active; the panel is collapsed but the flow is not cancelled. */
  | 'picking'
  | 'capturing'
  | 'submitting'
  /** Persisted to the offline queue; the user is told it will send later. */
  | 'queued'
  | 'done'
  | 'error';

export type QuorumEventName =
  | 'open'
  | 'close'
  | 'submit'
  | 'queued'
  | 'error'
  | 'frustration'
  | 'stateChange';

export interface QuorumEventMap {
  open: { kind?: string };
  close: { reason: 'user' | 'submitted' | 'programmatic' };
  /** `id` is the client-generated ULID, available before the network round trip. */
  submit: { id: string };
  queued: { id: string; queueDepth: number };
  error: { error: Error; recoverable: boolean };
  frustration: { score: number; signals: Record<string, number> };
  stateChange: { from: PanelState; to: PanelState };
}
