export function SubmitButton({ onSubmit }: { onSubmit: () => void }) {
  return (
    <button
      aria-label="Place order"
      data-testid="checkout-submit"
      type="button"
      onClick={onSubmit}
    >
      Place order
    </button>
  );
}
