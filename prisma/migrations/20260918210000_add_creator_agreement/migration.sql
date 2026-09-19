ALTER TABLE "creators"
ADD COLUMN "agreement_accepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "agreement_signature" TEXT,
ADD COLUMN "agreement_accepted_at" TIMESTAMP(3);