-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'admin', 'superadmin', 'creator', 'member', 'staff');

-- CreateEnum
CREATE TYPE "SuperAdminSettingSection" AS ENUM ('revenue', 'company_info');

-- CreateEnum
CREATE TYPE "CreatorEventStatus" AS ENUM ('draft', 'scheduled', 'live', 'paused', 'ended', 'cancelled');

-- CreateEnum
CREATE TYPE "CreatorEventLocationType" AS ENUM ('country', 'state', 'city', 'address');

-- CreateEnum
CREATE TYPE "CreatorEventLocationRestrictionMode" AS ENUM ('block', 'allow');

-- CreateEnum
CREATE TYPE "CreatorEventTicketAccessType" AS ENUM ('stream', 'venue');

-- CreateEnum
CREATE TYPE "CreatorEventTicketStatus" AS ENUM ('active', 'paused', 'sold_out', 'archived');

-- CreateEnum
CREATE TYPE "CreatorEventTicketPurchaseStatus" AS ENUM ('pending', 'completed', 'cancelled', 'refunded', 'failed');

-- CreateEnum
CREATE TYPE "CreatorEventCheckInUserStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "CreatorEventCheckInScanStatus" AS ENUM ('success', 'duplicate', 'invalid', 'rejected');

-- CreateEnum
CREATE TYPE "CreatorEventRecordingStatus" AS ENUM ('disabled', 'pending', 'recording', 'processing', 'ready', 'failed');

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "full_name" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "avatar_url" TEXT,
    "creator_name" TEXT,
    "bio" TEXT,
    "website" TEXT,
    "location" TEXT,
    "social_handles" JSONB,
    "profile_visibility" TEXT NOT NULL DEFAULT 'public',
    "show_email" BOOLEAN NOT NULL DEFAULT false,
    "show_location" BOOLEAN NOT NULL DEFAULT true,
    "allow_messages" BOOLEAN NOT NULL DEFAULT true,
    "show_online_status" BOOLEAN NOT NULL DEFAULT true,
    "address_full" TEXT,
    "address_lat" DOUBLE PRECISION,
    "address_lon" DOUBLE PRECISION,
    "address_type" TEXT,
    "address_country" TEXT,
    "address_state" TEXT,
    "address_name" TEXT,
    "age" INTEGER,
    "sex" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "has_password" BOOLEAN NOT NULL DEFAULT false,
    "last_login" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "superadmin_settings" (
    "id" TEXT NOT NULL,
    "section" "SuperAdminSettingSection" NOT NULL,
    "platform_fee_percentage" INTEGER,
    "enterprise_fee_percentage" INTEGER,
    "minimum_payout_amount" INTEGER,
    "payout_processing_days" INTEGER,
    "company_name" TEXT,
    "company_email" TEXT,
    "support_email" TEXT,
    "company_phone" TEXT,
    "company_address" TEXT,
    "company_website" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "superadmin_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_requests" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "contact_person" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "website" TEXT,
    "company_size" TEXT,
    "industry" TEXT,
    "address" TEXT,
    "description" TEXT,
    "requirements" TEXT,
    "estimated_users" INTEGER,
    "budget" TEXT,
    "timeline" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_credentials" (
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_credentials_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creators" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "video_payout_percents" INTEGER NOT NULL DEFAULT 70,
    "event_stream_payout_percents" INTEGER NOT NULL DEFAULT 70,
    "event_venue_payout_percents" INTEGER NOT NULL DEFAULT 70,
    "followers_count" INTEGER NOT NULL DEFAULT 0,
    "following_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communities" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "banner_url" TEXT,
    "icon_url" TEXT,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "members_count" INTEGER NOT NULL DEFAULT 0,
    "posts_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_members" (
    "id" TEXT NOT NULL,
    "community_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_posts" (
    "id" TEXT NOT NULL,
    "community_id" TEXT NOT NULL,
    "author_profile_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "image_url" TEXT,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_follows" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "follower_profile_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_payout_accounts" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_payout_requests" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "payout_account_id" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "receipt_url" TEXT,
    "transaction_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_video_folders" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "folder_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "thumbnail_url" TEXT,
    "thumbnail_file_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_video_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_videos" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "video_url" TEXT,
    "video_file_id" TEXT,
    "thumbnail_url" TEXT,
    "thumbnail_file_id" TEXT,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "is_premium" BOOLEAN NOT NULL DEFAULT false,
    "monetization_type" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'published',
    "publish_now" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_at" TIMESTAMP(3),
    "rent24_price" INTEGER,
    "rent48_price" INTEGER,
    "purchase_price" INTEGER,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "revenue_share" INTEGER NOT NULL DEFAULT 0,
    "platform_fee" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "package_name" TEXT,
    "episode_index" INTEGER,
    "duration" TEXT,
    "allow_comments" BOOLEAN NOT NULL DEFAULT true,
    "age_restriction" BOOLEAN NOT NULL DEFAULT false,
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_video_purchases" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "creator_video_id" TEXT NOT NULL,
    "buyer_profile_id" TEXT,
    "buyer_name" TEXT,
    "buyer_email" TEXT,
    "buyer_phone" TEXT,
    "purchase_type" TEXT NOT NULL,
    "access_code" TEXT,
    "revenue_made" INTEGER NOT NULL DEFAULT 0,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "platform_fee" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "transaction_id" TEXT NOT NULL,
    "access_expires_at" TIMESTAMP(3),
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "creator_video_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_video_views" (
    "id" TEXT NOT NULL,
    "creator_video_id" TEXT NOT NULL,
    "viewer_profile_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_video_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "reactions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_video_likes" (
    "id" TEXT NOT NULL,
    "creator_video_id" TEXT NOT NULL,
    "liker_profile_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_video_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_likes" (
    "id" TEXT NOT NULL,
    "creator_event_id" TEXT NOT NULL,
    "liker_profile_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_event_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_video_comments" (
    "id" TEXT NOT NULL,
    "creator_video_id" TEXT NOT NULL,
    "commenter_profile_id" TEXT,
    "commenter_email" TEXT,
    "parent_comment_id" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_video_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_events" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'music',
    "status" "CreatorEventStatus" NOT NULL DEFAULT 'scheduled',
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "require_ticket" BOOLEAN NOT NULL DEFAULT false,
    "enable_donations" BOOLEAN NOT NULL DEFAULT false,
    "enable_location_restriction" BOOLEAN NOT NULL DEFAULT false,
    "location_restriction_type" "CreatorEventLocationRestrictionMode" NOT NULL DEFAULT 'block',
    "address" TEXT,
    "location_name" TEXT,
    "location_country" TEXT,
    "location_state" TEXT,
    "location_type" "CreatorEventLocationType",
    "location_lat" DOUBLE PRECISION,
    "location_lon" DOUBLE PRECISION,
    "location_full_address" TEXT,
    "thumbnail_url" TEXT,
    "thumbnail_file_id" TEXT,
    "thumbnail_video_url" TEXT,
    "thumbnail_video_file_id" TEXT,
    "recorded_video_url" TEXT,
    "recorded_video_file_id" TEXT,
    "stream_key" TEXT,
    "rtmp_url" TEXT,
    "ingress_id" TEXT,
    "livekit_room_name" TEXT,
    "recording_enabled" BOOLEAN NOT NULL DEFAULT false,
    "recording_status" "CreatorEventRecordingStatus" NOT NULL DEFAULT 'disabled',
    "recording_asset_id" TEXT,
    "recording_started_at" TIMESTAMP(3),
    "recording_ended_at" TIMESTAMP(3),
    "has_recorded_video" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "max_viewers" INTEGER,
    "estimated_users" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "peak_viewers_count" INTEGER NOT NULL DEFAULT 0,
    "current_viewers_count" INTEGER NOT NULL DEFAULT 0,
    "venue_participant_count" INTEGER NOT NULL DEFAULT 0,
    "revenue_made" INTEGER NOT NULL DEFAULT 0,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "platform_fee" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_location_restrictions" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "state" TEXT,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "location_type" "CreatorEventLocationType" NOT NULL,
    "full_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_event_location_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_tickets" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "ticket_type" TEXT NOT NULL,
    "access" "CreatorEventTicketAccessType" NOT NULL DEFAULT 'stream',
    "price" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "sold_count" INTEGER NOT NULL DEFAULT 0,
    "revenue_made" INTEGER NOT NULL DEFAULT 0,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "platform_fee" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "CreatorEventTicketStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_event_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_ticket_purchases" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "buyer_name" TEXT NOT NULL,
    "buyer_email" TEXT NOT NULL,
    "buyer_phone" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "revenue_made" INTEGER NOT NULL DEFAULT 0,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "platform_fee" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "CreatorEventTicketPurchaseStatus" NOT NULL DEFAULT 'completed',
    "transaction_id" TEXT NOT NULL,
    "ticket_code" TEXT NOT NULL,
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refunded_at" TIMESTAMP(3),
    "checked_in_at" TIMESTAMP(3),
    "checked_in_by_user_id" TEXT,

    CONSTRAINT "creator_event_ticket_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_ticket_items" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "ticket_code" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "checked_in_at" TIMESTAMP(3),
    "checked_in_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_event_ticket_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_check_in_users" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "temp_password_hash" TEXT,
    "gate_name" TEXT NOT NULL,
    "status" "CreatorEventCheckInUserStatus" NOT NULL DEFAULT 'active',
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "scans_today" INTEGER NOT NULL DEFAULT 0,
    "total_scans" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMP(3),
    "last_scan_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_event_check_in_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_check_in_camera_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "operator_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "opened_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "client_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_event_check_in_camera_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_check_in_camera_signals" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_event_check_in_camera_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_check_in_camera_audits" (
    "id" TEXT NOT NULL,
    "session_id" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "message" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_event_check_in_camera_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_event_check_in_scans" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "check_in_user_id" TEXT,
    "ticket_purchase_id" TEXT,
    "attendee_name" TEXT,
    "attendee_email" TEXT,
    "gate_name" TEXT,
    "scanned_code" TEXT,
    "status" "CreatorEventCheckInScanStatus" NOT NULL DEFAULT 'success',
    "notes" TEXT,
    "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_event_check_in_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_email_key" ON "profiles"("email");

-- CreateIndex
CREATE UNIQUE INDEX "superadmin_settings_section_key" ON "superadmin_settings"("section");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "creators_profile_id_key" ON "creators"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "communities_creator_id_key" ON "communities"("creator_id");

-- CreateIndex
CREATE INDEX "community_members_community_id_idx" ON "community_members"("community_id");

-- CreateIndex
CREATE INDEX "community_members_profile_id_idx" ON "community_members"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_members_community_id_profile_id_key" ON "community_members"("community_id", "profile_id");

-- CreateIndex
CREATE INDEX "community_posts_community_id_idx" ON "community_posts"("community_id");

-- CreateIndex
CREATE INDEX "creator_follows_creator_id_idx" ON "creator_follows"("creator_id");

-- CreateIndex
CREATE INDEX "creator_follows_follower_profile_id_idx" ON "creator_follows"("follower_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_follows_follower_profile_id_creator_id_key" ON "creator_follows"("follower_profile_id", "creator_id");

-- CreateIndex
CREATE INDEX "creator_payout_accounts_creator_id_idx" ON "creator_payout_accounts"("creator_id");

-- CreateIndex
CREATE INDEX "creator_payout_accounts_bank_name_idx" ON "creator_payout_accounts"("bank_name");

-- CreateIndex
CREATE INDEX "creator_payout_requests_creator_id_idx" ON "creator_payout_requests"("creator_id");

-- CreateIndex
CREATE INDEX "creator_payout_requests_status_idx" ON "creator_payout_requests"("status");

-- CreateIndex
CREATE INDEX "creator_video_folders_creator_id_idx" ON "creator_video_folders"("creator_id");

-- CreateIndex
CREATE INDEX "creator_videos_creator_id_idx" ON "creator_videos"("creator_id");

-- CreateIndex
CREATE INDEX "creator_videos_folder_id_idx" ON "creator_videos"("folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_video_purchases_access_code_key" ON "creator_video_purchases"("access_code");

-- CreateIndex
CREATE UNIQUE INDEX "creator_video_purchases_transaction_id_key" ON "creator_video_purchases"("transaction_id");

-- CreateIndex
CREATE INDEX "creator_video_purchases_creator_id_idx" ON "creator_video_purchases"("creator_id");

-- CreateIndex
CREATE INDEX "creator_video_purchases_creator_video_id_idx" ON "creator_video_purchases"("creator_video_id");

-- CreateIndex
CREATE INDEX "creator_video_purchases_buyer_profile_id_idx" ON "creator_video_purchases"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "creator_video_purchases_buyer_email_idx" ON "creator_video_purchases"("buyer_email");

-- CreateIndex
CREATE INDEX "creator_video_purchases_status_idx" ON "creator_video_purchases"("status");

-- CreateIndex
CREATE INDEX "creator_video_views_creator_video_id_idx" ON "creator_video_views"("creator_video_id");

-- CreateIndex
CREATE INDEX "chat_messages_kind_channel_id_idx" ON "chat_messages"("kind", "channel_id");

-- CreateIndex
CREATE INDEX "creator_video_likes_creator_video_id_idx" ON "creator_video_likes"("creator_video_id");

-- CreateIndex
CREATE INDEX "creator_video_likes_liker_profile_id_idx" ON "creator_video_likes"("liker_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_video_likes_creator_video_id_liker_profile_id_key" ON "creator_video_likes"("creator_video_id", "liker_profile_id");

-- CreateIndex
CREATE INDEX "creator_event_likes_creator_event_id_idx" ON "creator_event_likes"("creator_event_id");

-- CreateIndex
CREATE INDEX "creator_event_likes_liker_profile_id_idx" ON "creator_event_likes"("liker_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_likes_creator_event_id_liker_profile_id_key" ON "creator_event_likes"("creator_event_id", "liker_profile_id");

-- CreateIndex
CREATE INDEX "creator_video_comments_creator_video_id_parent_comment_id_idx" ON "creator_video_comments"("creator_video_id", "parent_comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_events_stream_key_key" ON "creator_events"("stream_key");

-- CreateIndex
CREATE UNIQUE INDEX "creator_events_ingress_id_key" ON "creator_events"("ingress_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_events_livekit_room_name_key" ON "creator_events"("livekit_room_name");

-- CreateIndex
CREATE UNIQUE INDEX "creator_events_recording_asset_id_key" ON "creator_events"("recording_asset_id");

-- CreateIndex
CREATE INDEX "creator_events_creator_id_idx" ON "creator_events"("creator_id");

-- CreateIndex
CREATE INDEX "creator_events_status_idx" ON "creator_events"("status");

-- CreateIndex
CREATE INDEX "creator_events_scheduled_at_idx" ON "creator_events"("scheduled_at");

-- CreateIndex
CREATE INDEX "creator_event_location_restrictions_event_id_idx" ON "creator_event_location_restrictions"("event_id");

-- CreateIndex
CREATE INDEX "creator_event_tickets_event_id_idx" ON "creator_event_tickets"("event_id");

-- CreateIndex
CREATE INDEX "creator_event_tickets_status_idx" ON "creator_event_tickets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_tickets_event_id_ticket_type_key" ON "creator_event_tickets"("event_id", "ticket_type");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_ticket_purchases_transaction_id_key" ON "creator_event_ticket_purchases"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_ticket_purchases_ticket_code_key" ON "creator_event_ticket_purchases"("ticket_code");

-- CreateIndex
CREATE INDEX "creator_event_ticket_purchases_ticket_id_idx" ON "creator_event_ticket_purchases"("ticket_id");

-- CreateIndex
CREATE INDEX "creator_event_ticket_purchases_buyer_email_idx" ON "creator_event_ticket_purchases"("buyer_email");

-- CreateIndex
CREATE INDEX "creator_event_ticket_purchases_status_idx" ON "creator_event_ticket_purchases"("status");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_ticket_items_ticket_code_key" ON "creator_event_ticket_items"("ticket_code");

-- CreateIndex
CREATE INDEX "creator_event_ticket_items_purchase_id_idx" ON "creator_event_ticket_items"("purchase_id");

-- CreateIndex
CREATE INDEX "creator_event_ticket_items_ticket_id_idx" ON "creator_event_ticket_items"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_check_in_users_email_key" ON "creator_event_check_in_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_check_in_users_username_key" ON "creator_event_check_in_users"("username");

-- CreateIndex
CREATE INDEX "creator_event_check_in_users_creator_id_idx" ON "creator_event_check_in_users"("creator_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_users_event_id_idx" ON "creator_event_check_in_users"("event_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_users_status_idx" ON "creator_event_check_in_users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "creator_event_check_in_camera_sessions_token_hash_key" ON "creator_event_check_in_camera_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_sessions_event_id_idx" ON "creator_event_check_in_camera_sessions"("event_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_sessions_operator_user_id_idx" ON "creator_event_check_in_camera_sessions"("operator_user_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_sessions_status_idx" ON "creator_event_check_in_camera_sessions"("status");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_sessions_expires_at_idx" ON "creator_event_check_in_camera_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_signals_session_id_idx" ON "creator_event_check_in_camera_signals"("session_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_signals_created_at_idx" ON "creator_event_check_in_camera_signals"("created_at");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_audits_session_id_idx" ON "creator_event_check_in_camera_audits"("session_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_audits_actor_idx" ON "creator_event_check_in_camera_audits"("actor");

-- CreateIndex
CREATE INDEX "creator_event_check_in_camera_audits_action_idx" ON "creator_event_check_in_camera_audits"("action");

-- CreateIndex
CREATE INDEX "creator_event_check_in_scans_event_id_idx" ON "creator_event_check_in_scans"("event_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_scans_check_in_user_id_idx" ON "creator_event_check_in_scans"("check_in_user_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_scans_ticket_purchase_id_idx" ON "creator_event_check_in_scans"("ticket_purchase_id");

-- CreateIndex
CREATE INDEX "creator_event_check_in_scans_status_idx" ON "creator_event_check_in_scans"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- AddForeignKey
ALTER TABLE "auth_credentials" ADD CONSTRAINT "auth_credentials_email_fkey" FOREIGN KEY ("email") REFERENCES "profiles"("email") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("email") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communities" ADD CONSTRAINT "communities_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_profile_id_fkey" FOREIGN KEY ("author_profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_follows" ADD CONSTRAINT "creator_follows_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_follows" ADD CONSTRAINT "creator_follows_follower_profile_id_fkey" FOREIGN KEY ("follower_profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_payout_accounts" ADD CONSTRAINT "creator_payout_accounts_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_payout_requests" ADD CONSTRAINT "creator_payout_requests_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_payout_requests" ADD CONSTRAINT "creator_payout_requests_payout_account_id_fkey" FOREIGN KEY ("payout_account_id") REFERENCES "creator_payout_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_folders" ADD CONSTRAINT "creator_video_folders_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_videos" ADD CONSTRAINT "creator_videos_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_videos" ADD CONSTRAINT "creator_videos_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "creator_video_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_purchases" ADD CONSTRAINT "creator_video_purchases_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_purchases" ADD CONSTRAINT "creator_video_purchases_creator_video_id_fkey" FOREIGN KEY ("creator_video_id") REFERENCES "creator_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_purchases" ADD CONSTRAINT "creator_video_purchases_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_views" ADD CONSTRAINT "creator_video_views_creator_video_id_fkey" FOREIGN KEY ("creator_video_id") REFERENCES "creator_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_likes" ADD CONSTRAINT "creator_video_likes_creator_video_id_fkey" FOREIGN KEY ("creator_video_id") REFERENCES "creator_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_likes" ADD CONSTRAINT "creator_video_likes_liker_profile_id_fkey" FOREIGN KEY ("liker_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_likes" ADD CONSTRAINT "creator_event_likes_creator_event_id_fkey" FOREIGN KEY ("creator_event_id") REFERENCES "creator_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_likes" ADD CONSTRAINT "creator_event_likes_liker_profile_id_fkey" FOREIGN KEY ("liker_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_comments" ADD CONSTRAINT "creator_video_comments_creator_video_id_fkey" FOREIGN KEY ("creator_video_id") REFERENCES "creator_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_comments" ADD CONSTRAINT "creator_video_comments_commenter_profile_id_fkey" FOREIGN KEY ("commenter_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_video_comments" ADD CONSTRAINT "creator_video_comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "creator_video_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_events" ADD CONSTRAINT "creator_events_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_location_restrictions" ADD CONSTRAINT "creator_event_location_restrictions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "creator_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_tickets" ADD CONSTRAINT "creator_event_tickets_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "creator_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_ticket_purchases" ADD CONSTRAINT "creator_event_ticket_purchases_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "creator_event_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_ticket_purchases" ADD CONSTRAINT "creator_event_ticket_purchases_checked_in_by_user_id_fkey" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "creator_event_check_in_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_ticket_items" ADD CONSTRAINT "creator_event_ticket_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "creator_event_ticket_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_ticket_items" ADD CONSTRAINT "creator_event_ticket_items_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "creator_event_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_ticket_items" ADD CONSTRAINT "creator_event_ticket_items_checked_in_by_user_id_fkey" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "creator_event_check_in_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_users" ADD CONSTRAINT "creator_event_check_in_users_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_users" ADD CONSTRAINT "creator_event_check_in_users_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "creator_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_camera_sessions" ADD CONSTRAINT "creator_event_check_in_camera_sessions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "creator_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_camera_sessions" ADD CONSTRAINT "creator_event_check_in_camera_sessions_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "creator_event_check_in_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_camera_signals" ADD CONSTRAINT "creator_event_check_in_camera_signals_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "creator_event_check_in_camera_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_camera_audits" ADD CONSTRAINT "creator_event_check_in_camera_audits_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "creator_event_check_in_camera_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_scans" ADD CONSTRAINT "creator_event_check_in_scans_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "creator_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_scans" ADD CONSTRAINT "creator_event_check_in_scans_check_in_user_id_fkey" FOREIGN KEY ("check_in_user_id") REFERENCES "creator_event_check_in_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_event_check_in_scans" ADD CONSTRAINT "creator_event_check_in_scans_ticket_purchase_id_fkey" FOREIGN KEY ("ticket_purchase_id") REFERENCES "creator_event_ticket_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
