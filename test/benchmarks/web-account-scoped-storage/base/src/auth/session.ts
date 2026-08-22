export interface Session {
  userId: number;
  displayName: string;
}

export function useSession(): Session {
  return { userId: 1, displayName: "member" };
}
