import { createContext, useContext, useState, useEffect } from 'react';
import { User } from '@workspace/api-client-react';
import { useListUsers } from '@workspace/api-client-react';

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
