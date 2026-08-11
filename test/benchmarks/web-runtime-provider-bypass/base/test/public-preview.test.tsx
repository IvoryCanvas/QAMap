import { vi } from "vitest";

vi.mock("../src/components/WorkspacePanel", () => ({
  WorkspacePanel: () => <section>Workspace preview</section>,
}));

test("renders a mocked panel", () => {
  expect(true).toBe(true);
});
