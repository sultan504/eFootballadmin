// Public Supabase settings (the "anon" key is designed to be public — the
// database Row Level Security decides what it may do; see SETUP_GUIDE.md).
// NEVER put the "service_role" key in this file or anywhere in this site.
const SUPABASE_URL = "https://psbslduycrftfdkajqut.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzYnNsZHV5Y3JmdGZka2FqcXV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3ODAwMjgsImV4cCI6MjEwMzM1NjAyOH0.ytmnZw0ELYNGzpzxATqxjs3euMJ_delht2A4eoi4CKQ";

// Address of your PUBLIC tournament site (used by the "View site" link).
// Example: "https://your-name.github.io/Efootball/". Leave empty to hide the link.
const PUBLIC_SITE_URL = "";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Logos live in the public site's /logos folder; the admin panel shows the same
// crests, so it needs a copy of that folder too (see SETUP_GUIDE.md).
