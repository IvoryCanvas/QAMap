# Lifecycle Evidence

QAMap can turn supported repository statements into a reviewable sequence:
prepare the declared state, perform the recorded action, and check the stated
result. It does not decide whether that result is the intended product behavior.

## Test Bodies

A changed test with a supported explicit assertion can supply its own setup
and actions. For example:

```tsx
test("shows typed value", async () => {
  render(<InputField value="" />);
  const input = screen.getByRole("textbox");
  await user.type(input, "1234");
  expect(input.value).toBe("12-34");
});
```

The scenario retains the render and element lookup as setup, the typing call as
the action, and the exact assertion as the expected result. Each statement has
its own source line. A separate paste test keeps its own input and expectation.

Supported body statements currently include:

| Family | Evidence |
| --- | --- |
| JavaScript tests | Single-line render or mount calls, `screen` or `page` element lookups, common `user`, `userEvent`, `fireEvent`, and `page` interactions |
| Dart widget tests | `tester.pumpWidget`, tap and text-entry interactions, and frame synchronization |
| Ruby Minitest | Literal hash setup, explicit request actions, and a service `.call` connected to the assertion |

Frame synchronization is an action, not proof of a state transition. Bodies
must be contiguous added lines between the declaration and its first supported
assertion, within the existing six-line assertion window. Missing lines,
multiline statements, and nested helpers stop body enrichment. Unsupported
statements are not translated into invented user actions. The existing test
declaration and assertion evidence can still remain available.

## Source-Only States

In JSX and TSX files, a complete named top-level component can connect a literal
`useState` declaration, a simple inline button setter, and a conditional render:

```tsx
export function RequestView() {
  const [phase, setPhase] = useState("idle");
  return <>
    <button onClick={() => setPhase("pending")}>Load</button>
    {phase === "pending" && <p>Working</p>}
  </>;
}
```

QAMap proposes the declared initial state, the Load button action, the
`setPhase("pending")` transition, and the conditional Working result. The
declaration and button may be unchanged supporting source if the result changed.
Evidence is read from the requested Git head, or the working tree only when
that mode is selected.

This bounded path supports literal equality conditions, `&&` rendering of
literal text in native elements, and single-line inline setters on native
buttons. Different conditions get separate scenarios. It does not follow custom
components, arbitrary handlers, reducers, hooks, or dynamic state wiring. State
or actions from a neighboring component are never borrowed. A formatting-only
change or an unrelated edit does not activate an unchanged contract.
Source statements are limited to 240 characters and at most 24 contracts per
analysis, in stable file order. Large or unsupported expressions are skipped.

## Analysis Rule Changes

A file's analysis role is context, not proof that every edit changes its rules.
Rule-specific scenarios and risk explanations require direct changed-line
evidence, such as a recognized analyzer contract or rule-evaluation syntax.
Adding a read counter beside an unchanged analyzer does not justify a claim
about changed findings or false positives. When a counter and a rule change
together, rule explanations cite the rule line, not the first line in the hunk.

Related imports and schemas remain contextual evidence so one analyzer change
can stay in one review flow. Unsupported or context-only changes retain their
source locations without inventing rule behavior. This is bounded recognition,
not a proof of every rule's semantics; changes needing unavailable surrounding
definitions still require review. Removed definitions retain base-side evidence.

## Missing Evidence

- No supported setup or action: leave that field empty and identify the gap.
- Multiple controls reach the same state: list the ambiguity without choosing one.
- No explicit intermediate transition: retain the action and result without inventing one.
- Unsupported syntax: retain other available repository evidence, not a fabricated lifecycle.

All inferred scenarios remain review-required drafts with `execution: not-run`
until a separate execution actually occurs. Test expectations and source states
are not specifications by themselves. Existing scenario and agent-output limits
still apply; use omitted counts and the local full report to recover details.
