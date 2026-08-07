import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import {
  useLogin,
  useLogout as useLogoutMutation,
  useGetCurrentUser,
  setAuthTokenGetter,
  getGetCurrentUserQueryKey,
} from '@workspace/api-client-react';
import type { User } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

const TOKEN_STORAGE_KEY = 'druid_session_token';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isGlobalUser: boolean;
  sessionToken: string | null;
  login: (email: string, password: string) => Promise<void>;
  loginError: string | null;
  isLoggingIn: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [loginError, setLoginError] = useState<string | null>(null);

  // Wire the stored session token into every API request via the bearer
  // token getter. This is re-registered whenever the token changes so that
  // logging in/out immediately affects subsequent requests.
  useEffect(() => {
    setAuthTokenGetter(token ? () => token : null);
    return () => setAuthTokenGetter(null);
  }, [token]);

  const { data: user, isLoading, isFetched, isError } = useGetCurrentUser({
    query: {
      enabled: !!token,
      retry: false,
      queryKey: getGetCurrentUserQueryKey(),
    },
  });

  // If the stored token is invalid/expired, GET /auth/me fails -- treat that
  // as "logged out" rather than leaving the app in limbo.
  useEffect(() => {
    if (token && isError) {
      setToken(null);
      try {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [token, isError]);

  const loginMutation = useLogin();
  const logoutMutation = useLogoutMutation();

  const login = useCallback(
    async (email: string, password: string) => {
      setLoginError(null);
      try {
        const result = await loginMutation.mutateAsync({ data: { email, password } });
        setToken(result.token);
        try {
          localStorage.setItem(TOKEN_STORAGE_KEY, result.token);
        } catch {
          /* ignore storage errors */
        }
        await queryClient.invalidateQueries();
      } catch (err: any) {
        setLoginError(err?.message ?? 'Invalid email or password');
        throw err;
      }
    },
    [loginMutation, queryClient],
  );

  const logout = useCallback(() => {
    logoutMutation.mutate();
    setToken(null);
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    queryClient.clear();
  }, [logoutMutation, queryClient]);

  const isGlobalUser = user ? user.role === 'head_of_channels' || user.role === 'admin' : false;

  const value = useMemo<AuthContextType>(
    () => ({
      user: user ?? null,
      isLoading: !!token && (isLoading || !isFetched),
      isGlobalUser,
      sessionToken: token,
      login,
      loginError,
      isLoggingIn: loginMutation.isPending,
      logout,
    }),
    [user, token, isLoading, isFetched, isGlobalUser, login, loginError, loginMutation.isPending, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
