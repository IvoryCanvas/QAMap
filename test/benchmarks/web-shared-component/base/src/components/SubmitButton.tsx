export function SubmitButton({ onSubmit }: { onSubmit: () => void }) {
  return (
    <button data-testid="checkout-submit" type="button" onClick={onSubmit}>
      Submit
    </button>
  );
}
