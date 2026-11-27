/**
 * Curated Compose recipes (ADR 0058).
 *
 * A recipe is a reviewed starting point for the existing **New stack** form: an
 * id, a pre-filled `compose.yaml` and `.env`, and a note. It adds no
 * provisioning engine, no registry, no remote fetch and no lifecycle. The panel
 * only renders a recipe into the form; the operator edits it, and after
 * creation the stack is an ordinary stack the operator owns.
 */

export interface StackRecipe {
    id: string;
    label: string;
    summary: string;
    /** Stack folder name offered by the prefill; the operator may change it. */
    name: string;
    compose: string;
    env: string;
    /** Shown above the pre-filled form. */
    note: string;
}

const LIBREDB_COMPOSE = `services:
  studio:
    # LibreDB Studio 1.3.0 (2026-11-10), pinned by digest. The panel reports a
    # digest-pinned image as "not tracked"; upgrade by editing the tag and the
    # digest together. See docs/integrations/libredb.md.
    image: ghcr.io/libredb/libredb-studio:1.3.0@sha256:3521f28fc2732a040715015669dfb475a1f2bc60b31025cb58ef472379ca74c7
    restart: unless-stopped
    # Studio's own shutdown takes up to 25 s; Compose defaults to 10 s.
    stop_grace_period: 30s
    # Loopback only. Change the host port if 3001 is taken, or reach it through
    # an SSH tunnel: ssh -N -L 3001:127.0.0.1:3001 you@host
    ports:
      - "127.0.0.1:3001:3000"
    environment:
      ADMIN_EMAIL: \${ADMIN_EMAIL:-admin@libredb.org}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD:?set a strong LibreDB administrator password}
      JWT_SECRET: \${JWT_SECRET:?set a random secret of at least 32 characters}
      AUTH_BOOTSTRAP: "off"
      # Interactive mode: connections are created in LibreDB. Set
      # ALLOW_CUSTOM_CONNECTIONS=false only together with a seeded
      # seed-connections.yaml, or the instance becomes unusable.
      STORAGE_PROVIDER: sqlite
      STORAGE_SQLITE_PATH: /app/data/libredb-storage.db
    volumes:
      - libredb-data:/app/data

volumes:
  libredb-data:
`;

const LIBREDB_ENV = `# The form is refused while a required value is empty.
# Single-quote a value that contains "$": Compose expands unquoted values.
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=
# At least 32 characters. Generate one with: openssl rand -base64 32
JWT_SECRET=
`;

const LIBREDB_NOTE =
    "This recipe only fills the form. Set ADMIN_PASSWORD and JWT_SECRET, keep or change the loopback port, then create the stack: nothing is pulled or started. LibreDB is an administration tool: reach it through a private path (VPN or an IP allow-list in Caddy) or an SSH tunnel, not through a public domain.";

export const STACK_RECIPES: readonly StackRecipe[] = [
    {
        id: "libredb",
        label: "LibreDB Studio",
        summary: "Explore and administer PostgreSQL, MariaDB, MySQL and other databases from the browser.",
        name: "libredb",
        compose: LIBREDB_COMPOSE,
        env: LIBREDB_ENV,
        note: LIBREDB_NOTE,
    },
];

/** The recipe a request names, or null for an unknown or absent id. */
export function stackRecipe(id: string | null | undefined): StackRecipe | null {
    if (!id) return null;
    return STACK_RECIPES.find((recipe) => recipe.id === id) ?? null;
}
