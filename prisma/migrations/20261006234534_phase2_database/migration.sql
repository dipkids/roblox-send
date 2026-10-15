/*
  Warnings:

  - The `status` column on the `Order` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `productPrice` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `robloxProfileId` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'WAITING_PROFILE_CONFIRMATION', 'WAITING_PAYMENT', 'PAYMENT_PENDING', 'PAID', 'CHECKING_SENDER', 'READY_TO_SEND', 'PROCESSING', 'VERIFYING', 'COMPLETED', 'PAYMENT_TIMEOUT', 'PAYMENT_FAILED', 'SENDER_LIMIT_ERROR', 'TRANSFER_FAILED', 'MANUAL_REVIEW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SenderStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LIMIT_REACHED', 'ERROR', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'CLOSED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "productPrice" INTEGER NOT NULL,
ADD COLUMN     "robloxProfileId" INTEGER NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "OrderStatus" NOT NULL DEFAULT 'CREATED';

-- CreateTable
CREATE TABLE "RobloxProfile" (
    "id" SERIAL NOT NULL,
    "robloxUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "lastChecked" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RobloxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MIDTRANS',
    "midtransOrderId" TEXT NOT NULL,
    "transactionId" TEXT,
    "grossAmount" INTEGER NOT NULL,
    "paymentMethod" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "rawNotification" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SenderAccount" (
    "id" SERIAL NOT NULL,
    "accountName" TEXT NOT NULL,
    "robloxUserId" TEXT NOT NULL,
    "status" "SenderStatus" NOT NULL DEFAULT 'ACTIVE',
    "dailyLimit" INTEGER NOT NULL DEFAULT 500,
    "monthlyLimit" INTEGER NOT NULL DEFAULT 1000,
    "dailyUsed" INTEGER NOT NULL DEFAULT 0,
    "monthlyUsed" INTEGER NOT NULL DEFAULT 0,
    "dailyResetAt" TIMESTAMP(3),
    "monthlyResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "senderAccountId" INTEGER NOT NULL,
    "recipientRobloxId" TEXT NOT NULL,
    "robuxAmount" INTEGER NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "externalTransferId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "supportRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "oldStatus" TEXT,
    "newStatus" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAction" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "adminDiscordId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldStatus" TEXT,
    "newStatus" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RobloxProfile_robloxUserId_key" ON "RobloxProfile"("robloxUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_midtransOrderId_key" ON "Payment"("midtransOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_transactionId_key" ON "Payment"("transactionId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SenderAccount_robloxUserId_key" ON "SenderAccount"("robloxUserId");

-- CreateIndex
CREATE INDEX "SenderAccount_status_idx" ON "SenderAccount"("status");

-- CreateIndex
CREATE INDEX "Transfer_orderId_idx" ON "Transfer"("orderId");

-- CreateIndex
CREATE INDEX "Transfer_senderAccountId_idx" ON "Transfer"("senderAccountId");

-- CreateIndex
CREATE INDEX "Transfer_status_idx" ON "Transfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_orderId_key" ON "Ticket"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_channelId_key" ON "Ticket"("channelId");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");

-- CreateIndex
CREATE INDEX "OrderEvent_eventType_idx" ON "OrderEvent"("eventType");

-- CreateIndex
CREATE INDEX "OrderEvent_createdAt_idx" ON "OrderEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAction_orderId_idx" ON "AdminAction"("orderId");

-- CreateIndex
CREATE INDEX "AdminAction_adminDiscordId_idx" ON "AdminAction"("adminDiscordId");

-- CreateIndex
CREATE INDEX "AdminAction_createdAt_idx" ON "AdminAction"("createdAt");

-- CreateIndex
CREATE INDEX "Order_userId_idx" ON "Order"("userId");

-- CreateIndex
CREATE INDEX "Order_robloxProfileId_idx" ON "Order"("robloxProfileId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_robloxProfileId_fkey" FOREIGN KEY ("robloxProfileId") REFERENCES "RobloxProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "SenderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAction" ADD CONSTRAINT "AdminAction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
