-- DropForeignKey
ALTER TABLE "creators" DROP CONSTRAINT "creators_profile_id_fkey";

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
