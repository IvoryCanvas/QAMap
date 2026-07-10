import { useState } from "react";

export default function CheckoutPage() {
  const [email, setEmail] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  async function submitOrder() {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setConfirmed(response.ok);
  }

  return (
    <main>
      <h1>Checkout</h1>
      <label>
        Email
        <input placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <button data-testid="checkout-submit" type="button" onClick={submitOrder}>
        Place order
      </button>
      {confirmed ? <p>Order confirmed</p> : null}
    </main>
  );
}
