-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "avatar" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_profile_id_created_at_idx" ON "notifications"("profile_id", "created_at");
CREATE INDEX "support_messages_profile_id_created_at_idx" ON "support_messages"("profile_id", "created_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
