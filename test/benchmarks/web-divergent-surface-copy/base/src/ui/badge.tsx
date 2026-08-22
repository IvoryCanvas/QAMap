import React from "react";

export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>;
}
