import React, { useState } from "react";
import { useSession } from "../auth/session";

const ACCEPTED_KEY = "terms:accepted-at:v1";

export function TermsPage() {
  const session = useSession();
  const [accepted, setAccepted] = useState(
    () => window.localStorage.getItem(ACCEPTED_KEY) !== null,
  );

  function acceptTerms() {
    window.localStorage.setItem(ACCEPTED_KEY, new Date().toISOString());
    setAccepted(true);
  }

  return (
    <main>
      <h1>Terms for {session.displayName}</h1>
      <button data-testid="terms-accept" onClick={acceptTerms} type="button">
        Accept terms
      </button>
      {accepted ? <p>Terms accepted</p> : null}
    </main>
  );
}
