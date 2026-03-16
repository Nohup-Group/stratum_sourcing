/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TEAMS_MSAL_CLIENT_ID?: string;
  readonly VITE_TEAMS_MSAL_AUTHORITY?: string;
  readonly VITE_TEAMS_MSAL_SCOPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
