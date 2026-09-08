import React from 'react';
export function Editor({ value, readOnly }) {
  return <button disabled={readOnly || value.trim().length === 0}>Save</button>;
}
