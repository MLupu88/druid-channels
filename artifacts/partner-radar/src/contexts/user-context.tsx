import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { User } from '@workspace/api-client-react';
import { useListUsers, setAuthTokenGetter, createAuthSession } from '@workspace/api-client-react';

interface UserContextType {
  activeUser: User | null;
  setActiveUser: (user: User) => void;
  isLoading: boolean;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const { data: users, isLoading } = useListUsers();
  const [activeUser, setActiveUser] = useState<User | null>(null);

  // Default to Irina (Head of Channels) or first user
  useEffect(() => {
    if (users && users.length > 0 && !activeUser) {
      const headOfChannels = users.find(u => u.role === 'head_of_channels');
      setActiveUser(headOfChannels || users[0]);
    }
  }, [users, activeUser]);

  // The active user picked from the switcher above is exchanged for a
  // signed session token (POST /auth/session) so the API server can verify
  // -- not just trust -- who is making admin-only writes (connections,
  // metric mappings, manual KPI values). There is still no password login
  // in this demo app, but the token is minted and signed by the server
  // itself, so callers can no longer grant themselves admin rights by
  // simply sending a known user id as a header.
  const sessionPromiseRef = useRef<Promise<string | null> | null>(null);
  useEffect(() => {
    if (!activeUser) {
      sessionPromiseRef.current = null;
      setAuthTokenGetter(null);
      return;
    }
    sessionPromiseRef.current = createAuthSession({ user_id: activeUser.id })
      .then((session) => session.token)
      .catch(() => null);
    setAuthTokenGetter(() => sessionPromiseRef.current ?? Promise.resolve(null));
    return () => setAuthTokenGetter(null);
  }, [activeUser]);

  return (
    <UserContext.Provider value={{ activeUser, setActiveUser, isLoading }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
