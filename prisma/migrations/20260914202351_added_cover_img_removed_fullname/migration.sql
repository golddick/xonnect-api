/*
  Warnings:

  - You are about to drop the column `first_name` on the `profiles` table. All the data in the column will be lost.
  - You are about to drop the column `last_name` on the `profiles` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "profiles" DROP COLUMN "first_name",
DROP COLUMN "last_name",
ADD COLUMN     "cover_img_url" TEXT;
