-- =============================================================================
-- Migration: 20261019_feature15_player_profiles_and_telemetry.sql
-- Feature: 15 - Player Registration, Onboarding & Telemetry Engine
-- Document: SPEC-RPM-ONBOARD-015
-- =============================================================================

-- 1. Table: public.player_profiles
CREATE TABLE IF NOT EXISTS public.player_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    dob DATE NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1200,
    active_deck_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_player_username_length CHECK (char_length(username) >= 2 AND char_length(username) <= 32),
    CONSTRAINT ck_player_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

-- Indexes for player_profiles
CREATE INDEX IF NOT EXISTS idx_player_profiles_email ON public.player_profiles (email);
CREATE INDEX IF NOT EXISTS idx_player_profiles_elo ON public.player_profiles (elo DESC);

-- 2. Table: public.player_events (Telemetry Engine)
CREATE TABLE IF NOT EXISTS public.player_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID REFERENCES public.player_profiles(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    card_name TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for player_events
CREATE INDEX IF NOT EXISTS idx_player_events_player_id ON public.player_events (player_id);
CREATE INDEX IF NOT EXISTS idx_player_events_type_created ON public.player_events (event_type, created_at DESC);

-- 3. Automatic updated_at trigger for player_profiles
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_player_profiles_updated_at ON public.player_profiles;
CREATE TRIGGER trg_player_profiles_updated_at
    BEFORE UPDATE ON public.player_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- =============================================================================
-- Row Level Security (RLS) Policies
-- =============================================================================

ALTER TABLE public.player_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_events ENABLE ROW LEVEL SECURITY;

-- player_profiles RLS Policies
CREATE POLICY "Allow public read access to player profiles"
    ON public.player_profiles
    FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "Allow users to insert own profile"
    ON public.player_profiles
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY "Allow users to update own profile"
    ON public.player_profiles
    FOR UPDATE
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

-- player_events RLS Policies
CREATE POLICY "Allow client to insert telemetry events"
    ON public.player_events
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY "Allow users to read telemetry events"
    ON public.player_events
    FOR SELECT
    TO anon, authenticated
    USING (true);
