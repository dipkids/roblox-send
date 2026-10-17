import { prisma } from "../database/prisma.js";

interface MockTransferOptions {
  simulateFailure?: boolean;
  failureMessage?: string;
}

export async function executeMockTransfer(
  transferId: number,
  options: MockTransferOptions = {},
) {
  const transfer =
    await prisma.transfer.findUnique({
      where: {
        id: transferId,
      },
      include: {
        order: true,
        senderAccount: true,
      },
    });

  if (!transfer) {
    throw new Error(
      `Transfer ${transferId} tidak ditemukan.`,
    );
  }

  if (transfer.status !== "PROCESSING") {
    throw new Error(
      `Transfer ${transferId} tidak dalam status PROCESSING.`,
    );
  }

  console.log("================================");
  console.log("MOCK ROBLOX TRANSFER");
  console.log("================================");
  console.log(
    "Order:",
    transfer.order.orderNumber,
  );
  console.log(
    "Sender:",
    transfer.senderAccount.accountName,
  );
  console.log(
    "Recipient Roblox ID:",
    transfer.recipientRobloxId,
  );
  console.log(
    "Robux:",
    transfer.robuxAmount,
  );
  console.log("================================");

  // ========================================
  // SIMULASI PROSES TRANSFER
  // ========================================

  await new Promise((resolve) =>
    setTimeout(resolve, 2000),
  );

  // ========================================
  // SIMULASI TRANSFER GAGAL
  // ========================================

  if (options.simulateFailure) {
    const failureMessage =
      options.failureMessage ??
      "Simulasi transfer gagal.";

    const errorCode =
      process.env.MOCK_TRANSFER_FAIL_CODE ?? "MOCK_TRANSFER_FAILED";

    console.log(
      "❌ MOCK TRANSFER GAGAL.",
    );

    console.log(
      "Error:",
      failureMessage,
    );

    const failedTransfer =
      await prisma.$transaction(
        async (tx) => {
          const updatedTransfer =
            await tx.transfer.update({
              where: {
                id: transfer.id,
              },
              data: {
                status: "FAILED",
                errorCode,
                errorMessage:
                  failureMessage,
              },
            });

          await tx.order.update({
            where: {
              id: transfer.orderId,
            },
            data: {
              status:
                "TRANSFER_FAILED",
            },
          });

          await tx.orderEvent.create({
            data: {
              orderId:
                transfer.orderId,

              eventType:
                "TRANSFER_FAILED",

              oldStatus:
                "PROCESSING",

              newStatus:
                "TRANSFER_FAILED",

              description:
                "Mock transfer gagal.",

              metadata: {
                transferId:
                  transfer.id,

                senderAccountId:
                  transfer.senderAccountId,

                robuxAmount:
                  transfer.robuxAmount,

                errorCode,

                errorMessage:
                  failureMessage,
              },
            },
          });

          return updatedTransfer;
        },
        {
          maxWait: 30000,
          timeout: 30000,
        },
      );

    return failedTransfer;
  }

  // ========================================
  // TRANSFER BERHASIL
  // ========================================

  const externalTransferId =
    `MOCK-${Date.now()}-${transfer.id}`;

  const result = await prisma.$transaction(
    async (tx) => {
      const updatedTransfer =
        await tx.transfer.update({
          where: {
            id: transfer.id,
          },
          data: {
            status: "SUCCESS",
            externalTransferId,
            completedAt: new Date(),
          },
        });

      await tx.order.update({
        where: {
          id: transfer.orderId,
        },
        data: {
          status: "VERIFYING",
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId:
            transfer.orderId,

          eventType:
            "TRANSFER_SUCCESS",

          oldStatus:
            "PROCESSING",

          newStatus:
            "VERIFYING",

          description:
            "Mock transfer berhasil. Order masuk tahap verifikasi.",

          metadata: {
            transferId:
              transfer.id,

            externalTransferId,

            robuxAmount:
              transfer.robuxAmount,
          },
        },
      });

      return updatedTransfer;
    },
    {
      maxWait: 30000,
      timeout: 30000,
    },
  );

  console.log(
    "✅ Mock transfer berhasil.",
  );

  console.log(
    "External Transfer ID:",
    externalTransferId,
  );

  return result;
}