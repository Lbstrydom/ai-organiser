-- Stage 4: Unique constraints
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_pass_name_variant_id_key;
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_unique;
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_pass_variant_bucket_key;
ALTER TABLE bandit_arms ADD CONSTRAINT bandit_arms_unique
  UNIQUE (pass_name, variant_id, context_bucket);
