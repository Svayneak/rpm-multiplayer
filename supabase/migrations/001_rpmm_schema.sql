-- ============================================================================
-- 001_rpmm_schema.sql: RPMM Canonical Database Schema for Supabase PostgreSQL
-- Specification: RPM Multiplayer Production Persistence Architecture ([D01]-[D40])
--
-- Strict Convention: All tables MUST use the 'RPMM_' prefix.
-- ============================================================================

-- 0. Shared trigger function to update updated_at timestamp
CREATE OR REPLACE FUNCTION rpmm_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. RPMM_profiles: Player accounts, Elo, unlocked slots & stats
CREATE TABLE IF NOT EXISTS "RPMM_profiles" (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  birthday_day INT CHECK (birthday_day IS NULL OR (birthday_day BETWEEN 1 AND 31)),
  unlocked_slots INT NOT NULL DEFAULT 2,
  elo_rating INT NOT NULL DEFAULT 1200,
  ai_settings JSONB NOT NULL DEFAULT '{"preferred_deck": "STARTER_WHITE_WEENIE", "difficulty": "BALANCED"}'::jsonb,
  total_rpm_rolls INT NOT NULL DEFAULT 0,
  total_rpbd_triggers INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_profiles_email ON "RPMM_profiles"(email);

DROP TRIGGER IF EXISTS trg_rpmm_profiles_updated_at ON "RPMM_profiles";
CREATE TRIGGER trg_rpmm_profiles_updated_at
BEFORE UPDATE ON "RPMM_profiles"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 2. RPMM_auth_tokens: Persistent 365-day device sessions & authority status
CREATE TABLE IF NOT EXISTS "RPMM_auth_tokens" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "RPMM_profiles"(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  device_label TEXT NOT NULL DEFAULT 'DESKTOP',
  is_active_connection BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_auth_tokens_user ON "RPMM_auth_tokens"(user_id);
CREATE INDEX IF NOT EXISTS idx_rpmm_auth_tokens_hash ON "RPMM_auth_tokens"(token_hash);

DROP TRIGGER IF EXISTS trg_rpmm_auth_tokens_updated_at ON "RPMM_auth_tokens";
CREATE TRIGGER trg_rpmm_auth_tokens_updated_at
BEFORE UPDATE ON "RPMM_auth_tokens"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 3. RPMM_decks: Cloud deck slots (1..6) with 10-revision history ([D13]-[D17])
CREATE TABLE IF NOT EXISTS "RPMM_decks" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "RPMM_profiles"(id) ON DELETE CASCADE,
  slot_number INT NOT NULL CHECK (slot_number BETWEEN 1 AND 6),
  name TEXT NOT NULL,
  decklist_text TEXT NOT NULL,
  cards_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_valid BOOLEAN NOT NULL DEFAULT TRUE,
  support_percentage NUMERIC NOT NULL DEFAULT 100,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rpmm_decks_user_slot UNIQUE(user_id, slot_number)
);

CREATE INDEX IF NOT EXISTS idx_rpmm_decks_user ON "RPMM_decks"(user_id);

DROP TRIGGER IF EXISTS trg_rpmm_decks_updated_at ON "RPMM_decks";
CREATE TRIGGER trg_rpmm_decks_updated_at
BEFORE UPDATE ON "RPMM_decks"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 4. RPMM_cards_catalog: Canonical card definitions & Oracle mechanics
CREATE TABLE IF NOT EXISTS "RPMM_cards_catalog" (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  normalized_name TEXT UNIQUE NOT NULL,
  mana_cost TEXT,
  type_line TEXT,
  oracle_text TEXT,
  power TEXT,
  toughness TEXT,
  colors JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_uris JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_cards_catalog_norm ON "RPMM_cards_catalog"(normalized_name);

DROP TRIGGER IF EXISTS trg_rpmm_cards_catalog_updated_at ON "RPMM_cards_catalog";
CREATE TRIGGER trg_rpmm_cards_catalog_updated_at
BEFORE UPDATE ON "RPMM_cards_catalog"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 5. RPMM_card_aliases: Multilingual & Spanish translation aliases
CREATE TABLE IF NOT EXISTS "RPMM_card_aliases" (
  id TEXT PRIMARY KEY,
  alias_name TEXT UNIQUE NOT NULL,
  canonical_name TEXT NOT NULL REFERENCES "RPMM_cards_catalog"(name) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'es',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_card_aliases_alias ON "RPMM_card_aliases"(alias_name);

DROP TRIGGER IF EXISTS trg_rpmm_card_aliases_updated_at ON "RPMM_card_aliases";
CREATE TRIGGER trg_rpmm_card_aliases_updated_at
BEFORE UPDATE ON "RPMM_card_aliases"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 6. RPMM_card_bindings: Certified clause-level rule bindings ([D38])
CREATE TABLE IF NOT EXISTS "RPMM_card_bindings" (
  id TEXT PRIMARY KEY,
  card_name TEXT NOT NULL,
  clause_text TEXT NOT NULL,
  trigger TEXT NOT NULL,
  primitive TEXT NOT NULL,
  condition TEXT,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'BOUND',
  is_certified BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rpmm_card_bindings_card_clause UNIQUE(card_name, clause_text)
);

CREATE INDEX IF NOT EXISTS idx_rpmm_card_bindings_card ON "RPMM_card_bindings"(card_name);

DROP TRIGGER IF EXISTS trg_rpmm_card_bindings_updated_at ON "RPMM_card_bindings";
CREATE TRIGGER trg_rpmm_card_bindings_updated_at
BEFORE UPDATE ON "RPMM_card_bindings"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 7. RPMM_review_queue: Unbound or community-reported card clauses for auditor triage
CREATE TABLE IF NOT EXISTS "RPMM_review_queue" (
  id TEXT PRIMARY KEY,
  card_name TEXT NOT NULL,
  unbound_clause TEXT NOT NULL,
  reporter_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED', 'DISMISSED')),
  proposed_binding JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_review_queue_status ON "RPMM_review_queue"(status);

DROP TRIGGER IF EXISTS trg_rpmm_review_queue_updated_at ON "RPMM_review_queue";
CREATE TRIGGER trg_rpmm_review_queue_updated_at
BEFORE UPDATE ON "RPMM_review_queue"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 8. RPMM_live_rooms: Real-time table states & lobby metadata
CREATE TABLE IF NOT EXISTS "RPMM_live_rooms" (
  id TEXT PRIMARY KEY,
  creator_id TEXT,
  format TEXT NOT NULL DEFAULT 'MODERN',
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'ACTIVE', 'FINISHED')),
  players JSONB NOT NULL DEFAULT '[]'::jsonb,
  spectators JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_live_rooms_status ON "RPMM_live_rooms"(status);

DROP TRIGGER IF EXISTS trg_rpmm_live_rooms_updated_at ON "RPMM_live_rooms";
CREATE TRIGGER trg_rpmm_live_rooms_updated_at
BEFORE UPDATE ON "RPMM_live_rooms"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 9. RPMM_match_snapshots: Canonical state snapshots for seamless cross-device rehydration ([D10], [D27])
CREATE TABLE IF NOT EXISTS "RPMM_match_snapshots" (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  turn_number INT NOT NULL DEFAULT 1,
  phase TEXT NOT NULL DEFAULT 'PRECOMBAT_MAIN',
  active_player_id TEXT NOT NULL,
  priority_player_id TEXT NOT NULL,
  snapshot_state JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_match_snapshots_room ON "RPMM_match_snapshots"(room_id);

DROP TRIGGER IF EXISTS trg_rpmm_match_snapshots_updated_at ON "RPMM_match_snapshots";
CREATE TRIGGER trg_rpmm_match_snapshots_updated_at
BEFORE UPDATE ON "RPMM_match_snapshots"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 10. RPMM_matches: Historical match ledger & telemetry counters
CREATE TABLE IF NOT EXISTS "RPMM_matches" (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  player1_id TEXT,
  player2_id TEXT,
  winner_id TEXT,
  total_turns INT NOT NULL DEFAULT 0,
  duration_seconds INT NOT NULL DEFAULT 0,
  end_reason TEXT,
  rpm_rolls_count INT NOT NULL DEFAULT 0,
  rpbd_triggers_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_matches_room ON "RPMM_matches"(room_id);

DROP TRIGGER IF EXISTS trg_rpmm_matches_updated_at ON "RPMM_matches";
CREATE TRIGGER trg_rpmm_matches_updated_at
BEFORE UPDATE ON "RPMM_matches"
FOR EACH ROW EXECUTE FUNCTION rpmm_touch_updated_at();

-- 11. RPMM_match_logs: Write-behind audit logs, trace buffer & bug reports ([D34], [D39])
CREATE TABLE IF NOT EXISTS "RPMM_match_logs" (
  id TEXT PRIMARY KEY,
  match_id TEXT,
  room_id TEXT NOT NULL,
  user_id TEXT,
  log_type TEXT NOT NULL DEFAULT 'ACTION' CHECK (log_type IN ('ACTION', 'TRACE', 'BUG_REPORT')),
  flagged_bug BOOLEAN NOT NULL DEFAULT FALSE,
  events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rpmm_match_logs_room ON "RPMM_match_logs"(room_id);
CREATE INDEX IF NOT EXISTS idx_rpmm_match_logs_bug ON "RPMM_match_logs"(flagged_bug);

-- ============================================================================
-- Row Level Security (RLS) Policies (Idempotent: DROP IF EXISTS + CREATE)
-- ============================================================================
ALTER TABLE "RPMM_profiles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_profiles_select_all" ON "RPMM_profiles";
CREATE POLICY "RPMM_profiles_select_all" ON "RPMM_profiles" FOR SELECT USING (true);
DROP POLICY IF EXISTS "RPMM_profiles_insert_all" ON "RPMM_profiles";
CREATE POLICY "RPMM_profiles_insert_all" ON "RPMM_profiles" FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "RPMM_profiles_update_self" ON "RPMM_profiles";
CREATE POLICY "RPMM_profiles_update_self" ON "RPMM_profiles" FOR UPDATE USING (true);

ALTER TABLE "RPMM_auth_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_auth_tokens_all" ON "RPMM_auth_tokens";
CREATE POLICY "RPMM_auth_tokens_all" ON "RPMM_auth_tokens" FOR ALL USING (true);

ALTER TABLE "RPMM_decks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_decks_all" ON "RPMM_decks";
CREATE POLICY "RPMM_decks_all" ON "RPMM_decks" FOR ALL USING (true);

ALTER TABLE "RPMM_cards_catalog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_cards_catalog_select" ON "RPMM_cards_catalog";
CREATE POLICY "RPMM_cards_catalog_select" ON "RPMM_cards_catalog" FOR SELECT USING (true);
DROP POLICY IF EXISTS "RPMM_cards_catalog_insert" ON "RPMM_cards_catalog";
CREATE POLICY "RPMM_cards_catalog_insert" ON "RPMM_cards_catalog" FOR ALL USING (true);

ALTER TABLE "RPMM_card_aliases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_card_aliases_all" ON "RPMM_card_aliases";
CREATE POLICY "RPMM_card_aliases_all" ON "RPMM_card_aliases" FOR ALL USING (true);

ALTER TABLE "RPMM_card_bindings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_card_bindings_all" ON "RPMM_card_bindings";
CREATE POLICY "RPMM_card_bindings_all" ON "RPMM_card_bindings" FOR ALL USING (true);

ALTER TABLE "RPMM_review_queue" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_review_queue_all" ON "RPMM_review_queue";
CREATE POLICY "RPMM_review_queue_all" ON "RPMM_review_queue" FOR ALL USING (true);

ALTER TABLE "RPMM_live_rooms" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_live_rooms_all" ON "RPMM_live_rooms";
CREATE POLICY "RPMM_live_rooms_all" ON "RPMM_live_rooms" FOR ALL USING (true);

ALTER TABLE "RPMM_match_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_match_snapshots_all" ON "RPMM_match_snapshots";
CREATE POLICY "RPMM_match_snapshots_all" ON "RPMM_match_snapshots" FOR ALL USING (true);

ALTER TABLE "RPMM_matches" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_matches_all" ON "RPMM_matches";
CREATE POLICY "RPMM_matches_all" ON "RPMM_matches" FOR ALL USING (true);

ALTER TABLE "RPMM_match_logs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RPMM_match_logs_all" ON "RPMM_match_logs";
CREATE POLICY "RPMM_match_logs_all" ON "RPMM_match_logs" FOR ALL USING (true);
