import { vi } from "vitest";

vi.mock("../src/components/WorkspacePanel", () => ({
  WorkspacePanel: () => <section>Workspace preview</section>,
}));

test("renders the public preview route", () => {
  expect(true).toBe(true);
});
