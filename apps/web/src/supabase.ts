import { createClient } from '@supabase/supabase-js';

// The project URL and publishable key are public by design: they ship in the web app,
// and the database's access rules (supabase/migrations) decide what they can reach.
// Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to point at a different project.
const URL = import.meta.env.VITE_SUPABASE_URL ?? 'https://kfooveatamcwpnfgtruy.supabase.co';
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_KY4VZi0Me1YhAcC3gZtV6A_J5gvSegq';

export const supabase = createClient(URL, KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Sign-in uses a typed code, not a link, so there is nothing to read from the URL.
    detectSessionInUrl: false,
  },
});
