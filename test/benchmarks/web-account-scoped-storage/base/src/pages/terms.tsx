import React, { useState } from "react";
import { useSession } from "../auth/session";

export function TermsPage() {
  const session = useSession();
  const [accepted, setAccepted] = useState(false);

  return (
    <main>
      <h1>Terms for {session.displayName}</h1>
      <button data-testid="terms-accept" onClick={() => setAccepted(true)} type="button">
        Accept terms
      </button>
      {accepted ? <p>Terms accepted</p> : null}
    </main>
  );
}
