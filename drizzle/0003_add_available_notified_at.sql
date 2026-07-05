ALTER TABLE `requests` ADD `available_notified_at` integer;--> statement-breakpoint
-- Backfill: rows already `available` before this migration had their at-most-once send under the
-- old synchronous emit path (or predate the notify_on opt-in, so owe nothing). Settle their marker
-- so the new poller sweep treats them as done and does not re-email them on the first tick after
-- upgrade. Only rows that reach `available` AFTER this migration start with a null (owed) marker.
UPDATE `requests` SET `available_notified_at` = (unixepoch()) WHERE `status` = 'available';