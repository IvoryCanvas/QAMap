import { WorkspacePanel } from "../src/components/WorkspacePanel";

function PublicPreviewPage() {
  return (
    <main>
      <h1>Public preview</h1>
      <WorkspacePanel />
    </main>
  );
}

PublicPreviewPage.publicPage = true;

export default PublicPreviewPage;
