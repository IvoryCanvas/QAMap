import { createContext, useContext } from "react";

const WorkspaceContext = createContext(null);

export function WorkspaceProvider({ children }) {
  return (
    <WorkspaceContext.Provider value={{ name: "Demo" }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return context;
}
