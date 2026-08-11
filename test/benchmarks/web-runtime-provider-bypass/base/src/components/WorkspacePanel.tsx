import { useWorkspace } from "../context/WorkspaceContext";

export function WorkspacePanel() {
  const workspace = useWorkspace();
  return <section>Workspace: {workspace.name}</section>;
}
