-- CreateTable
CREATE TABLE "SenderAuditLog" (
    "id" SERIAL NOT NULL,
    "senderAccountId" INTEGER NOT NULL,
    "adminDiscordId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SenderAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SenderAuditLog_senderAccountId_idx" ON "SenderAuditLog"("senderAccountId");

-- CreateIndex
CREATE INDEX "SenderAuditLog_createdAt_idx" ON "SenderAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "SenderAuditLog" ADD CONSTRAINT "SenderAuditLog_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "SenderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
