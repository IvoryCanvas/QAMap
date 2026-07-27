import React, { useState } from "react";

/**
 * @qamapFlow subscription-renewal
 * @qamapStage action Renew the subscription
 * @qamapOutcome Subscription status becomes active
 * @qamapRisk Duplicate renewal request
 */
export default function RenewalPage() {
  const [status, setStatus] = useState("idle");

  async function renew() {
    await renewSubscription();
    setStatus("active");
  }

  return (
    <main>
      <button data-testid="renew-subscription" onClick={renew}>Renew subscription</button>
      {status === "active" ? <p>Subscription active</p> : null}
    </main>
  );
}

async function renewSubscription() {
  const response = await fetch("/api/subscriptions/renew", { method: "POST" });
  if (!response.ok) throw new Error("Could not renew subscription");
  return response.json();
}
