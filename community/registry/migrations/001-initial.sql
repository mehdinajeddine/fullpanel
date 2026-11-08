CREATE TABLE fullpanel_registry.installations (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^s-[a-f0-9]{32}$' AND length(public_id) = 34),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked','suspended')),
  desired_ipv4 inet NOT NULL CHECK (family(desired_ipv4) = 4 AND masklen(desired_ipv4) = 32),
  applied_ipv4 inet CHECK (family(applied_ipv4) = 4 AND masklen(applied_ipv4) = 32),
  token_version integer NOT NULL DEFAULT 1 CHECK (token_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX installations_owner ON fullpanel_registry.installations(owner_id, created_at, id);
CREATE TABLE fullpanel_registry.tokens (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES fullpanel_registry.installations(id),
  version integer NOT NULL CHECK (version > 0),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$' AND length(token_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (installation_id, version)
);
CREATE UNIQUE INDEX tokens_one_current ON fullpanel_registry.tokens(installation_id) WHERE revoked_at IS NULL;
CREATE TABLE fullpanel_registry.operations (
  owner_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$' AND length(payload_hash) = 64),
  operation text NOT NULL CHECK (operation IN ('reserve','rotate-token','revoke')),
  installation_id uuid NOT NULL REFERENCES fullpanel_registry.installations(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, idempotency_key)
);
CREATE TABLE fullpanel_registry.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES fullpanel_registry.installations(id),
  action text NOT NULL CHECK (action IN ('reserved','token-rotated','revoked')),
  token_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION fullpanel_registry.retain_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Registry history is retained' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER installations_retain BEFORE DELETE ON fullpanel_registry.installations FOR EACH ROW EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE TRIGGER operations_immutable BEFORE UPDATE OR DELETE ON fullpanel_registry.operations FOR EACH ROW EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON fullpanel_registry.events FOR EACH ROW EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE TRIGGER tokens_retain BEFORE DELETE ON fullpanel_registry.tokens FOR EACH ROW EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE TRIGGER installations_no_truncate BEFORE TRUNCATE ON fullpanel_registry.installations FOR EACH STATEMENT EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE TRIGGER operations_no_truncate BEFORE TRUNCATE ON fullpanel_registry.operations FOR EACH STATEMENT EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON fullpanel_registry.events FOR EACH STATEMENT EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE TRIGGER tokens_no_truncate BEFORE TRUNCATE ON fullpanel_registry.tokens FOR EACH STATEMENT EXECUTE FUNCTION fullpanel_registry.retain_record();
CREATE FUNCTION fullpanel_registry.guard_installation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.public_id IS DISTINCT FROM OLD.public_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Installation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked' OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Revoked installations are retained' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER installations_guard BEFORE UPDATE ON fullpanel_registry.installations FOR EACH ROW EXECUTE FUNCTION fullpanel_registry.guard_installation();
CREATE FUNCTION fullpanel_registry.guard_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.installation_id IS DISTINCT FROM OLD.installation_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Token history is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tokens_guard BEFORE UPDATE ON fullpanel_registry.tokens FOR EACH ROW EXECUTE FUNCTION fullpanel_registry.guard_token();
