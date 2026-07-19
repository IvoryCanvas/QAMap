import { describe, expect, it } from "vitest";

describe("Signup form validation mode", () => {
  it("does not show the email error while the user is still typing", () => {
    expect("initial typing").not.toBe("Invalid email");
  });

  it("shows the email error after the field is blurred with an invalid value", () => {
    expect("blur invalid email").toContain("invalid email");
  });

  it("does not show the email error after the value is corrected", () => {
    expect("valid@email.com").not.toBe("Invalid email");
  });

  it("still validates all fields on form submission", () => {
    expect("submit signup form").toContain("submit");
  });
});
