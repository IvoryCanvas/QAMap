import React from 'react';

export function DocumentationLink({ router, isInternal }) {
  function openDocumentation() {
    if (isInternal) router.push('/docs');
    else window.location.assign('https://docs.example.test');
  }
  return <button aria-label="Open documentation" onClick={openDocumentation}>Documentation</button>;
}
