import { useState } from "react";

export default function CheckoutPage() {
  const [email, setEmail] = useState("");

  return (
    <main>
      <h1>Checkout</h1>
      <label>
        Email
        <input placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <button type="button">Review order</button>
    </main>
  );
}
