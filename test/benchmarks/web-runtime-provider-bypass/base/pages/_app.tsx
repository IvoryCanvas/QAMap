import { WorkspaceProvider } from "../src/context/WorkspaceContext";

export default function App({ Component, pageProps }) {
  if (Component.publicPage) {
    return <Component {...pageProps} />;
  }
  return (
    <WorkspaceProvider>
      <Component {...pageProps} />
    </WorkspaceProvider>
  );
}
