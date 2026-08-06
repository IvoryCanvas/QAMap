export function RegisterPage({ submitRegistration }) {
  return (
    <button data-testid="register-submit" onClick={() => submitRegistration()}>
      Create account
    </button>
  );
}
