import { useState } from "react";

export default function OrdersPage() {
  const [status, setStatus] = useState("idle");

  async function refreshOrders() {
    setStatus("loading");
    const response = await fetch("/api/orders");
    setStatus(response.ok ? "Orders refreshed" : "Could not refresh orders");
  }

  return (
    <main>
      <h1>Orders</h1>
      <button data-testid="orders-refresh" type="button" onClick={refreshOrders}>
        Refresh orders
      </button>
      <p role="status">{status}</p>
    </main>
  );
}
