import React from 'react';

export function PreviewNotice({ hasPreview, onDismiss }) {
  if (!hasPreview) return null;
  return <aside>
    <p>Preview is available</p>
    <button aria-label="Dismiss preview" onClick={onDismiss}>Dismiss preview</button>
  </aside>;
}
