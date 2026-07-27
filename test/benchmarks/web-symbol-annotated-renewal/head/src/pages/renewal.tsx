import { useState } from "react";

/**
 * @qamapFlow subscription-renewal
 * @qamapStage action Renew the subscription
 * @qamapOutcome Subscription status becomes active
 * @qamapRisk Duplicate renewal request
 */
export default function RenewalPage() {
  const [status, setStatus] = useState("idle");
  const [renewing, setRenewing] = useState(false);

  async function renew() {
    if (renewing) return;
    setRenewing(true);
    await renewSubscription();
    setStatus("active");
    setRenewing(false);
  }

  return (
    <main>
      <button data-testid="renew-subscription" disabled={renewing} onClick={renew}>Renew subscription</button>
      {status === "active" ? <p>Subscription active</p> : null}
    </main>
  );
}

async function renewSubscription() {
  return { ok: true };
}
