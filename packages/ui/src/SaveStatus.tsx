import { projectSaveStatus } from "./save-status.js";
import type { SaveStatusState } from "./save-status.js";

export interface SaveStatusProps {
  readonly state: SaveStatusState;
  readonly onRetryLocal?: () => void;
  readonly onCheckResult?: () => void;
  readonly onRetrySync?: () => void;
  readonly onResolveConflict?: () => void;
}

export function SaveStatus(props: SaveStatusProps) {
  const view = projectSaveStatus(props.state);
  const actions = {
    "retry-local": { label: "重新保存", handler: props.onRetryLocal },
    "check-result": { label: "核对结果", handler: props.onCheckResult },
    "retry-sync": { label: "重试同步", handler: props.onRetrySync },
    "resolve-conflict": { label: "处理冲突", handler: props.onResolveConflict },
  };
  const action = view.action ? actions[view.action] : null;
  return <section className={"save-status tone-" + view.tone} data-phase={props.state.phase} data-operation-id={props.state.operationId}
    aria-live="polite" aria-atomic="true" role="status">
    <div className="status-heading"><span className="status-mark" aria-hidden="true" /><strong>{view.title}</strong></div>
    <p>{view.detail}</p>
    {action?.handler && <button className="status-action" type="button" onClick={action.handler}>{action.label}</button>}
  </section>;
}

