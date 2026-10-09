-- 畫面必須擬真：Claude 不再出圖、不能被投票。已投給它的票改為「不投票」（錢照樣施工，只是不參與決定）
UPDATE "donations" SET "vote" = NULL WHERE "vote" = 'anthropic';--> statement-breakpoint
ALTER TABLE "donations" DROP CONSTRAINT "donations_vote_known";--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_vote_known" CHECK ("donations"."vote" IS NULL OR "donations"."vote" IN ('google','openai'));