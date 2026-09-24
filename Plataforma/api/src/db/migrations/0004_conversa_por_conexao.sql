DROP INDEX `idx_conv_aberta_por_lead`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_conv_aberta_por_lead` ON `conversations` (`tenant_id`,`lead_id`,coalesce(`channel_instance_id`, '')) WHERE "conversations"."status" != 'finalizada' AND "conversations"."deleted_at" IS NULL;
