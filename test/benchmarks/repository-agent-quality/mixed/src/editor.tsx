import React from 'react';
export function Editor({ value }) {
  return <button disabled={value.trim().length === 0}>Save</button>;
}
