'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// PostMind Core's context carries no business list (Phase 4 review list), so the UI keeps the
// active business id per browser (localStorage) and lets the user switch it in the top bar.

const STORAGE_KEY = 'studio.businessId';

interface BusinessContextValue {
  businessId: string | null;
  setBusinessId: (id: string | null) => void;
  ready: boolean;
}

const BusinessContext = createContext<BusinessContextValue>({
  businessId: null,
  setBusinessId: () => undefined,
  ready: false,
});

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function BusinessProvider({ children, initial }: { children: ReactNode; initial?: string }) {
  const [businessId, setState] = useState<string | null>(initial ?? null);
  const [ready, setReady] = useState(Boolean(initial));

  useEffect(() => {
    if (!initial) setState(readStored());
    setReady(true);
  }, [initial]);

  const setBusinessId = useCallback((id: string | null) => {
    const value = id?.trim() || null;
    setState(value);
    try {
      if (value) window.localStorage.setItem(STORAGE_KEY, value);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable (private mode): keep in memory only
    }
  }, []);

  const value = useMemo(
    () => ({ businessId, setBusinessId, ready }),
    [businessId, setBusinessId, ready],
  );
  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}

export function useBusiness(): BusinessContextValue {
  return useContext(BusinessContext);
}
