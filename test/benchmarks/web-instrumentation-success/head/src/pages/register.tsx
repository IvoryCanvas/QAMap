export function RegisterPage({ analyticsClient, submitRegistration }) {
  async function handleRegistration() {
    const result = await submitRegistration();
    if (result.ok) {
      analyticsClient.track("registration_completed", { source: "form" });
    }
  }

  return (
    <button data-testid="register-submit" onClick={handleRegistration}>
      Create account
    </button>
  );
}
